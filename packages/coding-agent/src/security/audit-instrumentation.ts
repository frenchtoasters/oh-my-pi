import { emitSecurityEvent, SecurityEventType } from "@oh-my-pi/pi-utils";

/**
 * Emit audit event for tool execution start.
 */
export function auditToolExecution(tool: string, command: string, cwd?: string): void {
	emitSecurityEvent(SecurityEventType.TOOL_EXECUTION, `${tool}:${command}`, "success", {
		tool,
		command: command.slice(0, 500), // Truncate for audit log size
		cwd,
	});
}

/**
 * Emit audit event for blocked tool execution.
 */
export function auditToolBlocked(tool: string, command: string, reason: string): void {
	emitSecurityEvent(SecurityEventType.TOOL_BLOCKED, `${tool}:${command}`, "blocked", {
		tool,
		command: command.slice(0, 500),
		reason,
	});
}

/**
 * Emit audit event for session lifecycle.
 */
export function auditSessionStart(sessionId: string, metadata?: Record<string, unknown>): void {
	emitSecurityEvent(SecurityEventType.SESSION_START, sessionId, "success", metadata);
}

export function auditSessionEnd(sessionId: string, metadata?: Record<string, unknown>): void {
	emitSecurityEvent(SecurityEventType.SESSION_END, sessionId, "success", metadata);
}

/**
 * Emit audit event for credential access.
 */
export function auditCredentialAccess(provider: string, operation: "read" | "write" | "delete"): void {
	const eventType = operation === "read" ? SecurityEventType.CREDENTIAL_ACCESS : SecurityEventType.CREDENTIAL_MODIFY;
	emitSecurityEvent(eventType, provider, "success", { operation });
}

/**
 * Emit audit event for configuration changes.
 */
export function auditConfigChange(key: string, oldValue?: unknown, newValue?: unknown): void {
	emitSecurityEvent(SecurityEventType.CONFIG_CHANGE, key, "success", {
		oldValue: oldValue !== undefined ? String(oldValue) : undefined,
		newValue: newValue !== undefined ? String(newValue) : undefined,
	});
}

/**
 * Emit audit event for permission denied.
 */
export function auditPermissionDenied(resource: string, reason: string): void {
	emitSecurityEvent(SecurityEventType.PERMISSION_DENIED, resource, "failure", { reason });
}
