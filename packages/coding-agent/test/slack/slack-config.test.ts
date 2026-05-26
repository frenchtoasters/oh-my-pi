import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveSlackConfig } from "@oh-my-pi/pi-coding-agent/slack/slack-config";

describe("resolveSlackConfig", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		delete process.env.SLACK_APP_TOKEN;
		delete process.env.SLACK_BOT_TOKEN;
		delete process.env.SLACK_CHANNEL_ID;
	});

	afterEach(() => {
		process.env.SLACK_APP_TOKEN = originalEnv.SLACK_APP_TOKEN;
		process.env.SLACK_BOT_TOKEN = originalEnv.SLACK_BOT_TOKEN;
		process.env.SLACK_CHANNEL_ID = originalEnv.SLACK_CHANNEL_ID;
	});

	test("returns null when no config is available", () => {
		const result = resolveSlackConfig(() => undefined);
		expect(result).toBeNull();
	});

	test("returns null when config is incomplete", () => {
		const settings: Record<string, string> = {
			"slack.appToken": "xapp-123",
			// missing botToken and channelId
		};
		const result = resolveSlackConfig(key => settings[key]);
		expect(result).toBeNull();
	});

	test("resolves from settings when all present", () => {
		const settings: Record<string, string> = {
			"slack.appToken": "xapp-valid-token",
			"slack.botToken": "xoxb-valid-token",
			"slack.channelId": "C12345",
		};
		const result = resolveSlackConfig(key => settings[key]);
		expect(result).toEqual({
			appToken: "xapp-valid-token",
			botToken: "xoxb-valid-token",
			channelId: "C12345",
		});
	});

	test("environment variables take precedence over settings", () => {
		process.env.SLACK_APP_TOKEN = "xapp-env-token";
		process.env.SLACK_BOT_TOKEN = "xoxb-env-token";
		process.env.SLACK_CHANNEL_ID = "C99999";

		const settings: Record<string, string> = {
			"slack.appToken": "xapp-settings-token",
			"slack.botToken": "xoxb-settings-token",
			"slack.channelId": "C11111",
		};
		const result = resolveSlackConfig(key => settings[key]);
		expect(result).toEqual({
			appToken: "xapp-env-token",
			botToken: "xoxb-env-token",
			channelId: "C99999",
		});
	});

	test("rejects invalid appToken prefix", () => {
		const settings: Record<string, string> = {
			"slack.appToken": "invalid-token",
			"slack.botToken": "xoxb-valid-token",
			"slack.channelId": "C12345",
		};
		const result = resolveSlackConfig(key => settings[key]);
		expect(result).toBeNull();
	});

	test("rejects invalid botToken prefix", () => {
		const settings: Record<string, string> = {
			"slack.appToken": "xapp-valid-token",
			"slack.botToken": "invalid-bot-token",
			"slack.channelId": "C12345",
		};
		const result = resolveSlackConfig(key => settings[key]);
		expect(result).toBeNull();
	});
});
