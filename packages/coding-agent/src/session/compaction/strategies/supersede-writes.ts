import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";

export interface SupersedeWritesConfig {
	protectedFilePatterns: string[];
	/** Tool names considered as "write" operations */
	writeTools: string[];
	/** Tool names considered as "read" operations */
	readTools: string[];
}

export const DEFAULT_SUPERSEDE_WRITES_CONFIG: SupersedeWritesConfig = {
	protectedFilePatterns: [],
	writeTools: ["write", "edit"],
	readTools: ["read"],
};

export function supersedeWrites(
	messages: AgentMessage[],
	_currentTurn: number,
	config: SupersedeWritesConfig,
): AgentMessage[] {
	// Pre-compile globs for protected file patterns
	const protectedGlobs = config.protectedFilePatterns.map(pattern => new Bun.Glob(pattern));

	// 1. Scan for all "read" operations and record the last index per file
	const lastReadIndex: Map<string, number> = new Map();

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const content of msg.content) {
				if (content.type === "toolCall" && config.readTools.includes(content.name)) {
					const filePath = content.arguments?.filePath;
					if (typeof filePath === "string") {
						lastReadIndex.set(filePath, i);
					}
				}
			}
		}
	}

	const supersededToolCallIds = new Set<string>();

	// 2. Identify writes superseded by a subsequent read of the same file
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const content of msg.content) {
				if (content.type === "toolCall" && config.writeTools.includes(content.name)) {
					const filePath = content.arguments?.filePath;
					if (typeof filePath === "string" && !protectedGlobs.some(glob => glob.match(filePath))) {
						const lastRead = lastReadIndex.get(filePath);
						if (lastRead !== undefined && lastRead > i) {
							supersededToolCallIds.add(content.id);
						}
					}
				}
			}
		}
	}

	if (supersededToolCallIds.size === 0) {
		return messages;
	}

	// 3. Construct new message array with pruned entries
	return messages.map(msg => {
		if (msg.role === "assistant") {
			return {
				...msg,
				content: msg.content.map(content => {
					if (content.type === "toolCall" && supersededToolCallIds.has(content.id)) {
						return {
							...content,
							arguments: {
								_pruned: true,
								_reason: "superseded-by-read",
								filePath: content.arguments?.filePath,
							},
						} satisfies ToolCall;
					}
					return content;
				}),
			};
		}

		if (msg.role === "toolResult" && supersededToolCallIds.has(msg.toolCallId)) {
			return {
				...msg,
				content: [{ type: "text", text: "[Write output superseded - file was subsequently read]" }],
			};
		}

		return msg;
	});
}
