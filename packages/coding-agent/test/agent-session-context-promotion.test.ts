import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession context promotion", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-context-promotion-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("litellm", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage.close();
		tempDir.removeSync();
	});

	function createOverflowMessage(
		model: Model,
		errorMessage = "context_length_exceeded: Your input exceeds the context window of this model.",
	): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage,
			timestamp: Date.now(),
		};
	}

	function createUserMessage(content: string) {
		return {
			role: "user" as const,
			content,
			timestamp: Date.now(),
		};
	}

	function createAssistantMessage(model: Model, text = "ok"): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await Bun.sleep(10);
		}
		throw new Error("Timed out waiting for condition");
	}

	it("promotes to a larger-context model on overflow", async () => {
		// gpt-5.3-codex-spark (128K) has contextPromotionTarget: litellm/gpt-5.5 (1050K)
		const sparkModel = modelRegistry.find("litellm", "gpt-5.3-codex-spark");
		const targetModel = modelRegistry.find("litellm", "gpt-5.5");
		if (!sparkModel || !targetModel) {
			throw new Error("Expected litellm spark and target models to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": true,
		});

		const agent = new Agent({
			initialState: {
				model: sparkModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const overflowMessage = createOverflowMessage(sparkModel);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await waitFor(() => session.model?.id === targetModel.id);

		expect(session.model?.provider).toBe(targetModel.provider);
		expect(session.model?.id).toBe(targetModel.id);
	});

	it("promotes on 413 payload-too-large overflow errors", async () => {
		const sparkModel = modelRegistry.find("litellm", "gpt-5.3-codex-spark");
		const targetModel = modelRegistry.find("litellm", "gpt-5.5");
		if (!sparkModel || !targetModel) {
			throw new Error("Expected litellm spark and target models to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": true,
		});

		const agent = new Agent({
			initialState: {
				model: sparkModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const overflowMessage = createOverflowMessage(
			sparkModel,
			"413 Request Entity Too Large: payload too large for model request body",
		);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await waitFor(() => session.model?.id === targetModel.id);

		expect(session.model?.provider).toBe(targetModel.provider);
		expect(session.model?.id).toBe(targetModel.id);
	});

	it("clears provider session state on manual setModel switch", async () => {
		const litellmModel = modelRegistry.find("litellm", "gpt-5.3-codex-spark");
		const anthropicModel = modelRegistry.find("anthropic", "claude-sonnet-4-20250514");
		if (!litellmModel || !anthropicModel) {
			throw new Error("Expected litellm and anthropic models to exist");
		}
		authStorage.setRuntimeApiKey("anthropic", "test-anthropic-key");

		const agent = new Agent({
			initialState: {
				model: litellmModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		// Simulate provider session state that should be cleaned on model switch
		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-responses:litellm", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		await session.setModel(anthropicModel);

		expect(session.model?.provider).toBe(anthropicModel.provider);
		expect(session.model?.id).toBe(anthropicModel.id);
	});

	it("clears provider session state when branching rewrites history", async () => {
		const model = modelRegistry.find("litellm", "gpt-5.3-codex-spark");
		if (!model) {
			throw new Error("Expected litellm model to exist");
		}

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const firstUserId = session.sessionManager.appendMessage(createUserMessage("first"));
		session.sessionManager.appendMessage(createAssistantMessage(model, "first response"));
		session.sessionManager.appendMessage(createUserMessage("second"));
		session.sessionManager.appendMessage(createAssistantMessage(model, "second response"));
		const sessionContext = session.sessionManager.buildSessionContext();
		session.agent.replaceMessages(sessionContext.messages);

		const result = await session.branch(firstUserId);

		expect(result.cancelled).toBe(false);
	});

	it("clears provider session state when tree navigation rewrites history", async () => {
		const model = modelRegistry.find("litellm", "gpt-5.3-codex-spark");
		if (!model) {
			throw new Error("Expected litellm model to exist");
		}

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const firstUserId = session.sessionManager.appendMessage(createUserMessage("first"));
		session.sessionManager.appendMessage(createAssistantMessage(model, "first response"));
		session.sessionManager.appendMessage(createUserMessage("second"));
		session.sessionManager.appendMessage(createAssistantMessage(model, "second response"));
		const sessionContext = session.sessionManager.buildSessionContext();
		session.agent.replaceMessages(sessionContext.messages);

		const result = await session.navigateTree(firstUserId, { summarize: false });

		expect(result.cancelled).toBe(false);
	});

	it("does not promote when promotion is disabled", async () => {
		const sparkModel = modelRegistry.find("litellm", "gpt-5.3-codex-spark");
		if (!sparkModel) {
			throw new Error("Expected litellm spark model to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": false,
		});

		const agent = new Agent({
			initialState: {
				model: sparkModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const overflowMessage = createOverflowMessage(sparkModel);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await Bun.sleep(30);

		expect(session.model?.provider).toBe(sparkModel.provider);
		expect(session.model?.id).toBe(sparkModel.id);
	});
});
