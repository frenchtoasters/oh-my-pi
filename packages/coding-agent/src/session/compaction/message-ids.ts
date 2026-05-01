import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

/**
 * Assigns sequential ephemeral message IDs (m0001, m0002, ...) to messages
 * that qualify for context inclusion.
 *
 * Skip rules:
 * - Messages with excludeFromContext === true
 * - Messages with non-standard roles (only user, developer, assistant, toolResult get IDs)
 */
export function assignMessageIds(messages: AgentMessage[]): Map<number, string> {
	const idMap = new Map<number, string>();
	let counter = 1;

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];

		// Check exclusion flag
		if ("excludeFromContext" in message && message.excludeFromContext === true) {
			continue;
		}

		// Role filtering
		const role = message.role;
		if (role === "user" || role === "developer" || role === "assistant" || role === "toolResult") {
			const id = `m${counter.toString().padStart(4, "0")}`;
			idMap.set(i, id);
			counter++;
		}
	}

	return idMap;
}

/**
 * Injects <dcp-message-id> tags into message content.
 * Returns a new array, never mutating inputs.
 */
export function injectMessageIdTags(messages: AgentMessage[], idMap: Map<number, string>): AgentMessage[] {
	return messages.map((msg, i) => {
		const id = idMap.get(i);
		if (!id) return msg;

		const tag = `<dcp-message-id>${id}</dcp-message-id>\n`;

		// Shallow-clone content objects to avoid mutating originals in AgentState
		const newMsg = { ...msg };

		if (newMsg.role === "user" || newMsg.role === "developer") {
			if (typeof newMsg.content === "string") {
				newMsg.content = [{ type: "text" as const, text: tag + newMsg.content }];
			} else {
				newMsg.content = prependTagToContent(newMsg.content, tag) as typeof newMsg.content;
			}
		} else if (newMsg.role === "assistant" || newMsg.role === "toolResult") {
			newMsg.content = prependTagToContent(newMsg.content, tag) as typeof newMsg.content;
		}

		return newMsg as AgentMessage;
	});
}

/**
 * Prepends a tag to the first text content block, creating new objects
 * to avoid mutating originals shared with AgentState.
 */
function prependTagToContent(content: unknown, tag: string): unknown[] {
	const arr = Array.isArray(content) ? content : [content];
	const cloned = arr.map((c: Record<string, unknown>) => ({ ...c }));
	const idx = cloned.findIndex(c => c.type === "text");
	if (idx >= 0) {
		cloned[idx].text = tag + String(cloned[idx].text ?? "");
	} else {
		cloned.unshift({ type: "text", text: tag });
	}
	return cloned;
}

/**
 * Removes <dcp-message-id> tags from a string.
 */
export function stripMessageIdTags(text: string): string {
	return text.replace(/<dcp-message-id>m\d+<\/dcp-message-id>\n?/g, "");
}
