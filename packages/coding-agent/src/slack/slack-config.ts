/**
 * Configuration types and validation for the Slack bridge.
 */

import { logger } from "@oh-my-pi/pi-utils";

export interface SlackBridgeConfig {
	/** App-level token (xapp-*) for Socket Mode connection */
	appToken: string;
	/** Bot OAuth token (xoxb-*) for Web API calls */
	botToken: string;
	/** Channel ID to bind to */
	channelId: string;
	/** Existing thread TS to reuse (avoids creating a new thread on reconnect) */
	threadTs?: string;
}

/**
 * Resolve Slack bridge configuration from environment variables and settings.
 * Environment variables take precedence over stored settings.
 */
export function resolveSlackConfig(settingsGet: (key: string) => unknown): SlackBridgeConfig | null {
	const appToken = process.env.SLACK_APP_TOKEN ?? (settingsGet("slack.appToken") as string | undefined);
	const botToken = process.env.SLACK_BOT_TOKEN ?? (settingsGet("slack.botToken") as string | undefined);
	const channelId = process.env.SLACK_CHANNEL_ID ?? (settingsGet("slack.channelId") as string | undefined);

	if (!appToken || !botToken || !channelId) {
		const missing: string[] = [];
		if (!appToken) missing.push("SLACK_APP_TOKEN / slack.appToken");
		if (!botToken) missing.push("SLACK_BOT_TOKEN / slack.botToken");
		if (!channelId) missing.push("SLACK_CHANNEL_ID / slack.channelId");
		logger.warn("Slack bridge config incomplete", { missing });
		return null;
	}

	if (!appToken.startsWith("xapp-")) {
		logger.warn("Slack appToken should start with 'xapp-'", {});
		return null;
	}

	if (!botToken.startsWith("xoxb-")) {
		logger.warn("Slack botToken should start with 'xoxb-'", {});
		return null;
	}

	return { appToken, botToken, channelId };
}
