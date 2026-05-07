import { emitSecurityEvent, logger, SecurityEventType } from "@oh-my-pi/pi-utils";

import { MIN_TLS_VERSION } from "./crypto-policy";

/**
 * Returns fetch options that enforce TLS validation.
 * Used by providers to ensure rejectUnauthorized is never accidentally disabled.
 */
export function getTlsFetchOptions(allowSelfSigned = false): {
	tls: { rejectUnauthorized: boolean; minVersion: string };
} {
	if (allowSelfSigned) {
		logger.warn("TLS self-signed certificates allowed — reduced security");
	}
	return {
		tls: {
			rejectUnauthorized: !allowSelfSigned,
			minVersion: MIN_TLS_VERSION,
		},
	};
}

/**
 * Validates that NODE_TLS_REJECT_UNAUTHORIZED has not been set to '0'.
 * Emits INTEGRITY_VIOLATION audit event if it has been.
 */
export function validateTlsEnvironment(): boolean {
	if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
		emitSecurityEvent(SecurityEventType.INTEGRITY_VIOLATION, "NODE_TLS_REJECT_UNAUTHORIZED", "failure", {
			message: "TLS certificate validation has been globally disabled",
		});
		return false;
	}
	return true;
}
