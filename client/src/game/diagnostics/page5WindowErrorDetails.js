const ALLOWED_ERROR_NAMES = new Set([
    "TypeError", "ReferenceError", "RangeError", "SyntaxError", "Error"
]);

const SENSITIVE_ASSIGNMENT = /\b(api[_-]?key|access[_-]?key|secret|token|password|mnemonic|authorization|private[_-]?key)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const QUERY_VALUE = /([?&][^=&\s]+)=([^&#\s]*)/g;
const BEARER_VALUE = /\bBearer\s+[^\s,;]+/gi;
const URL_CREDENTIALS = /(https?:\/\/)[^/\s@]+:[^/\s@]+@/gi;

function sanitizeText(value, maxLength) {
    if (typeof value !== "string" || value.length === 0) return null;
    return value
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .replace(BEARER_VALUE, "Bearer [REDACTED]")
        .replace(URL_CREDENTIALS, "$1[REDACTED]@")
        .replace(QUERY_VALUE, "$1=[REDACTED]")
        .replace(SENSITIVE_ASSIGNMENT, "$1$2[REDACTED]")
        .slice(0, maxLength);
}

function safePhase(value) {
    return typeof value === "string" && /^[A-Z0-9_]{1,40}$/.test(value)
        ? value
        : null;
}

/** Builds bounded, redacted details for the existing Page5 window error event. */
export function buildPage5WindowErrorDiagnostic(event, current = null) {
    const rawName = event?.error?.name;
    const errorName = ALLOWED_ERROR_NAMES.has(rawName) ? rawName : "Unknown";
    const phase = safePhase(current?.clock?.phase)
        ?? safePhase(current?.gameState);

    return {
        kind: "client_error",
        reason: "window_error",
        errorName,
        errorMessage: sanitizeText(
            event?.error?.message ?? event?.message,
            512
        ),
        errorStack: sanitizeText(event?.error?.stack, 2048),
        errorFile: sanitizeText(event?.filename, 256),
        errorLine: Number.isInteger(event?.lineno) && event.lineno >= 0
            ? event.lineno : null,
        errorColumn: Number.isInteger(event?.colno) && event.colno >= 0
            ? event.colno : null,
        phase,
        displayedPhase: safePhase(current?.gameState)
    };
}
