import type { Api, Model, ToolChoice } from "@oh-my-pi/pi-ai";

/**
 * Build a provider-aware tool choice that targets one specific tool when supported.
 * Some providers only support "any tool" forcing, not a named tool.
 */
export function buildNamedToolChoice(toolName: string, model?: Model<Api>): ToolChoice | undefined {
	if (!model) return undefined;

	if (model.api === "anthropic-messages") {
		return { type: "tool", name: toolName };
	}

	if (model.api === "openai-completions") {
		return { type: "function", name: toolName };
	}

	if (model.api === "google-generative-ai") {
		return "required";
	}

	return undefined;
}
