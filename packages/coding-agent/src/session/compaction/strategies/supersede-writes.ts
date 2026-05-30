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

	// 1. Scan for all "read" and "write" operations and record the last index per file
	const lastReadIndex: Map<string, number> = new Map();
	// Track the last write index per file for write→write superseding
	const lastWriteIndex: Map<string, number> = new Map();

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const content of msg.content) {
				if (content.type === "toolCall") {
					if (config.readTools.includes(content.name)) {
						const targetPath = content.arguments?.path;
						if (typeof targetPath === "string") {
							lastReadIndex.set(targetPath, i);
						}
					} else if (config.writeTools.includes(content.name)) {
						const targetPath = content.arguments?.path;
						if (typeof targetPath === "string") {
							lastWriteIndex.set(targetPath, i);
						}
					}
				}
			}
		}
	}

	const supersededToolCallIds = new Set<string>();
	// 2. Identify writes superseded by a subsequent read OR a subsequent write to the same file
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const content of msg.content) {
				if (content.type === "toolCall" && config.writeTools.includes(content.name)) {
					const targetPath = content.arguments?.path;
					if (typeof targetPath === "string" && !protectedGlobs.some(glob => glob.match(targetPath))) {
						const lastRead = lastReadIndex.get(targetPath);
						const lastWrite = lastWriteIndex.get(targetPath);
						// Superseded if: a later read exists, OR a later write exists (write→write overwrite)
						if ((lastRead !== undefined && lastRead > i) || (lastWrite !== undefined && lastWrite > i)) {
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
								_reason: "superseded",
								path: content.arguments?.path,
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
				content: [{ type: "text", text: "[Write output superseded - file was subsequently modified or read]" }],
			};
		}

		return msg;
	});
}
