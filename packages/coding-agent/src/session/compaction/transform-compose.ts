import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

/**
 * A function that transforms the agent message context before it's sent to the LLM.
 */
export type TransformContextFn = (
	messages: AgentMessage[],
	signal?: AbortSignal,
) => AgentMessage[] | Promise<AgentMessage[]>;

/**
 * Compose multiple transform functions into a single transform.
 * Transforms execute sequentially — each receives the output of the previous.
 * Null/undefined entries are skipped. Empty array returns identity function.
 */
export function composeTransforms(transforms: Array<TransformContextFn | undefined | null>): TransformContextFn {
	const active = transforms.filter((fn): fn is TransformContextFn => fn != null);

	if (active.length === 0) {
		return messages => messages;
	}

	return async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
		let result = messages;
		for (const transform of active) {
			result = await transform(result, signal);
		}
		return result;
	};
}
