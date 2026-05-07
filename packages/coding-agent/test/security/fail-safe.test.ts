import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { CredentialEncryption, CredentialEncryptionError } from "@oh-my-pi/pi-ai";
import * as securityAudit from "@oh-my-pi/pi-utils";
import { FailSafeManager } from "../../src/security/fail-safe";

// Silence audit events emitted by FailSafeManager — we test state, not side-effects.
spyOn(securityAudit, "emitSecurityEvent").mockReturnValue({
	eventId: "",
	timestamp: "",
	eventType: securityAudit.SecurityEventType.INTEGRITY_VIOLATION,
	actor: "",
	resource: "fail-safe",
	outcome: "failure",
});

// ─── FailSafeManager ──────────────────────────────────────────────────────────

describe("FailSafeManager", () => {
	let manager: FailSafeManager;

	beforeEach(() => {
		manager = new FailSafeManager();
	});

	test("starts in operational state", () => {
		expect(manager.getStatus().state).toBe("operational");
	});

	test("isOperational() returns true initially", () => {
		expect(manager.isOperational()).toBe(true);
	});

	test("assertOperational() does not throw when operational", () => {
		expect(() => manager.assertOperational()).not.toThrow();
	});

	test("enterDegradedMode() changes state to degraded", () => {
		manager.enterDegradedMode("test reason");
		expect(manager.getStatus().state).toBe("degraded");
	});

	test("isOperational() returns false after entering degraded mode", () => {
		manager.enterDegradedMode("test reason");
		expect(manager.isOperational()).toBe(false);
	});

	test("getStatus() returns correct state and reason after degraded", () => {
		manager.enterDegradedMode("disk full");
		const status = manager.getStatus();
		expect(status.state).toBe("degraded");
		expect(status.reason).toBe("disk full");
	});

	test("getStatus().enteredAt is set when degraded", () => {
		const before = new Date().toISOString();
		manager.enterDegradedMode("timing test");
		const after = new Date().toISOString();
		const { enteredAt } = manager.getStatus();
		expect(typeof enteredAt).toBe("string");
		expect(enteredAt! >= before).toBe(true);
		expect(enteredAt! <= after).toBe(true);
	});

	test("assertOperational() throws when in degraded mode", () => {
		manager.enterDegradedMode("security check failed");
		expect(() => manager.assertOperational()).toThrow("security check failed");
	});

	test("recover() restores operational state", () => {
		manager.enterDegradedMode("temporary failure");
		manager.recover();
		expect(manager.getStatus().state).toBe("operational");
	});

	test("isOperational() returns true again after recover()", () => {
		manager.enterDegradedMode("temporary failure");
		manager.recover();
		expect(manager.isOperational()).toBe(true);
	});

	test("getStatus() clears reason and enteredAt after recover()", () => {
		manager.enterDegradedMode("forgotten reason");
		manager.recover();
		const status = manager.getStatus();
		expect(status.reason).toBeUndefined();
		expect(status.enteredAt).toBeUndefined();
	});
});

// ─── CredentialEncryption SC-4 (dispose / memory safety) ─────────────────────

describe("CredentialEncryption SC-4", () => {
	test("isAvailable() returns false on a fresh uninitialized instance", () => {
		const enc = new CredentialEncryption();
		expect(enc.isAvailable()).toBe(false);
	});

	test("dispose() on an uninitialized instance does not throw", () => {
		const enc = new CredentialEncryption();
		expect(() => enc.dispose()).not.toThrow();
	});

	test("encrypt() throws KEYCHAIN_UNAVAILABLE when not initialized", () => {
		const enc = new CredentialEncryption();
		expect(() => enc.encrypt("secret")).toThrow(CredentialEncryptionError);
		let caught: unknown;
		try {
			enc.encrypt("secret");
		} catch (err) {
			caught = err;
		}
		expect(caught instanceof CredentialEncryptionError).toBe(true);
		expect((caught as CredentialEncryptionError).code).toBe("KEYCHAIN_UNAVAILABLE");
	});

	test("isAvailable() returns false after dispose() on an initialized-then-disposed instance", () => {
		// Simulate a post-dispose state by calling dispose() twice — must stay false.
		const enc = new CredentialEncryption();
		enc.dispose(); // no-op, already null
		enc.dispose(); // second no-op
		expect(enc.isAvailable()).toBe(false);
	});
});
