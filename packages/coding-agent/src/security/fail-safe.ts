/**
 * Fail-safe state management for security function failures.
 *
 * Implements SC-24 (Fail in Known State) from NIST 800-53 HIGH baseline.
 * When a critical security function fails, the system enters a degraded
 * state that refuses tool execution until explicitly recovered.
 */

import { emitSecurityEvent, SecurityEventType } from "@oh-my-pi/pi-utils";

export type FailSafeState = "operational" | "degraded";

export interface FailSafeStatus {
	state: FailSafeState;
	reason?: string;
	enteredAt?: string;
}

/** Manages system fail-safe state (SC-24). */
export class FailSafeManager {
	#state: FailSafeState = "operational";
	#reason?: string;
	#enteredAt?: string;

	constructor() {
		this.#state = "operational";
	}

	/**
	 * Enter degraded mode. Refuses tool execution until recovered.
	 * Emits an INTEGRITY_VIOLATION audit event.
	 */
	enterDegradedMode(reason: string): void {
		this.#state = "degraded";
		this.#reason = reason;
		this.#enteredAt = new Date().toISOString();
		try {
			emitSecurityEvent(SecurityEventType.INTEGRITY_VIOLATION, "fail-safe", "failure", {
				reason,
				enteredAt: this.#enteredAt,
			});
		} catch {
			// Audit logger may not be initialized yet during early startup.
		}
	}

	/**
	 * Return to operational mode.
	 * Emits a CONFIG_CHANGE audit event noting recovery.
	 */
	recover(): void {
		const previousReason = this.#reason;
		this.#state = "operational";
		this.#reason = undefined;
		this.#enteredAt = undefined;
		try {
			emitSecurityEvent(SecurityEventType.CONFIG_CHANGE, "fail-safe", "success", {
				action: "recovery",
				previousReason,
			});
		} catch {
			// Audit logger may not be initialized yet during early startup.
		}
	}

	/** Returns true if the system is in operational (non-degraded) state. */
	isOperational(): boolean {
		return this.#state === "operational";
	}

	/** Returns the current fail-safe status. */
	getStatus(): FailSafeStatus {
		return {
			state: this.#state,
			reason: this.#reason,
			enteredAt: this.#enteredAt,
		};
	}

	/**
	 * Asserts the system is operational.
	 * Throws if degraded — use as a guard before security-sensitive operations.
	 */
	assertOperational(): void {
		if (this.#state === "degraded") {
			throw new Error(`System is in degraded fail-safe state: ${this.#reason ?? "unknown reason"}`);
		}
	}
}

/** Singleton fail-safe manager for the process. */
export const failSafe = new FailSafeManager();
