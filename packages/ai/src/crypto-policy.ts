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

/** Approved symmetric encryption algorithms. */
export const APPROVED_SYMMETRIC_ALGORITHMS = ["aes-256-gcm"] as const;
export type ApprovedSymmetricAlgorithm = (typeof APPROVED_SYMMETRIC_ALGORITHMS)[number];

/** Approved hash algorithms. SHA-1 is prohibited except for git operations. */
export const APPROVED_HASH_ALGORITHMS = ["sha-256", "sha-384", "sha-512"] as const;
export type ApprovedHashAlgorithm = (typeof APPROVED_HASH_ALGORITHMS)[number];

/** Prohibited hash algorithms. */
export const PROHIBITED_HASH_ALGORITHMS = ["md5", "sha-1"] as const;

/** Approved key derivation functions. */
export const APPROVED_KDF_ALGORITHMS = ["pbkdf2", "argon2id"] as const;
export type ApprovedKdfAlgorithm = (typeof APPROVED_KDF_ALGORITHMS)[number];

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

// ─────────────────────────────────────────────────────────────────────────────
// Validation Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates that a hash algorithm is approved for use.
 * @param algorithm - The algorithm name to validate
 * @returns true if the algorithm is approved
 */
export function isApprovedHashAlgorithm(algorithm: string): algorithm is ApprovedHashAlgorithm {
	return (APPROVED_HASH_ALGORITHMS as readonly string[]).includes(algorithm.toLowerCase());
}

/**
 * Validates that a symmetric algorithm is approved for use.
 * @param algorithm - The algorithm name to validate
 * @returns true if the algorithm is approved
 */
export function isApprovedSymmetricAlgorithm(algorithm: string): algorithm is ApprovedSymmetricAlgorithm {
	return (APPROVED_SYMMETRIC_ALGORITHMS as readonly string[]).includes(algorithm.toLowerCase());
}

/**
 * Checks if a hash algorithm is explicitly prohibited.
 * @param algorithm - The algorithm name to check
 * @returns true if the algorithm is prohibited
 */
export function isProhibitedAlgorithm(algorithm: string): boolean {
	return (PROHIBITED_HASH_ALGORITHMS as readonly string[]).includes(algorithm.toLowerCase());
}

/**
 * Asserts that PBKDF2 iteration count meets minimum requirements.
 * @param iterations - The iteration count to validate
 * @throws Error if iterations are below minimum
 */
export function assertMinPbkdf2Iterations(iterations: number): void {
	if (iterations < CryptoParams.pbkdf2.minIterations) {
		throw new Error(
			`PBKDF2 iterations (${iterations}) below minimum (${CryptoParams.pbkdf2.minIterations}). ` +
				`NIST SP 800-132 requires at least ${CryptoParams.pbkdf2.minIterations} iterations.`,
		);
	}
}
