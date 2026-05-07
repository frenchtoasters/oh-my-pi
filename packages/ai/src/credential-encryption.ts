/**
 * AES-256-GCM credential encryption with OS keychain integration.
 *
 * Implements IA-5(1) (Authenticator Management | Password-Based Authentication)
 * from NIST 800-53 HIGH baseline.
 */

import * as crypto from "node:crypto";
import * as os from "node:os";
import { logger } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { CryptoParams } from "./crypto-policy";

// ─────────────────────────────────────────────────────────────────────────────
// Error type
// ─────────────────────────────────────────────────────────────────────────────

export type CredentialEncryptionErrorCode =
	| "KEYCHAIN_UNAVAILABLE"
	| "ENCRYPTION_FAILED"
	| "DECRYPTION_FAILED"
	| "KEY_DERIVATION_FAILED";

export class CredentialEncryptionError extends Error {
	code: CredentialEncryptionErrorCode;

	constructor(message: string, code: CredentialEncryptionErrorCode) {
		super(message);
		this.name = "CredentialEncryptionError";
		this.code = code;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// CredentialEncryption
// ─────────────────────────────────────────────────────────────────────────────

export class CredentialEncryption {
	#masterKey: Buffer | null = null;
	#salt: Buffer | null = null;
	#disposed = false;
	#serviceName = "oh-my-pi-credential-store";
	#accountName: string;

	constructor() {
		this.#accountName = os.userInfo().username;
	}

	/**
	 * Initializes the encryption system by loading or generating key material
	 * from the OS keychain. Returns true if encryption is available.
	 */
	async initialize(): Promise<boolean> {
		if (this.#disposed) {
			throw new CredentialEncryptionError("Cannot re-initialize a disposed instance", "KEYCHAIN_UNAVAILABLE");
		}

		try {
			let keyMaterial = await this.#loadFromKeychain();

			if (keyMaterial === null) {
				// Generate new key material and persist it
				keyMaterial = crypto.randomBytes(CryptoParams.aes256gcm.keyLengthBytes);
				const stored = await this.#storeInKeychain(keyMaterial);
				if (!stored) {
					logger.warn("[CredentialEncryption] Keychain unavailable; credential encryption disabled");
					return false;
				}
			}

			// Derive machine-specific salt: SHA-256 of hostname + username + sentinel
			const saltInput = `${os.hostname()}${os.userInfo().username}omp-credential-salt`;
			this.#salt = crypto.createHash("sha256").update(saltInput).digest();

			this.#masterKey = this.#deriveKey(keyMaterial, this.#salt);
			keyMaterial.fill(0);
			return true;
		} catch (err) {
			logger.error("[CredentialEncryption] Initialization failed", { err });
			return false;
		}
	}

	/**
	 * Encrypts a credential value. Returns base64-encoded ciphertext.
	 * Layout: IV (12 bytes) | authTag (16 bytes) | ciphertext
	 */
	encrypt(plaintext: string): string {
		if (this.#disposed) {
			throw new CredentialEncryptionError("Instance has been disposed — cannot encrypt", "KEYCHAIN_UNAVAILABLE");
		}
		if (this.#masterKey === null) {
			throw new CredentialEncryptionError(
				"Encryption unavailable: keychain not initialized",
				"KEYCHAIN_UNAVAILABLE",
			);
		}

		try {
			const iv = crypto.randomBytes(CryptoParams.aes256gcm.ivLengthBytes);
			const cipher = crypto.createCipheriv(CryptoParams.aes256gcm.algorithm, this.#masterKey, iv);

			const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

			const authTag = cipher.getAuthTag();

			// Verify lengths match policy constants
			if (authTag.length !== CryptoParams.aes256gcm.tagLengthBytes) {
				throw new CredentialEncryptionError(`Unexpected auth tag length: ${authTag.length}`, "ENCRYPTION_FAILED");
			}

			return Buffer.concat([iv, authTag, encrypted]).toString("base64");
		} catch (err) {
			if (err instanceof CredentialEncryptionError) throw err;
			throw new CredentialEncryptionError(`Encryption failed: ${String(err)}`, "ENCRYPTION_FAILED");
		}
	}

	/**
	 * Decrypts a credential value from base64-encoded ciphertext.
	 */
	decrypt(encrypted: string): string {
		if (this.#disposed) {
			throw new CredentialEncryptionError("Instance has been disposed — cannot decrypt", "KEYCHAIN_UNAVAILABLE");
		}
		if (this.#masterKey === null) {
			throw new CredentialEncryptionError(
				"Decryption unavailable: keychain not initialized",
				"KEYCHAIN_UNAVAILABLE",
			);
		}

		try {
			const buf = Buffer.from(encrypted, "base64");

			const ivLen = CryptoParams.aes256gcm.ivLengthBytes;
			const tagLen = CryptoParams.aes256gcm.tagLengthBytes;
			const minLen = ivLen + tagLen;

			if (buf.length < minLen) {
				throw new CredentialEncryptionError("Encrypted payload too short", "DECRYPTION_FAILED");
			}

			const iv = buf.subarray(0, ivLen);
			const authTag = buf.subarray(ivLen, ivLen + tagLen);
			const ciphertext = buf.subarray(ivLen + tagLen);

			const decipher = crypto.createDecipheriv(CryptoParams.aes256gcm.algorithm, this.#masterKey, iv);
			decipher.setAuthTag(authTag);

			return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
		} catch (err) {
			if (err instanceof CredentialEncryptionError) throw err;
			throw new CredentialEncryptionError(`Decryption failed: ${String(err)}`, "DECRYPTION_FAILED");
		}
	}

	/** Returns true if the master key is loaded and encryption is ready. */
	isAvailable(): boolean {
		return this.#masterKey !== null;
	}

	/** Returns true if this instance has been disposed via dispose(). */
	isDisposed(): boolean {
		return this.#disposed;
	}

	/**
	 * Zero-fills the master key and salt buffers for secure memory cleanup (SC-4).
	 * After calling dispose(), the instance is no longer usable for encryption or decryption.
	 */
	dispose(): void {
		if (this.#masterKey !== null) {
			this.#masterKey.fill(0);
			this.#masterKey = null;
		}
		if (this.#salt !== null) {
			this.#salt.fill(0);
			this.#salt = null;
		}
		this.#disposed = true;
	}

	// ─── Private ───────────────────────────────────────────────────────────────

	async #loadFromKeychain(): Promise<Buffer | null> {
		const platform = os.platform();

		if (platform === "darwin") {
			const result = await $`security find-generic-password -s ${this.#serviceName} -a ${this.#accountName} -w`
				.quiet()
				.nothrow();
			if (result.exitCode !== 0) return null;
			const hex = result.stdout.toString().trim();
			if (!hex) return null;
			return Buffer.from(hex, "hex");
		}

		if (platform === "linux") {
			const result = await $`secret-tool lookup service ${this.#serviceName} account ${this.#accountName}`
				.quiet()
				.nothrow();
			if (result.exitCode !== 0) return null;
			const hex = result.stdout.toString().trim();
			if (!hex) return null;
			return Buffer.from(hex, "hex");
		}

		return null;
	}

	async #storeInKeychain(keyMaterial: Buffer): Promise<boolean> {
		const platform = os.platform();
		const hex = keyMaterial.toString("hex");

		if (platform === "darwin") {
			const result =
				await $`security add-generic-password -s ${this.#serviceName} -a ${this.#accountName} -w ${hex} -U`
					.quiet()
					.nothrow();
			return result.exitCode === 0;
		}

		if (platform === "linux") {
			const label = "oh-my-pi credentials";
			const result =
				await $`echo ${hex} | secret-tool store --label=${label} service ${this.#serviceName} account ${this.#accountName}`
					.quiet()
					.nothrow();
			return result.exitCode === 0;
		}

		return false;
	}

	#deriveKey(keyMaterial: Buffer, salt: Buffer): Buffer {
		try {
			return crypto.pbkdf2Sync(
				keyMaterial,
				salt,
				CryptoParams.pbkdf2.defaultIterations,
				CryptoParams.aes256gcm.keyLengthBytes,
				"sha256",
			);
		} catch (err) {
			throw new CredentialEncryptionError(`Key derivation failed: ${String(err)}`, "KEY_DERIVATION_FAILED");
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

export const credentialEncryption = new CredentialEncryption();
