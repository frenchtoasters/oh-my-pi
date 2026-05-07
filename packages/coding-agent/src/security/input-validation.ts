/**
 * Input validation rules for tool arguments.
 *
 * NIST 800-53 SI-10: Information Input Validation
 * Pure validation functions with no side effects. Callers are responsible
 * for emitting audit events on validation failures.
 */

// =============================================================================
// Types
// =============================================================================

export interface ValidationResult {
	valid: boolean;
	reason?: string;
}

// =============================================================================
// Constants
// =============================================================================

/** 1 MiB — default maximum string input length */
const DEFAULT_MAX_STRING_LENGTH = 1_048_576;

/**
 * Pattern matching embedded newlines followed by non-whitespace content,
 * which is characteristic of newline-injection attacks (e.g. CRLF injection,
 * multi-command injection via `\n command`).
 */
const EMBEDDED_NEWLINE_COMMAND_RE = /[\r\n][\s\S]*\S/;

// =============================================================================
// Validators
// =============================================================================

/**
 * Validate a file path argument for safety.
 *
 * Rejects:
 * - Null bytes (obfuscation / path truncation attacks)
 * - Paths starting with `~root` or `/root` (privileged home directory access)
 * - Paths containing `..` segments that escape the current directory context
 *
 * Note: This is a syntactic check only. Callers should additionally resolve
 * the path and verify it is within an allowed root (see `ExecutionPolicy`).
 */
export function validateFilePath(filePath: string): ValidationResult {
	if (filePath.includes("\x00")) {
		return { valid: false, reason: "Path contains null bytes" };
	}

	// Detect traversal sequences. We check both raw and URL-decoded forms.
	// Note: Only a single URL-decode pass is applied. Double-encoding (e.g. %252e%252e)
	// will not be caught here. Callers must canonicalize paths via path.resolve() before
	// using them for filesystem access.
	let decoded: string;
	try {
		decoded = decodeURIComponent(filePath);
	} catch {
		decoded = filePath;
	}

	// Normalise separators to forward slash for uniform analysis
	const normalised = decoded.replace(/\\/g, "/");

	if (decoded.startsWith("~root") || decoded.startsWith("/root")) {
		return { valid: false, reason: "Path targets privileged home directory" };
	}

	// A path is suspicious if it contains any `..` component. We allow `..`
	// only when the path is fully relative (does not start with `/`) AND the
	// caller opts into it — but the conservative default is to reject any `..`
	// because the intent of this validator is to catch escaping attempts.
	if (/(?:^|\/)\.\.(\/|$)/.test(normalised)) {
		return { valid: false, reason: "Path contains directory traversal sequence (..)" };
	}

	return { valid: true };
}

/**
 * Validate a command argument for safety.
 *
 * **Note:** This validator is designed for single-line commands only.
 * Multi-line commands (heredocs, continuation lines, `-c` scripts)
 * will be rejected. Callers that accept multi-line input should either
 * skip this check or validate only the first line.
 *
 * Rejects:
 * - Null bytes
 * - Embedded newlines with non-whitespace content following them
 *   (newline injection / multi-command injection)
 */
export function validateCommand(command: string): ValidationResult {
	if (command.includes("\x00")) {
		return { valid: false, reason: "Command contains null bytes" };
	}

	if (EMBEDDED_NEWLINE_COMMAND_RE.test(command)) {
		return { valid: false, reason: "Command contains embedded newline with subsequent content" };
	}

	return { valid: true };
}

/**
 * Validate generic string input.
 *
 * Rejects:
 * - Null bytes
 * - Strings exceeding `maxLength` bytes (defaults to 1 MiB)
 *
 * @param input     - The string to validate.
 * @param maxLength - Maximum allowed byte length (UTF-8). Defaults to 1 MiB.
 */
export function validateStringInput(input: string, maxLength = DEFAULT_MAX_STRING_LENGTH): ValidationResult {
	if (input.includes("\x00")) {
		return { valid: false, reason: "Input contains null bytes" };
	}

	const byteLength = Buffer.byteLength(input, "utf8");
	if (byteLength > maxLength) {
		return {
			valid: false,
			reason: `Input exceeds maximum length: ${byteLength} bytes > ${maxLength} bytes`,
		};
	}

	return { valid: true };
}
