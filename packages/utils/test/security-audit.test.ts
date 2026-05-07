import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SecurityAuditLogger, SecurityEventType } from "../src/security-audit";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(data: string): string {
	return crypto.createHash("sha256").update(data).digest("hex");
}

const GENESIS_HASH = sha256("omp-audit-genesis-v1");

function makeEvent(logger: SecurityAuditLogger) {
	return logger.emit({
		eventType: SecurityEventType.AUTH_SUCCESS,
		actor: "test-actor",
		resource: "/test/resource",
		outcome: "success",
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmpDir: string;
let logger: SecurityAuditLogger;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-audit-test-"));
	logger = new SecurityAuditLogger({ logDir: tmpDir });
});

afterEach(async () => {
	logger.close();
	await fs.rm(tmpDir, { recursive: true, force: true });
	setSystemTime(); // restore real time
});

describe("emits event with all required fields", () => {
	it("event has expected shape", () => {
		const event = makeEvent(logger);

		// eventId must be a UUIDv4
		expect(event.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

		// timestamp must be ISO 8601 (includes 'T' and 'Z')
		expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
		expect(() => new Date(event.timestamp)).not.toThrow();
		expect(Number.isNaN(new Date(event.timestamp).getTime())).toBe(false);

		expect(event.eventType).toBe(SecurityEventType.AUTH_SUCCESS);
		expect(event.actor).toBe("test-actor");
		expect(event.resource).toBe("/test/resource");
		expect(event.outcome).toBe("success");

		// prevHash must be the genesis hash for the first event
		expect(event.prevHash).toBe(GENESIS_HASH);
	});
});

describe("genesis hash matches expected seed", () => {
	it("first event prevHash equals sha256(omp-audit-genesis-v1)", () => {
		const event = makeEvent(logger);
		expect(event.prevHash).toBe(sha256("omp-audit-genesis-v1"));
	});
});

describe("hash chain is sequential", () => {
	it("each prevHash equals sha256 of the previous JSONL line", async () => {
		const e1 = makeEvent(logger);
		const e2 = makeEvent(logger);
		const e3 = makeEvent(logger);

		// Read back the file to get the exact serialized lines
		const today = new Date().toISOString().slice(0, 10);
		const logPath = path.join(tmpDir, `audit.${today}.log`);
		const contents = await fs.readFile(logPath, "utf8");
		const lines = contents.split("\n").filter(l => l.length > 0);

		expect(lines.length).toBe(3);

		// e1.prevHash = GENESIS_HASH (already verified above)
		// e2.prevHash must equal sha256(lines[0] + "\n")
		expect(e2.prevHash).toBe(sha256(`${lines[0]}\n`));
		// e3.prevHash must equal sha256(lines[1] + "\n")
		expect(e3.prevHash).toBe(sha256(`${lines[1]}\n`));

		// Sanity: e1 is lines[0], etc.
		expect(JSON.parse(lines[0]).eventId).toBe(e1.eventId);
		expect(JSON.parse(lines[1]).eventId).toBe(e2.eventId);
		expect(JSON.parse(lines[2]).eventId).toBe(e3.eventId);
	});
});

describe("file is created with 0o600 permissions", () => {
	it("stat mode is 0o600", async () => {
		makeEvent(logger);

		const today = new Date().toISOString().slice(0, 10);
		const logPath = path.join(tmpDir, `audit.${today}.log`);
		const stat = await fs.stat(logPath);

		// On POSIX: mode & 0o777 should equal 0o600
		expect(stat.mode & 0o777).toBe(0o600);
	});
});

describe("rotates to new file on date change", () => {
	it("creates a separate file when the date changes", async () => {
		// Pin to a known date so we control the file name
		setSystemTime(new Date("2025-01-15T12:00:00Z"));
		const logger2 = new SecurityAuditLogger({ logDir: tmpDir });

		makeEvent(logger2);
		expect(await fs.readdir(tmpDir)).toContain("audit.2025-01-15.log");

		// Advance past midnight
		setSystemTime(new Date("2025-01-16T00:01:00Z"));

		makeEvent(logger2);
		const files = await fs.readdir(tmpDir);
		expect(files).toContain("audit.2025-01-15.log");
		expect(files).toContain("audit.2025-01-16.log");

		logger2.close();
	});

	it("new file starts from genesis hash after rotation", async () => {
		setSystemTime(new Date("2025-02-10T12:00:00Z"));
		const logger2 = new SecurityAuditLogger({ logDir: tmpDir });

		makeEvent(logger2);
		setSystemTime(new Date("2025-02-11T00:00:01Z"));

		const rotatedEvent = makeEvent(logger2);
		// After rotation, the hash chain resets to genesis
		expect(rotatedEvent.prevHash).toBe(GENESIS_HASH);

		logger2.close();
	});
});

describe("JSONL format is parseable", () => {
	it("every line is valid JSON and conforms to SecurityEvent shape", async () => {
		makeEvent(logger);
		logger.emit({
			eventType: SecurityEventType.TOOL_EXECUTION,
			actor: "agent",
			resource: "/bin/ls",
			outcome: "success",
			metadata: { args: ["-la"] },
		});
		logger.emit({
			eventType: SecurityEventType.AUTH_FAILURE,
			actor: "unknown",
			resource: "/auth",
			outcome: "failure",
		});

		const today = new Date().toISOString().slice(0, 10);
		const logPath = path.join(tmpDir, `audit.${today}.log`);
		const contents = await fs.readFile(logPath, "utf8");
		const lines = contents.split("\n").filter(l => l.length > 0);

		expect(lines.length).toBe(3);

		for (const line of lines) {
			// Must not throw
			const parsed = JSON.parse(line) as Record<string, unknown>;
			expect(typeof parsed.eventId).toBe("string");
			expect(typeof parsed.timestamp).toBe("string");
			expect(typeof parsed.eventType).toBe("string");
			expect(typeof parsed.actor).toBe("string");
			expect(typeof parsed.resource).toBe("string");
			expect(typeof parsed.outcome).toBe("string");
			expect(typeof parsed.prevHash).toBe("string");
		}
	});

	it("file ends with a newline so every line is separated", async () => {
		makeEvent(logger);
		makeEvent(logger);

		const today = new Date().toISOString().slice(0, 10);
		const logPath = path.join(tmpDir, `audit.${today}.log`);
		const contents = await fs.readFile(logPath, "utf8");

		expect(contents.endsWith("\n")).toBe(true);
		// No blank lines in the middle
		const nonEmpty = contents.split("\n").filter(l => l.length > 0);
		expect(nonEmpty.length).toBe(2);
	});
});
