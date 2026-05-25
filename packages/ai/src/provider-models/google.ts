import type { ModelManagerOptions } from "../model-manager";
import { fetchGeminiModels } from "../utils/discovery/gemini";

export interface GoogleModelManagerConfig {
	apiKey?: string;
}
export function googleModelManagerOptions(
	config?: GoogleModelManagerConfig,
): ModelManagerOptions<"google-generative-ai"> {
	const apiKey = config?.apiKey;
	return {
		providerId: "google",
		...(apiKey ? { fetchDynamicModels: () => fetchGeminiModels({ apiKey }) } : undefined),
	};
}
