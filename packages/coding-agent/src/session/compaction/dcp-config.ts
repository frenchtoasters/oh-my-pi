import type { NudgeConfig } from "./nudges";

export interface DCPConfig {
	enabled: boolean;
	strategies: {
		deduplication: {
			enabled: boolean;
			protectedTools: string[];
			protectedFilePatterns: string[];
			turnProtectionTurns: number;
		};
		purgeErrors: { enabled: boolean; turnThreshold: number; protectedTools: string[] };
		supersedeWrites: { enabled: boolean; protectedFilePatterns: string[]; writeTools: string[]; readTools: string[] };
	};
	nudge?: NudgeConfig;
}
