/**
 * Configurable resource caps to prevent denial-of-service and abuse.
 *
 * NIST 800-53 SC-5: Denial of Service Protection
 * NIST 800-53 SI-4: System Monitoring
 */

import { emitSecurityEvent, SecurityEventType } from "@oh-my-pi/pi-utils";

// =============================================================================
// Types
// =============================================================================

export interface ResourceLimitsConfig {
	/** Maximum output size per tool invocation in bytes. Default: 10 MiB */
	maxOutputBytes: number;
	/** Maximum number of concurrently executing tools. Default: 8 */
	maxConcurrentTools: number;
	/** Maximum cumulative session data in bytes. Default: 100 MiB */
	maxSessionSizeBytes: number;
	/** Maximum wall-clock time allowed per tool in milliseconds. Default: 300 000 ms (5 min) */
	maxToolTimeoutMs: number;
}

const DEFAULT_CONFIG: ResourceLimitsConfig = {
	maxOutputBytes: 10 * 1024 * 1024,
	maxConcurrentTools: 8,
	maxSessionSizeBytes: 100 * 1024 * 1024,
	maxToolTimeoutMs: 300_000,
};

// =============================================================================
// ResourceLimits
// =============================================================================

/**
 * Tracks and enforces configurable resource caps.
 *
 * All state mutations are synchronous. Because JavaScript is single-threaded,
 * acquire/release pairs cannot interleave within a single microtask checkpoint,
 * which provides the same safety guarantee as a mutex for reentrant async code
 * provided callers release slots in `finally` blocks.
 *
 * @example
 * ```ts
 * const limits = new ResourceLimits();
 * if (!limits.acquireSlot()) throw new Error("Too many concurrent tools");
 * try {
 *   await runTool();
 * } finally {
 *   limits.releaseSlot();
 * }
 * ```
 */
export class ResourceLimits {
	#config: ResourceLimitsConfig;
	#currentConcurrent: number;
	#sessionBytes: number;

	constructor(config?: Partial<ResourceLimitsConfig>) {
		this.#config = { ...DEFAULT_CONFIG, ...config };
		this.#currentConcurrent = 0;
		this.#sessionBytes = 0;
	}

	/**
	 * Returns `true` if `bytes` is within the configured per-output limit.
	 * Emits `TOOL_BLOCKED` and returns `false` if the limit is exceeded.
	 */
	checkOutputSize(bytes: number): boolean {
		if (bytes <= this.#config.maxOutputBytes) {
			return true;
		}
		emitSecurityEvent(SecurityEventType.TOOL_BLOCKED, "resource-limits:output-size", "blocked", {
			bytes,
			limitBytes: this.#config.maxOutputBytes,
			reason: `Output size ${bytes} bytes exceeds limit of ${this.#config.maxOutputBytes} bytes`,
		});
		return false;
	}

	/**
	 * Attempts to acquire a concurrent tool execution slot.
	 *
	 * Returns `true` and increments the counter if a slot is available.
	 * Emits `TOOL_BLOCKED` and returns `false` if the concurrent limit is reached.
	 */
	acquireSlot(): boolean {
		if (this.#currentConcurrent < this.#config.maxConcurrentTools) {
			this.#currentConcurrent++;
			return true;
		}
		emitSecurityEvent(SecurityEventType.TOOL_BLOCKED, "resource-limits:concurrent-slot", "blocked", {
			current: this.#currentConcurrent,
			limit: this.#config.maxConcurrentTools,
			reason: `Concurrent tool limit of ${this.#config.maxConcurrentTools} reached`,
		});
		return false;
	}

	/**
	 * Releases a previously acquired concurrent tool execution slot.
	 * Guards against underflow — the counter will never go below zero.
	 */
	releaseSlot(): void {
		if (this.#currentConcurrent > 0) {
			this.#currentConcurrent--;
		}
	}

	/**
	 * Accumulates `bytes` into the session total only if the limit would not be exceeded.
	 *
	 * Returns `true` and increments the counter on success.
	 * Emits `TOOL_BLOCKED` and returns `false` without modifying state if the limit would be exceeded.
	 */
	addSessionBytes(bytes: number): boolean {
		if (this.#sessionBytes + bytes > this.#config.maxSessionSizeBytes) {
			emitSecurityEvent(SecurityEventType.TOOL_BLOCKED, "resource-limits:session-size", "blocked", {
				sessionBytes: this.#sessionBytes,
				requested: bytes,
				limitBytes: this.#config.maxSessionSizeBytes,
				reason: `Session size would exceed limit: ${this.#sessionBytes} + ${bytes} > ${this.#config.maxSessionSizeBytes} bytes`,
			});
			return false;
		}
		this.#sessionBytes += bytes;
		return true;
	}

	/** Returns a snapshot of current utilisation and the active configuration. */
	getStatus(): { concurrent: number; sessionBytes: number; config: ResourceLimitsConfig } {
		return {
			concurrent: this.#currentConcurrent,
			sessionBytes: this.#sessionBytes,
			config: { ...this.#config },
		};
	}
}
