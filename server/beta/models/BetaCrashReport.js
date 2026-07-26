/**
 * R8.0D — Crash / fatal report with sensitive-data redaction.
 */

let _seq = 0;

const SENSITIVE_PATTERNS = [
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    /\b(?:UQ|EQ)[A-Za-z0-9_-]{46}\b/g,
    /\b(?:sk|pk|api[_-]?key|secret|token|password|mnemonic)\s*[:=]\s*\S+/gi,
    /\b0x[a-fA-F0-9]{40}\b/g
];

/**
 * @param {string} text
 */
export function redactSensitiveText(text) {

    let out = String(text ?? "");

    for (const pattern of SENSITIVE_PATTERNS) {

        out = out.replace(pattern, "[REDACTED]");

    }

    return out.slice(0, 8000);

}

function nextId() {

    _seq += 1;

    return `beta-c-${Date.now().toString(36)}-${_seq}`;

}

/**
 * @param {{
 *   id?: string,
 *   timestamp?: number,
 *   source?: string,
 *   kind?: string,
 *   message?: string,
 *   stack?: string|null,
 *   environment?: object|null,
 *   participantId?: string|null,
 *   rcVersion?: string|null,
 *   fatal?: boolean
 * }} input
 */
export function createBetaCrashReport(input = {}) {

    const environment = input.environment && typeof input.environment === "object"
        ? Object.freeze({
            nodeEnv: input.environment.nodeEnv
                ? String(input.environment.nodeEnv).slice(0, 32)
                : null,
            profile: input.environment.profile
                ? String(input.environment.profile).slice(0, 32)
                : null,
            platform: input.environment.platform
                ? String(input.environment.platform).slice(0, 32)
                : (typeof process !== "undefined" ? process.platform : null),
            nodeVersion: input.environment.nodeVersion
                ? String(input.environment.nodeVersion).slice(0, 32)
                : (typeof process !== "undefined" ? process.version : null)
        })
        : null;

    return Object.freeze({
        id: input.id ? String(input.id) : nextId(),
        timestamp: Number.isFinite(input.timestamp)
            ? input.timestamp
            : Date.now(),
        source: String(input.source || "server").slice(0, 32),
        kind: String(input.kind || "exception").slice(0, 64),
        message: redactSensitiveText(input.message || "Unknown crash"),
        stack: input.stack
            ? redactSensitiveText(input.stack)
            : null,
        environment,
        participantId: input.participantId
            ? String(input.participantId).slice(0, 64)
            : null,
        rcVersion: input.rcVersion
            ? String(input.rcVersion).slice(0, 64)
            : null,
        fatal: input.fatal === true
    });

}

export function resetCrashIdSequenceForTests() {

    _seq = 0;

}
