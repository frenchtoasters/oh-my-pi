import { beforeEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as securityAudit from "@oh-my-pi/pi-utils";
import { SessionEncryption } from "../../src/security/session-encryption";

vi.spyOn(securityAudit, "emitSecurityEvent").mockReturnValue({ eventId: "", timestamp: "", eventType: securityAudit.SecurityEventType.AUTH_SUCCESS, actor: "", resource: "", outcome: "success" });

describe("SessionEncryption", () => {
	beforeEach(() => {
		vi.spyOn(securityAudit, "emitSecurityEvent").mockReturnValue({ eventId: "", timestamp: "", eventType: securityAudit.SecurityEventType.AUTH_SUCCESS, actor: "", resource: "", outcome: "success" });
	});

	it("isReady returns false before initialization", () => {
		const enc = new SessionEncryption();
		expect(enc.isReady()).toBe(false);
	});

	it("isReady returns true after initialize", () => {
		const enc = new SessionEncryption();
		const testKey = crypto.randomBytes(32);
		enc.initialize(testKey);
		expect(enc.isReady()).toBe(true);
	});

	it("encrypt/decrypt round-trip preserves plaintext", () => {
		const enc = new SessionEncryption();
		const testKey = crypto.randomBytes(32);
		enc.initialize(testKey);

		const plaintext = "hello, secure world";
		const payload = enc.encrypt(plaintext);
		const recovered = enc.decrypt(payload);
		expect(recovered).toBe(plaintext);
	});

	it("encryptJson/decryptJson round-trip preserves object", () => {
		const enc = new SessionEncryption();
		const testKey = crypto.randomBytes(32);
		enc.initialize(testKey);

		const obj = { role: "user", content: "test message", timestamp: 1234567890 };
		const payload = enc.encryptJson(obj);
		const recovered = enc.decryptJson<typeof obj>(payload);
		expect(recovered).toEqual(obj);
	});

	it("encrypted payload has expected structure", () => {
		const enc = new SessionEncryption();
		const testKey = crypto.randomBytes(32);
		enc.initialize(testKey);

		const payload = enc.encrypt("structure check");

		expect(payload.version).toBe(1);
		// iv, data, tag must be non-empty base64 strings
		expect(typeof payload.iv).toBe("string");
		expect(typeof payload.data).toBe("string");
		expect(typeof payload.tag).toBe("string");
		expect(Buffer.from(payload.iv, "base64").length).toBeGreaterThan(0);
		expect(Buffer.from(payload.data, "base64").length).toBeGreaterThan(0);
		expect(Buffer.from(payload.tag, "base64").length).toBeGreaterThan(0);
		// AES-256-GCM: 12-byte IV, 16-byte tag
		expect(Buffer.from(payload.iv, "base64").length).toBe(12);
		expect(Buffer.from(payload.tag, "base64").length).toBe(16);
	});

	it("decrypt fails with wrong key", () => {
		const enc = new SessionEncryption();
		enc.initialize(crypto.randomBytes(32));
		const payload = enc.encrypt("secret data");

		const wrongEnc = new SessionEncryption();
		wrongEnc.initialize(crypto.randomBytes(32));
		expect(() => wrongEnc.decrypt(payload)).toThrow();
	});

	it("decrypt fails with tampered ciphertext", () => {
		const enc = new SessionEncryption();
		const testKey = crypto.randomBytes(32);
		enc.initialize(testKey);

		const payload = enc.encrypt("tamper test");
		// Flip bytes in the ciphertext to break auth tag verification
		const tampered = Buffer.from(payload.data, "base64");
		tampered[0] ^= 0xff;
		const tamperedPayload = { ...payload, data: tampered.toString("base64") };

		expect(() => enc.decrypt(tamperedPayload)).toThrow();
	});

	it("encrypt throws when not initialized", () => {
		const enc = new SessionEncryption();
		expect(() => enc.encrypt("uninitialized")).toThrow("SessionEncryption not initialized");
	});
});
