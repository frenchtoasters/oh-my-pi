import { emitSecurityEvent, SecurityEventType } from "@oh-my-pi/pi-utils";

const DEFAULT_MAX_FAILURES = 3;

export class AuthFailureTracker {
	#failures: Map<string, number>;
	#maxFailures: number;

	constructor(maxFailures?: number) {
		this.#failures = new Map();
		this.#maxFailures = maxFailures ?? DEFAULT_MAX_FAILURES;
	}

	recordFailure(providerKey: string, error?: string): { shouldStop: boolean; consecutiveCount: number } {
		const prior = this.#failures.get(providerKey) ?? 0;
		const count = prior + 1;
		this.#failures.set(providerKey, count);

		emitSecurityEvent(SecurityEventType.AUTH_FAILURE, providerKey, "failure", {
			consecutiveCount: count,
			maxFailures: this.#maxFailures,
			...(error !== undefined ? { error } : {}),
		});

		return { shouldStop: count >= this.#maxFailures, consecutiveCount: count };
	}

	recordSuccess(providerKey: string): void {
		const prior = this.#failures.get(providerKey) ?? 0;
		this.#failures.delete(providerKey);

		if (prior > 0) {
			emitSecurityEvent(SecurityEventType.AUTH_SUCCESS, providerKey, "success", {
				clearedConsecutiveFailures: prior,
			});
		}
	}

	getFailureCount(providerKey: string): number {
		return this.#failures.get(providerKey) ?? 0;
	}

	reset(providerKey?: string): void {
		if (providerKey !== undefined) {
			this.#failures.delete(providerKey);
		} else {
			this.#failures.clear();
		}
	}
}

export const authFailureTracker: AuthFailureTracker = new AuthFailureTracker();
