import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";

import * as securityAudit from "@oh-my-pi/pi-utils";
import { getTlsFetchOptions, validateTlsEnvironment } from "../../src/tls-policy";

describe("getTlsFetchOptions", () => {
	it("returns rejectUnauthorized=true by default", () => {
		const opts = getTlsFetchOptions();
		expect(opts.tls.rejectUnauthorized).toBe(true);
	});

	it("returns a minVersion string", () => {
		const opts = getTlsFetchOptions();
		expect(typeof opts.tls.minVersion).toBe("string");
		expect(opts.tls.minVersion.length).toBeGreaterThan(0);
	});

	it("getTlsFetchOptions with allowSelfSigned=true returns rejectUnauthorized=false", () => {
		const opts = getTlsFetchOptions(true);
		expect(opts.tls.rejectUnauthorized).toBe(false);
	});

	it("getTlsFetchOptions with allowSelfSigned=false returns rejectUnauthorized=true", () => {
		const opts = getTlsFetchOptions(false);
		expect(opts.tls.rejectUnauthorized).toBe(true);
	});

	it("minVersion is TLSv1.2 or higher", () => {
		const opts = getTlsFetchOptions();
		// Acceptable values: TLSv1.2 or TLSv1.3
		expect(["TLSv1.2", "TLSv1.3"]).toContain(opts.tls.minVersion);
	});
});

describe("validateTlsEnvironment", () => {
	let emitSpy: ReturnType<typeof vi.spyOn>;
	let originalValue: string | undefined;

	beforeEach(() => {
		originalValue = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		emitSpy = vi.spyOn(securityAudit, "emitSecurityEvent");
	});

	afterEach(() => {
		// Restore the environment variable precisely
		if (originalValue === undefined) {
			delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		} else {
			process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalValue;
		}
		emitSpy.mockRestore();
	});

	it("returns true when NODE_TLS_REJECT_UNAUTHORIZED is not set", () => {
		delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		const result = validateTlsEnvironment();
		expect(result).toBe(true);
	});

	it("returns true when NODE_TLS_REJECT_UNAUTHORIZED is set to '1'", () => {
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
		const result = validateTlsEnvironment();
		expect(result).toBe(true);
	});

	it("returns false when NODE_TLS_REJECT_UNAUTHORIZED=0 and emits INTEGRITY_VIOLATION event", () => {
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
		const result = validateTlsEnvironment();
		expect(result).toBe(false);
		expect(emitSpy).toHaveBeenCalledTimes(1);
		const [eventType, resource, outcome] = emitSpy.mock.calls[0]!;
		expect(eventType).toBe(securityAudit.SecurityEventType.INTEGRITY_VIOLATION);
		expect(resource).toBe("NODE_TLS_REJECT_UNAUTHORIZED");
		expect(outcome).toBe("failure");
	});

	it("does not emit any event when validation passes", () => {
		delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		validateTlsEnvironment();
		expect(emitSpy).not.toHaveBeenCalled();
	});
});
