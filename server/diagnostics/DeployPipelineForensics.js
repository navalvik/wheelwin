/**
 * R7.11B — Temporary deploy-pipeline forensics (diagnostics only).
 * Shared stage timestamps so each log can report duration since previous stage.
 */

const _lastStageAtByRoom = new Map();
const _attemptByRoom = new Map();

/**
 * @param {string} roomId
 * @returns {number}
 */
export function nextDeployAttempt(roomId) {

    const key = String(roomId ?? "");
    const next = (_attemptByRoom.get(key) ?? 0) + 1;

    _attemptByRoom.set(key, next);

    return next;

}

/**
 * @param {string} roomId
 * @param {string} stage
 * @returns {{ now: number, elapsedMs: number|null }}
 */
export function markDeployStage(roomId, stage) {

    const key = String(roomId ?? "");
    const now = Date.now();
    const previous = _lastStageAtByRoom.get(key);
    const elapsedMs = previous ? now - previous.at : null;

    _lastStageAtByRoom.set(key, { at: now, stage });

    return { now, elapsedMs };

}

/**
 * @param {string} roomId
 * @returns {{ stage: string, at: number } | null}
 */
export function getLastDeployStage(roomId) {

    const key = String(roomId ?? "");

    return _lastStageAtByRoom.get(key) ?? null;

}

/**
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {string}
 */
export function safeSerialize(value, depth = 0) {

    if (value === null) {

        return "null";

    }

    if (value === undefined) {

        return "undefined";

    }

    if (depth > 4) {

        return "[MaxDepth]";

    }

    try {

        return JSON.stringify(value, (_key, nested) => {

            if (typeof nested === "bigint") {

                return String(nested);

            }

            if (nested instanceof Error) {

                return {
                    name: nested.name,
                    message: nested.message,
                    stack: nested.stack
                };

            }

            if (typeof nested === "function") {

                return `[Function ${nested.name || "anonymous"}]`;

            }

            return nested;

        }, 2);

    } catch (error) {

        return `[Unserializable: ${error?.message ?? error}]`;

    }

}

/**
 * @param {string} title
 * @param {Record<string, unknown>} fields
 */
export function printDeployBlock(title, fields) {

    console.log("======================================================");
    console.log(title);
    console.log("======================================================");

    for (const [key, value] of Object.entries(fields)) {

        if (value !== null && typeof value === "object") {

            console.log(`${key}:`, safeSerialize(value));

        } else {

            console.log(`${key}:`, value);

        }

    }

    console.log("======================================================");

}
