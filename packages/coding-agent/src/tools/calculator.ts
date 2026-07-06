import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import calculatorDescription from "../prompts/tools/calculator.md" with { type: "text" };
import { Ellipsis, Hasher, type RenderCache, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { formatCount, formatEmptyMessage, formatErrorMessage, PREVIEW_LIMITS, TRUNCATE_LENGTHS } from "./render-utils";

// Arithmetic operators (** is exponentiation). Token variants for the lexer.
type Operator = "+" | "-" | "*" | "/" | "%" | "**";
type Token =
	| { type: "number"; value: number }
	| { type: "operator"; value: Operator }
	| { type: "paren"; value: "(" | ")" };

const calculatorSchema = Type.Object({
	calculations: Type.Array(
		Type.Object({
			expression: Type.String({ description: "math expression", examples: ["2 + 2", "sqrt(16)"] }),
			prefix: Type.String({ description: "prefix text" }),
			suffix: Type.String({ description: "suffix text" }),
		}),
		{ description: "calculations to evaluate" },
	),
});

export interface CalculatorToolDetails {
	results: Array<{ expression: string; value: number; output: string }>;
}

// =============================================================================
// Tokenizer
// =============================================================================

/**
 * Split an expression into number literals, operators, and parentheses.
 * Numeric literals (decimal, hex `0x`, binary `0b`, octal `0o`, scientific)
 * are matched greedily and converted with the platform `Number()` parser.
 */
function tokenize(expression: string): Token[] {
	const tokens: Token[] = [];
	// Number, then `**`, then a single-char operator or paren.
	const pattern =
		/\s+|(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|(\*\*|[-+*/%()])/g;
	let cursor = 0;
	for (let m = pattern.exec(expression); m; m = pattern.exec(expression)) {
		if (m.index !== cursor) throw new Error(`Invalid character "${expression[cursor]}" in expression`);
		cursor = pattern.lastIndex;
		const [, num, op] = m;
		if (num !== undefined) {
			const value = Number(num);
			if (!Number.isFinite(value)) throw new Error(`Invalid number "${num}"`);
			tokens.push({ type: "number", value });
		} else if (op === "(" || op === ")") {
			tokens.push({ type: "paren", value: op });
		} else if (op !== undefined) {
			tokens.push({ type: "operator", value: op as Operator });
		}
	}
	if (cursor !== expression.length) throw new Error(`Invalid character "${expression[cursor]}" in expression`);
	return tokens;
}

// =============================================================================
// Evaluator (shunting-yard to RPN, then fold)
// =============================================================================

// Binary operator precedence and associativity. `**` is right-associative and
// binds tighter than unary minus, matching JS (`-2 ** 2 === -4`).
const BINARY: Record<Operator, { prec: number; right: boolean }> = {
	"+": { prec: 1, right: false },
	"-": { prec: 1, right: false },
	"*": { prec: 2, right: false },
	"/": { prec: 2, right: false },
	"%": { prec: 2, right: false },
	"**": { prec: 4, right: true },
};
const UNARY_PREC = 3;

function apply(op: Operator | "u-", stack: number[]): void {
	if (op === "u-") {
		const a = stack.pop();
		if (a === undefined) throw new Error("Unexpected end of expression");
		stack.push(-a);
		return;
	}
	const b = stack.pop();
	const a = stack.pop();
	if (a === undefined || b === undefined) throw new Error("Unexpected end of expression");
	switch (op) {
		case "+":
			stack.push(a + b);
			break;
		case "-":
			stack.push(a - b);
			break;
		case "*":
			stack.push(a * b);
			break;
		case "/":
			stack.push(a / b);
			break;
		case "%":
			stack.push(a % b);
			break;
		case "**":
			stack.push(a ** b);
			break;
	}
}

function evaluateExpression(expression: string): number {
	const tokens = tokenize(expression);
	if (tokens.length === 0) throw new Error("Expression is empty");

	const values: number[] = [];
	const ops: Array<Operator | "u-" | "("> = [];
	let expectOperand = true; // start, after "(", or after an operator

	const popWhile = (test: (top: Operator | "u-") => boolean) => {
		while (ops.length) {
			const top = ops[ops.length - 1];
			if (top === "(" || !test(top)) break;
			apply(ops.pop() as Operator | "u-", values);
		}
	};

	for (const token of tokens) {
		if (token.type === "number") {
			if (!expectOperand) throw new Error("Unexpected number in expression");
			values.push(token.value);
			expectOperand = false;
			continue;
		}
		if (token.type === "paren") {
			if (token.value === "(") {
				ops.push("(");
				expectOperand = true;
			} else {
				popWhile(() => true);
				if (ops.pop() !== "(") throw new Error("Missing opening parenthesis");
				expectOperand = false;
			}
			continue;
		}
		// operator
		if (expectOperand) {
			// Unary context: + is a no-op, - pushes a unary-minus operator.
			if (token.value === "-") ops.push("u-");
			else if (token.value !== "+") throw new Error(`Unexpected operator "${token.value}"`);
			continue;
		}
		const { prec, right } = BINARY[token.value];
		popWhile(
			top =>
				(top === "u-" ? UNARY_PREC : BINARY[top].prec) > prec ||
				(!right && (top === "u-" ? UNARY_PREC : BINARY[top].prec) === prec),
		);
		ops.push(token.value);
		expectOperand = true;
	}

	if (expectOperand) throw new Error("Unexpected end of expression");
	while (ops.length) {
		const op = ops.pop();
		if (op === "(") throw new Error("Missing closing parenthesis");
		apply(op as Operator | "u-", values);
	}
	if (values.length !== 1) throw new Error("Unexpected token in expression");

	const value = values[0];
	if (!Number.isFinite(value)) throw new Error("Expression result is not a finite number");
	return Object.is(value, -0) ? 0 : value;
}

function formatResult(value: number): string {
	return String(value);
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

type CalculatorParams = Static<typeof calculatorSchema>;

/**
 * Calculator tool for evaluating mathematical expressions.
 *
 * Supports decimal, hex (0x), binary (0b), octal (0o) literals,
 * standard arithmetic operators, and parentheses.
 */
export class CalculatorTool implements AgentTool<typeof calculatorSchema, CalculatorToolDetails> {
	readonly name = "calc";
	readonly label = "Calc";
	readonly summary = "Evaluate a mathematical expression";
	readonly loadMode = "discoverable";
	readonly description: string;
	readonly parameters = calculatorSchema;
	readonly strict = true;

	constructor(_session: ToolSession) {
		this.description = prompt.render(calculatorDescription);
	}

	async execute(
		_toolCallId: string,
		{ calculations }: CalculatorParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<CalculatorToolDetails>> {
		return untilAborted(signal, async () => {
			const results = calculations.map(calc => {
				const value = evaluateExpression(calc.expression);
				const output = `${calc.prefix}${formatResult(value)}${calc.suffix}`;
				return { expression: calc.expression, value, output };
			});

			const outputText = results.map(result => result.output).join("\n");
			return {
				content: [{ type: "text", text: outputText }],
				details: { results },
			};
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface CalculatorRenderArgs {
	calculations?: Array<{ expression: string; prefix?: string; suffix?: string }>;
}

const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;

/**
 * TUI renderer for calculator tool calls and results.
 * Handles both collapsed (preview) and expanded (full) display modes.
 */
export const calculatorToolRenderer = {
	/**
	 * Render the tool call header showing the first expression and count.
	 * Format: "Calc <expression> (N calcs)"
	 */
	renderCall(args: CalculatorRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const count = args.calculations?.length ?? 0;
		const firstExpression = args.calculations?.[0]?.expression;
		const description = firstExpression ? truncateToWidth(firstExpression, TRUNCATE_LENGTHS.TITLE) : undefined;
		const meta = count > 0 ? [formatCount("calc", count)] : [];
		const text = renderStatusLine({ icon: "pending", title: "Calc", description, meta }, uiTheme);
		return new Text(text, 0, 0);
	},

	/**
	 * Render calculation results as a tree list.
	 * Collapsed mode shows first N items with expand hint; expanded shows all.
	 */
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: CalculatorToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: CalculatorRenderArgs,
	): Component {
		const details = result.details;
		const textContent = result.content?.find(c => c.type === "text")?.text ?? "";
		if (result.isError) {
			const header = renderStatusLine({ icon: "error", title: "Calc" }, uiTheme);
			const renderedLines = [header, formatErrorMessage(textContent, uiTheme)];
			return {
				render() {
					return renderedLines;
				},
				invalidate() {},
			};
		}

		// Prefer structured details; fall back to parsing text content
		let outputs = details?.results?.map(entry => `${entry.expression} = ${entry.output}`) ?? [];
		if (outputs.length === 0 && textContent.trim()) {
			const rawOutputs = textContent.split("\n").filter(line => line.trim().length > 0);
			const expressions = args?.calculations?.map(calc => calc.expression) ?? [];
			if (expressions.length === rawOutputs.length && expressions.length > 0) {
				outputs = rawOutputs.map((output, index) => `${expressions[index]} = ${output}`);
			} else {
				outputs = rawOutputs;
			}
		}

		if (outputs.length === 0) {
			const header = renderStatusLine({ icon: "warning", title: "Calc" }, uiTheme);
			const renderedLines = [header, formatEmptyMessage("No results", uiTheme)];
			return {
				render() {
					return renderedLines;
				},
				invalidate() {},
			};
		}

		const description = args?.calculations?.[0]?.expression
			? truncateToWidth(args.calculations[0].expression, TRUNCATE_LENGTHS.TITLE)
			: undefined;
		const header = renderStatusLine(
			{ icon: "success", title: "Calc", description, meta: [formatCount("result", outputs.length)] },
			uiTheme,
		);

		let cached: RenderCache | undefined;

		return {
			render(width) {
				const { expanded } = options;
				const key = new Hasher().bool(expanded).u32(width).digest();
				if (cached?.key === key) return cached.lines;
				const treeLines = renderTreeList(
					{
						items: outputs,
						expanded,
						maxCollapsed: COLLAPSED_LIST_LIMIT,
						itemType: "result",
						renderItem: output => uiTheme.fg("toolOutput", output),
					},
					uiTheme,
				);
				const lines = [header, ...treeLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
				cached = { key, lines };
				return lines;
			},
			invalidate() {
				cached = undefined;
			},
		};
	},
	mergeCallAndResult: true,
};
