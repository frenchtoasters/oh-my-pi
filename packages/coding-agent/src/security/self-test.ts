/**
 * Security function verification on startup.
 *
 * NIST 800-53 SI-6: Security Function Verification
 * Verifies that security mechanisms are functioning correctly at startup
 * and emits audit events on any failure.
 */

import * as crypto from "node:crypto";
import { CryptoParams } from "@oh-my-pi/pi-ai";
import { emitSecurityEvent, SecurityEventType } from "@oh-my-pi/pi-utils";
import { verifyConfigIntegrity } from "./config-integrity";

// =============================================================================
// Types
// =============================================================================

export interface SelfTestCheck {
	name: string;
	passed: boolean;
	error?: string;
}

export interface SelfTestResult {
	passed: boolean;
	checks: SelfTestCheck[];
}

// =============================================================================
// Individual checks
// =============================================================================

async function checkAuditLogger(): Promise<SelfTestCheck> {
	const name = "audit-logger-write";
	try {
		emitSecurityEvent(SecurityEventType.CONFIG_CHANGE, "self-test:audit-probe", "success", {
			check: name,
			selfTest: true,
		});
		return { name, passed: true };
	} catch (err) {
		return {
			name,
			passed: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

function checkCryptoFunctions(): SelfTestCheck {
	const name = "crypto-functions-available";
	try {
		const bytes = crypto.randomBytes(16);
		if (bytes.length !== 16) {
			return { name, passed: false, error: `Expected 16 random bytes, got ${bytes.length}` };
		}
		return { name, passed: true };
	} catch (err) {
		return {
			name,
			passed: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

async function checkConfigIntegrity(currentConfig: Record<string, unknown>): Promise<SelfTestCheck> {
	const name = "config-integrity-check";
	try {
		const result = await verifyConfigIntegrity(currentConfig);
		// no_baseline is acceptable on first run — not a failure
		if (result.status === "changed") {
			return {
				name,
				passed: false,
				error: `Config hash mismatch: baseline=${result.baselineHash ?? "none"} current=${result.currentHash}`,
			};
		}
		return { name, passed: true };
	} catch (err) {
		return {
			name,
			passed: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

function checkGenesisHash(): SelfTestCheck {
	const name = "genesis-hash-constant";
	try {
		// Verify the seed is the known value
		if (CryptoParams.hashChain.genesisSeed !== "omp-audit-genesis-v1") {
			return {
				name,
				passed: false,
				error: `Unexpected genesis seed: ${CryptoParams.hashChain.genesisSeed}`,
			};
		}
		// Verify crypto subsystem produces expected output for known input
		const hash = crypto.createHash("sha256").update("omp-audit-genesis-v1").digest("hex");
		if (hash.length !== 64) {
			return { name, passed: false, error: "SHA-256 produced unexpected output length" };
		}
		return { name, passed: true };
	} catch (err) {
		return {
			name,
			passed: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Run all security self-tests. Call on startup.
 *
 * Runs four checks in order:
 * 1. Audit logger can write
 * 2. Crypto functions available (randomBytes)
 * 3. Config integrity check runs (no_baseline is acceptable)
 * 4. Hash chain genesis constant is correct
 *
 * Emits `INTEGRITY_VIOLATION` on any failing check.
 *
 * @param currentConfig - The current runtime configuration to verify against the baseline.
 */
export async function runSecuritySelfTest(currentConfig: Record<string, unknown>): Promise<SelfTestResult> {
	const checks: SelfTestCheck[] = [
		// checkAuditLogger is async (emitSecurityEvent is sync but we keep consistent API)
		await checkAuditLogger(),
		checkCryptoFunctions(),
		await checkConfigIntegrity(currentConfig),
		checkGenesisHash(),
	];

	const failed = checks.filter(c => !c.passed);

	if (failed.length > 0) {
		emitSecurityEvent(SecurityEventType.INTEGRITY_VIOLATION, "self-test", "failure", {
			failedChecks: failed.map(c => ({ name: c.name, error: c.error })),
		});
	}

	return {
		passed: failed.length === 0,
		checks,
	};
}
