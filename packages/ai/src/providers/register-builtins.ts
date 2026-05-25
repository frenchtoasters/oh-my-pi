/**
 * Lazy provider module loading.
 *
 * Each provider module is loaded only when its stream function is first called.
 * This avoids eagerly importing heavy SDK dependencies (e.g., @anthropic-ai/sdk,
 * openai) at startup. The loaded module promise is cached so subsequent calls
 * reuse the same import.
 *
 * NOTE: stream.ts currently imports providers directly, so this file is not yet
 * wired into the main streaming path. It provides the infrastructure for lazy
 * loading that can be integrated when stream.ts is refactored.
 */
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	OptionsForApi,
} from "../types";
import { AssistantMessageEventStream as EventStreamImpl } from "../utils/event-stream";
import type { AnthropicOptions } from "./anthropic";
import type { GoogleOptions } from "./google";
import type { OpenAICompletionsOptions } from "./openai-completions";

// ---------------------------------------------------------------------------
// Lazy provider module shape
// ---------------------------------------------------------------------------

interface LazyProviderModule<TApi extends Api> {
	stream: (model: Model<TApi>, context: Context, options: OptionsForApi<TApi>) => AsyncIterable<AssistantMessageEvent>;
}

interface AnthropicProviderModule {
	streamAnthropic: (
		model: Model<"anthropic-messages">,
		context: Context,
		options: AnthropicOptions,
	) => AssistantMessageEventStream;
}

interface GoogleProviderModule {
	streamGoogle: (
		model: Model<"google-generative-ai">,
		context: Context,
		options: GoogleOptions,
	) => AssistantMessageEventStream;
}

interface OpenAICompletionsProviderModule {
	streamOpenAICompletions: (
		model: Model<"openai-completions">,
		context: Context,
		options: OpenAICompletionsOptions,
	) => AssistantMessageEventStream;
}

// ---------------------------------------------------------------------------
// Module-level lazy promise caches
// ---------------------------------------------------------------------------

let anthropicProviderModulePromise: Promise<LazyProviderModule<"anthropic-messages">> | undefined;
let googleProviderModulePromise: Promise<LazyProviderModule<"google-generative-ai">> | undefined;
let openAICompletionsProviderModulePromise: Promise<LazyProviderModule<"openai-completions">> | undefined;

// ---------------------------------------------------------------------------
// Stream forwarding / error helpers
// ---------------------------------------------------------------------------

function hasFinalResult(
	source: AsyncIterable<AssistantMessageEvent>,
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	return typeof (source as { result?: unknown }).result === "function";
}

function forwardStream<TApi extends Api>(
	target: EventStreamImpl,
	source: AsyncIterable<AssistantMessageEvent>,
	model: Model<TApi>,
): void {
	(async () => {
		try {
			for await (const event of source) {
				target.push(event);
			}
			if (hasFinalResult(source)) {
				target.end(await source.result());
			} else {
				target.end();
			}
		} catch (error) {
			const message = createLazyLoadErrorMessage(model, error);
			target.push({ type: "error", reason: "error", error: message });
			target.end(message);
		}
	})();
}

function createLazyLoadErrorMessage<TApi extends Api>(model: Model<TApi>, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
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
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// Generic lazy stream factory
// ---------------------------------------------------------------------------

function createLazyStream<TApi extends Api>(
	loadModule: () => Promise<LazyProviderModule<TApi>>,
): (model: Model<TApi>, context: Context, options: OptionsForApi<TApi>) => EventStreamImpl {
	return (model, context, options) => {
		const outer = new EventStreamImpl();

		loadModule()
			.then(module => {
				const inner = module.stream(model, context, options);
				forwardStream(outer, inner, model);
			})
			.catch(error => {
				const message = createLazyLoadErrorMessage(model, error);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			});

		return outer;
	};
}

// ---------------------------------------------------------------------------
// Module loaders (one per provider, cached via ||=)
// ---------------------------------------------------------------------------

function loadAnthropicProviderModule(): Promise<LazyProviderModule<"anthropic-messages">> {
	anthropicProviderModulePromise ||= import("./anthropic").then(module => {
		const provider = module as AnthropicProviderModule;
		return { stream: provider.streamAnthropic };
	});
	return anthropicProviderModulePromise;
}

function loadGoogleProviderModule(): Promise<LazyProviderModule<"google-generative-ai">> {
	googleProviderModulePromise ||= import("./google").then(module => {
		const provider = module as GoogleProviderModule;
		return { stream: provider.streamGoogle };
	});
	return googleProviderModulePromise;
}

function loadOpenAICompletionsProviderModule(): Promise<LazyProviderModule<"openai-completions">> {
	openAICompletionsProviderModulePromise ||= import("./openai-completions").then(module => {
		const provider = module as OpenAICompletionsProviderModule;
		return { stream: provider.streamOpenAICompletions };
	});
	return openAICompletionsProviderModulePromise;
}

// ---------------------------------------------------------------------------
// Lazy stream function exports
//
// These use the same names as the direct provider stream functions. When
// stream.ts is updated to import from this module instead of individual
// providers, the lazy loading will take effect on the main code path.
// ---------------------------------------------------------------------------

export const streamAnthropic = createLazyStream(loadAnthropicProviderModule);
export const streamGoogle = createLazyStream(loadGoogleProviderModule);
export const streamOpenAICompletions = createLazyStream(loadOpenAICompletionsProviderModule);
