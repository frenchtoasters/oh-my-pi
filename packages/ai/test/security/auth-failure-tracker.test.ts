import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";

import * as securityAudit from "@oh-my-pi/pi-utils";
import { AuthFailureTracker } from "../../src/auth-failure-tracker";

describe("AuthFailureTracker", () => {
	let tracker: AuthFailureTracker;
	let emitSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tracker = new AuthFailureTracker();
		emitSpy = vi.spyOn(securityAudit, "emitSecurityEvent");
	});

	afterEach(() => {
		emitSpy.mockRestore();
	});

	it("recordFailure increments count and returns shouldStop=false under threshold", () => {
		const result = tracker.recordFailure("openai");
		expect(result.consecutiveCount).toBe(1);
		expect(result.shouldStop).toBe(false);
		expect(tracker.getFailureCount("openai")).toBe(1);
	});

	it("recordFailure returns shouldStop=true at maxFailures threshold", () => {
		// Default maxFailures is 3
		tracker.recordFailure("anthropic");
		tracker.recordFailure("anthropic");
		const result = tracker.recordFailure("anthropic");
		expect(result.consecutiveCount).toBe(3);
		expect(result.shouldStop).toBe(true);
	});

	it("recordFailure emits AUTH_FAILURE event with consecutiveCount", () => {
		tracker.recordFailure("openai", "401 Unauthorized");
		expect(emitSpy).toHaveBeenCalledTimes(1);
		const [eventType, resource, outcome, metadata] = emitSpy.mock.calls[0]!;
		expect(eventType).toBe(securityAudit.SecurityEventType.AUTH_FAILURE);
		expect(resource).toBe("openai");
		expect(outcome).toBe("failure");
		expect((metadata as Record<string, unknown>)?.consecutiveCount).toBe(1);
		expect((metadata as Record<string, unknown>)?.error).toBe("401 Unauthorized");
	});

	it("recordSuccess resets failure count to 0", () => {
		tracker.recordFailure("openai");
		tracker.recordFailure("openai");
		tracker.recordSuccess("openai");
		expect(tracker.getFailureCount("openai")).toBe(0);
	});

	it("recordSuccess after failures emits AUTH_SUCCESS event", () => {
		tracker.recordFailure("openai");
		emitSpy.mockClear();
		tracker.recordSuccess("openai");
		expect(emitSpy).toHaveBeenCalledTimes(1);
		const [eventType, resource, outcome] = emitSpy.mock.calls[0]!;
		expect(eventType).toBe(securityAudit.SecurityEventType.AUTH_SUCCESS);
		expect(resource).toBe("openai");
		expect(outcome).toBe("success");
	});

	it("recordSuccess with no prior failures does not emit event", () => {
		tracker.recordSuccess("openai");
		expect(emitSpy).not.toHaveBeenCalled();
	});

	it("different providers tracked independently", () => {
		tracker.recordFailure("openai");
		tracker.recordFailure("openai");
		tracker.recordFailure("anthropic");

		expect(tracker.getFailureCount("openai")).toBe(2);
		expect(tracker.getFailureCount("anthropic")).toBe(1);

		tracker.recordSuccess("openai");
		expect(tracker.getFailureCount("openai")).toBe(0);
		expect(tracker.getFailureCount("anthropic")).toBe(1);
	});

	it("custom maxFailures threshold is respected", () => {
		const strictTracker = new AuthFailureTracker(1);
		const first = strictTracker.recordFailure("provider");
		expect(first.shouldStop).toBe(true);
		expect(first.consecutiveCount).toBe(1);
	});

	it("custom maxFailures > 1 allows failures below threshold", () => {
		const lenientTracker = new AuthFailureTracker(5);
		const r1 = lenientTracker.recordFailure("provider");
		expect(r1.shouldStop).toBe(false);
		const r4 = lenientTracker.recordFailure("provider");
		expect(r4.shouldStop).toBe(false);
		const r5 = lenientTracker.recordFailure("provider");
		expect(r5.shouldStop).toBe(false);
		const r6 = lenientTracker.recordFailure("provider");
		expect(r6.shouldStop).toBe(false);
		const r7 = lenientTracker.recordFailure("provider");
		expect(r7.shouldStop).toBe(true);
		expect(r7.consecutiveCount).toBe(5);
	});

	it("reset() clears a specific provider", () => {
		tracker.recordFailure("openai");
		tracker.recordFailure("anthropic");
		tracker.reset("openai");
		expect(tracker.getFailureCount("openai")).toBe(0);
		expect(tracker.getFailureCount("anthropic")).toBe(1);
	});

	it("reset() with no argument clears all providers", () => {
		tracker.recordFailure("openai");
		tracker.recordFailure("anthropic");
		tracker.recordFailure("google");
		tracker.reset();
		expect(tracker.getFailureCount("openai")).toBe(0);
		expect(tracker.getFailureCount("anthropic")).toBe(0);
		expect(tracker.getFailureCount("google")).toBe(0);
	});
});
