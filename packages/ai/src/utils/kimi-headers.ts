/**
 * Kimi model-compat headers (device identification).
 * Extracted from oauth/kimi.ts — needed for Kimi models routed via LiteLLM.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import packageJson from "../../package.json" with { type: "json" };

const DEVICE_ID_FILENAME = "kimi-device-id";

function formatDeviceModel(system: string, release: string, arch: string): string {
	return [system, release, arch].filter(Boolean).join(" ").trim();
}

function getDeviceModel(): string {
	const platform = os.platform();
	const release = os.release();
	const arch = os.arch();
	if (platform === "darwin") return formatDeviceModel("macOS", release, arch);
	if (platform === "win32") return formatDeviceModel("Windows", release, arch);
	const label = platform === "linux" ? "Linux" : platform;
	return formatDeviceModel(label, release, arch);
}

let getDeviceId = (): string => {
	const deviceIdPath = path.join(getAgentDir(), DEVICE_ID_FILENAME);
	try {
		const existing = fs.readFileSync(deviceIdPath, "utf-8");
		const trimmed = existing.trim();
		if (trimmed) {
			getDeviceId = () => trimmed;
			return trimmed;
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	const deviceId = crypto.randomUUID().replace(/-/g, "");
	fs.writeFileSync(deviceIdPath, `${deviceId}\n`, { mode: 0o600 });
	getDeviceId = () => deviceId;
	return deviceId;
};

export let getKimiCommonHeaders = () => {
	const headers = Object.freeze({
		"User-Agent": `KimiCLI/${packageJson.version}`,
		"X-Msh-Platform": "kimi_cli",
		"X-Msh-Version": packageJson.version,
		"X-Msh-Device-Name": os.hostname(),
		"X-Msh-Device-Model": getDeviceModel(),
		"X-Msh-Os-Version": os.version(),
		"X-Msh-Device-Id": getDeviceId(),
	});
	getKimiCommonHeaders = () => headers;
	return headers;
};
