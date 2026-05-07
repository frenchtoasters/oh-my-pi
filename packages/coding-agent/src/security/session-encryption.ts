/**
 * AES-256-GCM session transcript encryption at rest.
 *
 * Implements SC-28 (Protection of Information at Rest) from NIST 800-53 HIGH baseline.
 * Key material is supplied externally (derived from OS keychain via CredentialEncryption).
 */

import * as crypto from "node:crypto";
import { CryptoParams } from "@oh-my-pi/pi-ai";
import { emitSecurityEvent, logger, SecurityEventType } from "@oh-my-pi/pi-utils";

// =============================================================================
// Types
// =============================================================================

export interface EncryptedPayload {
	/** Base64-encoded IV */
	iv: string;
	/** Base64-encoded ciphertext */
	data: string;
	/** Base64-encoded auth tag */
	tag: string;
	/** Version for future algorithm upgrades */
	version: 1;
}

// =============================================================================
// SessionEncryption
// =============================================================================

export class SessionEncryption {
	#key: Buffer | null = null;

	/**
	 * Initialize with a key (32 bytes for AES-256).
	 * In production, derived from OS keychain via CredentialEncryption.
	 */
	initialize(key: Buffer): void {
		if (key.length !== CryptoParams.aes256gcm.keyLengthBytes) {
			throw new Error(
				`Session encryption key must be ${CryptoParams.aes256gcm.keyLengthBytes} bytes, got ${key.length}`,
			);
		}
		this.#key = key;
		emitSecurityEvent(SecurityEventType.CREDENTIAL_ACCESS, "session-encryption-key", "success", {
			action: "key_loaded",
		});
		logger.debug("[SessionEncryption] Key loaded");
	}

	/** Returns true if encryption is ready. */
	isReady(): boolean {
		return this.#key !== null;
	}

	/** Encrypt plaintext string. Returns EncryptedPayload. */
	encrypt(plaintext: string): EncryptedPayload {
		if (this.#key === null) {
			throw new Error("SessionEncryption not initialized: call initialize() first");
		}

		const iv = crypto.randomBytes(CryptoParams.aes256gcm.ivLengthBytes);
		const cipher = crypto.createCipheriv(CryptoParams.aes256gcm.algorithm, this.#key, iv);

		const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
		const authTag = cipher.getAuthTag();

		if (authTag.length !== CryptoParams.aes256gcm.tagLengthBytes) {
			throw new Error(`Unexpected auth tag length: ${authTag.length}`);
		}

		return {
			iv: iv.toString("base64"),
			data: encrypted.toString("base64"),
			tag: authTag.toString("base64"),
			version: 1,
		};
	}

	/** Decrypt an EncryptedPayload back to plaintext string. */
	decrypt(payload: EncryptedPayload): string {
		if (this.#key === null) {
			throw new Error("SessionEncryption not initialized: call initialize() first");
		}

		if (payload.version !== 1) {
			emitSecurityEvent(SecurityEventType.INTEGRITY_VIOLATION, "session-transcript", "failure", {
				reason: "unknown_payload_version",
				version: payload.version,
			});
			throw new Error(`Unknown payload version: ${payload.version}`);
		}

		try {
			const iv = Buffer.from(payload.iv, "base64");
			const ciphertext = Buffer.from(payload.data, "base64");
			const authTag = Buffer.from(payload.tag, "base64");

			const decipher = crypto.createDecipheriv(CryptoParams.aes256gcm.algorithm, this.#key, iv);
			decipher.setAuthTag(authTag);

			return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
		} catch (err) {
			emitSecurityEvent(SecurityEventType.INTEGRITY_VIOLATION, "session-transcript", "failure", {
				reason: "decryption_failed",
				error: String(err),
			});
			throw new Error(`Session decryption failed: ${String(err)}`);
		}
	}

	/** Encrypt a JSON-serializable value. */
	encryptJson(value: unknown): EncryptedPayload {
		return this.encrypt(JSON.stringify(value));
	}

	/** Decrypt an EncryptedPayload and parse as JSON. */
	decryptJson<T = unknown>(payload: EncryptedPayload): T {
		return JSON.parse(this.decrypt(payload)) as T;
	}
}

// =============================================================================
// Singleton
// =============================================================================

export const sessionEncryption = new SessionEncryption();
