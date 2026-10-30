import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sandbox from "@oh-my-pi/pi-coding-agent/security/sandbox";
import { Snowflake } from "@oh-my-pi/pi-utils";

// An allowlist profile claims a shared, refcounted proxy. These tests defend
// that every claim is released exactly once: a leaked claim keeps the proxy
// alive forever, an extra release shuts it down under a peer session.

async function isListening(port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = net.connect({ host: "127.0.0.1", port });
	socket.once("connect", () => {
		socket.destroy();
		resolve(true);
	});
	socket.once("error", () => resolve(false));
	return promise;
}

describe("createAgentSession sandbox proxy claim", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		sandbox.shutdownSandboxProxy();
	});

	function sessionOptions(extensions: ExtensionFactory[] = []) {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-sandbox-proxy-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd);
		return {
			cwd,
			agentDir: path.join(tempDir, "agent"),
			// `librarian` has an allowlist network profile, so it starts the proxy.
			agentDisplayName: "librarian",
			settings: Settings.isolated({ "security.sandbox": "warn" }),
			disableExtensionDiscovery: true,
			extensions,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		};
	}

	it("releases the proxy when startup fails after claiming it", async () => {
		const startSpy = spyOn(sandbox, "startSandboxProxy");
		try {
			const failingExtension: ExtensionFactory = () => {
				throw new Error("extension factory failed");
			};
			await expect(createAgentSession(sessionOptions([failingExtension]))).rejects.toThrow(
				"extension factory failed",
			);
			expect(startSpy).toHaveBeenCalledTimes(1);
			const { port } = startSpy.mock.results[0]?.value as { port: number };
			expect(await isListening(port)).toBe(false);
		} finally {
			startSpy.mockRestore();
		}
	});

	it("keeps the proxy for a peer when a session is disposed twice", async () => {
		const startSpy = spyOn(sandbox, "startSandboxProxy");
		try {
			const { session: first } = await createAgentSession(sessionOptions());
			const { session: second } = await createAgentSession(sessionOptions());
			const ports = startSpy.mock.results.map(result => (result.value as { port: number }).port);
			expect(ports).toHaveLength(2);
			expect(ports[0]).toBe(ports[1]);
			const port = ports[0];

			await first.dispose();
			await first.dispose();
			expect(await isListening(port)).toBe(true);

			await second.dispose();
			expect(await isListening(port)).toBe(false);
		} finally {
			startSpy.mockRestore();
		}
	});

	it("releases the proxy even when a shutdown hook never returns", async () => {
		const startSpy = spyOn(sandbox, "startSandboxProxy");
		try {
			const neverReturns: ExtensionFactory = pi => {
				pi.on("session_shutdown", () => new Promise<void>(() => {}));
			};
			const { session: peer } = await createAgentSession(sessionOptions());
			const { session: stuck } = await createAgentSession(sessionOptions([neverReturns]));
			const port = (startSpy.mock.results[0]?.value as { port: number }).port;

			// The caller does not wait for the stuck dispose (task/executor.ts abandons it).
			void stuck.dispose();
			await peer.dispose();
			expect(await isListening(port)).toBe(false);
		} finally {
			startSpy.mockRestore();
		}
	});

	it("kills background jobs before releasing the proxy they use", async () => {
		const startSpy = spyOn(sandbox, "startSandboxProxy");
		try {
			const hookGate = Promise.withResolvers<void>();
			const slowHook: ExtensionFactory = pi => {
				pi.on("session_shutdown", () => hookGate.promise);
			};
			const { session: peer } = await createAgentSession(sessionOptions());
			const { session: mine } = await createAgentSession({
				...sessionOptions([slowHook]),
				settings: Settings.isolated({ "security.sandbox": "warn", "async.enabled": true }),
			});
			const port = (startSpy.mock.results[0]?.value as { port: number }).port;
			const bash = mine.getToolByName("bash");
			if (!bash) throw new Error("bash tool not registered");
			const pidFile = path.join(os.tmpdir(), `pi-sdk-sandbox-proxy-job-${Snowflake.next()}.pid`);
			await bash.execute("call-1", {
				command: `sh -c 'echo $$ > "${pidFile}"; exec sleep 30'`,
				async: true,
			} as never);
			let pid = 0;
			while (!pid) {
				pid = Number.parseInt(
					(await Bun.file(pidFile)
						.text()
						.catch(() => "")) || "0",
					10,
				);
				if (!pid) await Bun.sleep(10);
			}
			fs.rmSync(pidFile, { force: true });
			const isAlive = (): boolean => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			};
			expect(isAlive()).toBe(true);

			// The shutdown hook stays blocked for the rest of the test.
			const disposing = mine.dispose();
			await peer.dispose();
			// Rule: once the proxy is down, the command that used it must already be gone.
			while (await isListening(port)) await Bun.sleep(5);
			expect(isAlive()).toBe(false);

			hookGate.resolve();
			await disposing;
		} finally {
			startSpy.mockRestore();
		}
	});
});
