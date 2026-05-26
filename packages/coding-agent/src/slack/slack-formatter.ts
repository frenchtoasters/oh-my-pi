/**
 * Format agent output for Slack using Block Kit.
 *
 * Uses native `markdown` blocks for assistant text (full standard markdown support).
 * Uses `mrkdwn` section/context blocks only for short status/error messages.
 */

/** Maximum characters in a single Slack markdown block payload (cumulative per message: 12,000) */
const MAX_MARKDOWN_BLOCK_TEXT = 12_000;

export type SlackBlock =
	| { type: "markdown"; text: string }
	| { type: "section"; text: { type: "mrkdwn"; text: string } }
	| { type: "context"; elements: Array<{ type: "mrkdwn"; text: string }> };

export interface SlackMessage {
	text: string;
	blocks?: SlackBlock[];
}

/**
 * Build a section block with mrkdwn text.
 */
function sectionBlock(text: string): SlackBlock {
	return {
		type: "section",
		text: { type: "mrkdwn", text },
	};
}

/**
 * Build a context block (small, muted text).
 */
function contextBlock(text: string): SlackBlock {
	return {
		type: "context",
		elements: [{ type: "mrkdwn", text }],
	};
}

/**
 * Build a markdown block that preserves standard markdown formatting.
 * Slack renders this with full support: headers, tables, code with syntax
 * highlighting, ordered/unordered lists, blockquotes, horizontal rules, etc.
 */
function markdownBlock(text: string): SlackBlock {
	return { type: "markdown", text };
}

/**
 * Format agent assistant text for Slack posting.
 * Returns one or more messages if the text exceeds message limits.
 */
export function formatAssistantText(text: string): SlackMessage[] {
	// Use native markdown blocks — Slack renders standard markdown with full fidelity.
	// Cumulative limit: 12,000 chars across all markdown blocks in one message payload.

	if (text.length <= MAX_MARKDOWN_BLOCK_TEXT) {
		return [
			{
				text: text.slice(0, 200),
				blocks: [markdownBlock(text)],
			},
		];
	}

	// Split across multiple messages at the markdown block char limit
	const messages: SlackMessage[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		const chunk = splitAtBoundary(remaining, MAX_MARKDOWN_BLOCK_TEXT);
		remaining = remaining.slice(chunk.length).replace(/^\n+/, "");

		messages.push({
			text: chunk.slice(0, 200),
			blocks: [markdownBlock(chunk)],
		});
	}

	return messages;
}

/**
 * Split text at a natural boundary (double newline, then single newline, then hard cut).
 */
function splitAtBoundary(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;

	// Try double newline (paragraph boundary)
	let splitAt = text.lastIndexOf("\n\n", maxLen);
	if (splitAt > maxLen * 0.5) return text.slice(0, splitAt);

	// Try single newline
	splitAt = text.lastIndexOf("\n", maxLen);
	if (splitAt > maxLen * 0.5) return text.slice(0, splitAt);

	// Hard split
	return text.slice(0, maxLen);
}

/**
 * Format a tool error for Slack.
 */
export function formatToolError(toolName: string, errorText: string): SlackMessage {
	const truncated = errorText.length > 500 ? `${errorText.slice(0, 500)}...` : errorText;
	return {
		text: `Error in ${toolName}`,
		blocks: [sectionBlock(`:warning: *Error in \`${toolName}\`*`), sectionBlock(`\`\`\`${truncated}\`\`\``)],
	};
}

/**
 * Format completion status.
 */
export function formatCompletion(): SlackMessage {
	return {
		text: "Done",
		blocks: [contextBlock(":white_check_mark: Turn complete")],
	};
}

/**
 * Strip Slack user mention formatting from message text.
 * Converts <@U12345> to plain text, strips channel refs, etc.
 */
export function stripSlackFormatting(text: string): string {
	// Remove user mentions: <@U12345|username> or <@U12345>
	let result = text.replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/g, "");

	// Remove channel mentions: <#C12345|channel-name> → #channel-name
	result = result.replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1");
	result = result.replace(/<#[A-Z0-9]+>/g, "");

	// Convert URL formatting: <url|label> → label, <url> → url
	result = result.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2");
	result = result.replace(/<(https?:\/\/[^>]+)>/g, "$1");

	// Remove special commands: <!here>, <!channel>, <!everyone>
	result = result.replace(/<!(?:here|channel|everyone)(?:\|[^>]+)?>/g, "");

	// Trim excess whitespace
	result = result.replace(/^\s+/, "").replace(/\s+$/, "");

	return result;
}
