import { beforeEach, describe, expect, it, vi } from "bun:test";
import * as piUtils from "@oh-my-pi/pi-utils";
import { ExecutionPolicy } from "../../src/security/execution-policy";

vi.spyOn(piUtils, "emitSecurityEvent").mockReturnValue({
	eventId: "",
	timestamp: "",
	eventType: piUtils.SecurityEventType.AUTH_SUCCESS,
	actor: "",
	resource: "",
	outcome: "success",
});

describe("ExecutionPolicy", () => {
	beforeEach(() => {
		vi.spyOn(piUtils, "emitSecurityEvent").mockReturnValue({
			eventId: "",
			timestamp: "",
			eventType: piUtils.SecurityEventType.AUTH_SUCCESS,
			actor: "",
			resource: "",
			outcome: "success",
		});
	});

	describe("permissive mode", () => {
		it("allows all commands", () => {
			const policy = new ExecutionPolicy({ mode: "permissive" }, "/test/cwd");
			expect(policy.checkCommand("curl http://evil.example").allowed).toBe(true);
			expect(policy.checkCommand("wget http://evil.example").allowed).toBe(true);
			expect(policy.checkCommand("ssh user@host").allowed).toBe(true);
			expect(policy.checkCommand("sudo rm -rf /").allowed).toBe(true);
		});

		it("checkFilePath in permissive allows all paths", () => {
			const policy = new ExecutionPolicy({ mode: "permissive" }, "/test/cwd");
			expect(policy.checkFilePath("/etc/passwd").allowed).toBe(true);
			expect(policy.checkFilePath("/tmp/outside").allowed).toBe(true);
			expect(policy.checkFilePath("/test/cwd/file.ts").allowed).toBe(true);
		});
	});

	describe("strict mode", () => {
		it("blocks network commands (curl, wget, ssh)", () => {
			const policy = new ExecutionPolicy({ mode: "strict" }, "/test/cwd");
			expect(policy.checkCommand("curl http://example.com").allowed).toBe(false);
			expect(policy.checkCommand("wget http://example.com").allowed).toBe(false);
			expect(policy.checkCommand("ssh user@host").allowed).toBe(false);
		});

		it("allows basic commands (ls, cat, echo)", () => {
			const policy = new ExecutionPolicy({ mode: "strict" }, "/test/cwd");
			expect(policy.checkCommand("ls -la").allowed).toBe(true);
			expect(policy.checkCommand("cat file.txt").allowed).toBe(true);
			expect(policy.checkCommand("echo hello").allowed).toBe(true);
		});

		it("with cwdOnly blocks paths outside cwd", () => {
			const policy = new ExecutionPolicy({ mode: "strict", cwdOnly: true }, "/test/cwd");
			const result = policy.checkFilePath("/etc/passwd");
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("/test/cwd");
		});

		it("allows paths within cwd", () => {
			const policy = new ExecutionPolicy({ mode: "strict", cwdOnly: true }, "/test/cwd");
			expect(policy.checkFilePath("/test/cwd/src/file.ts").allowed).toBe(true);
			expect(policy.checkFilePath("/test/cwd").allowed).toBe(true);
		});

		it("custom denyCommands extends block list", () => {
			const policy = new ExecutionPolicy({ mode: "strict", denyCommands: ["python"] }, "/test/cwd");
			// python is in the static allow list, but now explicitly denied
			const result = policy.checkCommand("python script.py");
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("python");
		});

		it("custom allowCommands overrides deny list", () => {
			const policy = new ExecutionPolicy({ mode: "strict", allowCommands: ["myapp"] }, "/test/cwd");
			// myapp not in default list — should be allowed via override
			expect(policy.checkCommand("myapp --run").allowed).toBe(true);
		});
	});
});
