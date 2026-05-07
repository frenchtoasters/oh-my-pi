#!/usr/bin/env bun
import * as readline from "node:readline";
import { AuthCredentialStore } from "./auth-storage";
import { getOAuthProviders } from "./utils/oauth";

const PROVIDERS = getOAuthProviders();

async function maskedPrompt(question: string): Promise<string> {
	const { stdin, stdout } = process;
	stdout.write(`${question} `);

	if (!stdin.isTTY) {
		// Non-interactive: fall back to reading a line from stdin
		const rl = readline.createInterface({ input: stdin, output: stdout });
		const line = await new Promise<string>(resolve => rl.question("", resolve));
		rl.close();
		return line;
	}

	const { promise, resolve } = Promise.withResolvers<string>();
	const raw = stdin.isRaw;
	stdin.setRawMode(true);
	stdin.resume();

	let input = "";
	const onData = (buf: Buffer) => {
		const ch = buf.toString("utf8");
		for (const c of ch) {
			if (c === "\r" || c === "\n") {
				stdout.write("\n");
				stdin.setRawMode(raw);
				stdin.pause();
				stdin.removeListener("data", onData);
				resolve(input);
				return;
			}
			if (c === "\x03") {
				// Ctrl+C
				stdout.write("\n");
				stdin.setRawMode(raw);
				stdin.pause();
				stdin.removeListener("data", onData);
				resolve("");
				return;
			}
			if (c === "\x7f" || c === "\b") {
				// Backspace
				if (input.length > 0) {
					input = input.slice(0, -1);
					stdout.write("\b \b");
				}
			} else if (c >= " ") {
				input += c;
				stdout.write("*");
			}
		}
	};
	stdin.on("data", onData);
	return promise;
}

/**
 * Authenticate with the given provider. Currently only "litellm" is supported;
 * the parameter exists for forward compatibility with additional providers.
 */
async function login(provider: "litellm"): Promise<void> {
	const storage = await AuthCredentialStore.open();

	try {
		const apiKey = await maskedPrompt("Enter LiteLLM API key:");
		if (!apiKey) {
			console.log("No API key provided. Login cancelled.");
			return;
		}
		storage.saveApiKey(provider, apiKey);
		console.log(`\nAPI key saved to ~/.omp/agent/agent.db`);
	} finally {
		storage.close();
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];

	if (!command || command === "help" || command === "--help" || command === "-h") {
		console.log(`Usage: bunx @oh-my-pi/pi-ai <command> [provider]

Commands:
  login [provider]  Login to a provider (default: litellm)
  logout [provider] Logout from a provider (default: litellm)
  status            Show logged-in providers
  list              List available providers

Provider:
  litellm           LiteLLM (default)

Other providers are configured via LITELLM_BASE_URL environment variable.

Examples:
  bunx @oh-my-pi/pi-ai login              # login to litellm
  bunx @oh-my-pi/pi-ai login litellm      # login to litellm (explicit)
  bunx @oh-my-pi/pi-ai logout             # logout from litellm
  bunx @oh-my-pi/pi-ai status             # show logged-in providers
`);
		return;
	}

	if (command === "status") {
		const storage = await AuthCredentialStore.open();
		try {
			const providers = storage.listProviders();
			if (providers.length === 0) {
				console.log("No credentials stored.");
				console.log(`Use 'bunx @oh-my-pi/pi-ai login' to authenticate.`);
			} else {
				console.log("Logged-in providers:\n");
				for (const provider of providers) {
					const oauth = storage.getOAuth(provider);
					if (oauth) {
						const expires = new Date(oauth.expires);
						const expired = Date.now() >= oauth.expires;
						const status = expired ? "(expired)" : `(expires ${expires.toLocaleString()})`;
						console.log(`  ${provider.padEnd(20)} ${status}`);
						continue;
					}
					const apiKey = storage.getApiKey(provider);
					if (apiKey) {
						console.log(`  ${provider.padEnd(20)} (api key)`);
					}
				}
			}
		} finally {
			storage.close();
		}
		return;
	}

	if (command === "list") {
		console.log("Available model providers (accessed via LiteLLM proxy):\n");
		for (const p of PROVIDERS) {
			const suffix = p.id === "litellm" ? " (login supported)" : "";
			console.log(`  ${p.id.padEnd(20)} ${p.name}${suffix}`);
		}
		console.log("\nLogin is only supported for litellm. Other providers are configured via LITELLM_BASE_URL.");
		return;
	}

	if (command === "logout") {
		const provider = (args[1] ?? "litellm") as string;

		if (provider !== "litellm") {
			console.error(
				"Only LiteLLM provider logout is supported. Configure other providers via LITELLM_BASE_URL environment variable.",
			);
			process.exit(1);
		}

		const storage = await AuthCredentialStore.open();
		try {
			const oauth = storage.getOAuth("litellm");
			const apiKey = storage.getApiKey("litellm");
			if (!oauth && !apiKey) {
				console.error(`Not logged in to litellm`);
				process.exit(1);
			}
			storage.deleteProvider("litellm");
			console.log(`Logged out from litellm`);
		} finally {
			storage.close();
		}
		return;
	}

	if (command === "login") {
		const provider = (args[1] ?? "litellm") as string;

		if (provider !== "litellm") {
			console.error(
				"Only LiteLLM provider login is supported. Configure other providers via LITELLM_BASE_URL environment variable.",
			);
			process.exit(1);
		}

		console.log(`Logging in to litellm…`);
		await login("litellm");
		return;
	}

	console.error(`Unknown command: ${command}`);
	console.error(`Use 'bunx @oh-my-pi/pi-ai --help' for usage`);
	process.exit(1);
}

main().catch(err => {
	console.error("Error:", err.message);
	process.exit(1);
});
