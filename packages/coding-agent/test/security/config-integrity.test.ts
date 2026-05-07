import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as piUtils from "@oh-my-pi/pi-utils";
import {
	computeConfigHash,
	loadBaseline,
	saveBaseline,
	verifyConfigIntegrity,
} from "../../src/security/config-integrity";

vi.spyOn(piUtils, "emitSecurityEvent").mockReturnValue({ eventId: "", timestamp: "", eventType: piUtils.SecurityEventType.AUTH_SUCCESS, actor: "", resource: "", outcome: "success" });

describe("config-integrity", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-config-integrity-"));
		vi.spyOn(piUtils, "getConfigRootDir").mockReturnValue(tmpDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	describe("computeConfigHash", () => {
		it("is deterministic for same input", () => {
			const config = { key: "value", num: 42 };
			expect(computeConfigHash(config)).toBe(computeConfigHash(config));
		});

		it("differs for different input", () => {
			const a = { key: "value" };
			const b = { key: "other" };
			expect(computeConfigHash(a)).not.toBe(computeConfigHash(b));
		});

		it("sorts keys for stability", () => {
			const ab = { a: 1, b: 2 };
			const ba = { b: 2, a: 1 };
			expect(computeConfigHash(ab)).toBe(computeConfigHash(ba));
		});
	});

	describe("saveBaseline / loadBaseline", () => {
		it("saveBaseline creates file and loadBaseline reads it", async () => {
			const hash = "abc123";
			await saveBaseline(hash);
			const baseline = await loadBaseline();
			expect(baseline).not.toBeNull();
			expect(baseline!.hash).toBe(hash);
			expect(baseline!.version).toBe(1);
			expect(typeof baseline!.timestamp).toBe("string");
		});

		it("loadBaseline returns null for missing file", async () => {
			const result = await loadBaseline();
			expect(result).toBeNull();
		});
	});

	describe("verifyConfigIntegrity", () => {
		it("returns match when config unchanged", async () => {
			const config = { setting: "on", level: 3 };
			const hash = computeConfigHash(config);
			await saveBaseline(hash);

			const result = await verifyConfigIntegrity(config);
			expect(result.status).toBe("match");
			expect(result.currentHash).toBe(hash);
			expect(result.baselineHash).toBe(hash);
		});

		it("returns changed when config differs", async () => {
			const original = { setting: "on" };
			await saveBaseline(computeConfigHash(original));

			const modified = { setting: "off" };
			const result = await verifyConfigIntegrity(modified);
			expect(result.status).toBe("changed");
			expect(result.currentHash).toBe(computeConfigHash(modified));
			expect(result.baselineHash).toBe(computeConfigHash(original));
		});

		it("returns no_baseline when no baseline exists", async () => {
			const result = await verifyConfigIntegrity({ any: "value" });
			expect(result.status).toBe("no_baseline");
			expect(typeof result.currentHash).toBe("string");
			expect(result.baselineHash).toBeUndefined();
		});
	});
});
