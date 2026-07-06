/**
 * Centralized cryptographic standards for oh-my-pi.
 *
 * Implements SC-12 (Cryptographic Key Establishment and Management) and
 * SC-13 (Cryptographic Protection) from NIST 800-53 HIGH baseline.
 *
 * All cryptographic operations in the application MUST use constants and
 * utilities defined here. Direct use of weak or deprecated algorithms is
 * prohibited.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Approved Algorithms
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum TLS version allowed. */
export const MIN_TLS_VERSION = "TLSv1.2" as const;

// ─────────────────────────────────────────────────────────────────────────────
// Cryptographic Parameters
// ─────────────────────────────────────────────────────────────────────────────

export const CryptoParams = {
	/** AES-256-GCM parameters */
	aes256gcm: {
		algorithm: "aes-256-gcm" as const,
		keyLengthBytes: 32,
		ivLengthBytes: 12,
		tagLengthBytes: 16,
	},

	/** PBKDF2 parameters */
	pbkdf2: {
		algorithm: "pbkdf2" as const,
		/** Minimum iterations per NIST SP 800-132 */
		minIterations: 100_000,
		/** Default iterations for new key derivations */
		defaultIterations: 210_000,
		hashAlgorithm: "sha-256" as const,
		saltLengthBytes: 32,
	},

	/** SHA-256 hash chain parameters (for audit log integrity) */
	hashChain: {
		algorithm: "sha-256" as const,
		/** Known seed for the first entry in a new log file */
		genesisSeed: "omp-audit-genesis-v1",
	},
} as const;
