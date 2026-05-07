import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

/** Count assistant messages up to (but not including) msgIndex. */
export function turnAtIndex(messages: AgentMessage[], msgIndex: number): number {
	let turn = 0;
	for (let i = 0; i < msgIndex; i++) {
		if (messages[i].role === "assistant") turn++;
	}
	return turn;
}
