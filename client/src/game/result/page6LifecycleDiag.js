/**
 * R12.5E — Page6 recovery / Result Session lifecycle diagnostics (client).
 * Observation only. Does not change navigation or countdown behavior.
 */

import { forwardPage6ClientDiag } from "./page6ClientDiagForwarder.js";

const PREFIX = "[R12.5E Page6]";

const lastFingerprintByKey = new Map();

/**
 * @param {string} event
 * @param {Record<string, unknown>} fields
 * @param {{ key?: string, force?: boolean }} [options]
 */
export function page6LifecycleDiag(event, fields = {}, options = {}) {

    const payload = {
        event,
        ts: Date.now(),
        ...sanitizePage6DiagFields(fields)
    };

    const key = options.key ?? event;

    const fingerprint = JSON.stringify(payload);

    if (!options.force && lastFingerprintByKey.get(key) === fingerprint) {

        return payload;

    }

    lastFingerprintByKey.set(key, fingerprint);

    console.info(PREFIX, payload);

    try {

        forwardPage6ClientDiag(event, payload, { force: options.force === true });

    } catch {

        // Diagnostics must never throw into UI paths.

    }

    return payload;

}

export function sanitizePage6DiagFields(fields = {}) {

    const out = {};

    for (const [key, value] of Object.entries(fields)) {

        if (value === undefined) {

            continue;

        }

        if (
            key === "wallet"
            || key === "mnemonic"
            || key === "privateKey"
            || key === "token"
            || key === "accessToken"
            || key === "refreshToken"
        ) {

            continue;

        }

        if (typeof value === "number" && !Number.isFinite(value)) {

            out[key] = null;

            continue;

        }

        out[key] = value;

    }

    return out;

}

/**
 * Classify InfoBar footer mode without changing selection logic.
 */
export function classifyInfoBarFooterMode({
    currentPage,
    onResultPage,
    onGameplayPage
}) {

    if (onResultPage === true || currentPage === 8) {

        return "PAGE6_NEUTRAL";

    }

    if (onGameplayPage === true || currentPage === 7) {

        return "PAGE5_RESULT_OR_GAMEPLAY";

    }

    return "SETUP_OR_OTHER";

}

/**
 * Reset dedupe map (tests only).
 */
export function resetPage6LifecycleDiagForTests() {

    lastFingerprintByKey.clear();

}
