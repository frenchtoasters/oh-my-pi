/**
 * System use notification for NIST AC-8 compliance.
 * Displays configurable security banner on session start.
 *
 * @nist AC-8 System Use Notification
 */

export interface BannerConfig {
	enabled: boolean;
	text?: string;
}

const DEFAULT_BANNER = "This system is for authorized use only. All activity is monitored and logged.";

/**
 * Returns the banner text to display, or null if banners are disabled.
 */
export function getSystemBanner(config?: Partial<BannerConfig>): string | null {
	if (config?.enabled === false) return null;
	return config?.text ?? DEFAULT_BANNER;
}

/**
 * Returns true if the banner should be shown for the given config.
 */
export function shouldShowBanner(config?: Partial<BannerConfig>): boolean {
	return config?.enabled !== false;
}
