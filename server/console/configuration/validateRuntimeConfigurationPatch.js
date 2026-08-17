/**
 * R17.9G.1 — Validate administrator runtime configuration patches.
 */

import { RUNTIME_CONFIG_EDITABLE_KEYS } from "./runtimeConfigurationKeys.js";

const TIMER_KEYS = new Set([
    "setupTimeoutMs",
    "paymentTimeoutMs",
    "countdownDurationMs",
    "brakeDurationMs",
    "settlementTimeoutMs"
]);

/**
 * Flatten UI / API payload into editable key map.
 * @param {unknown} body
 * @returns {Record<string, unknown>}
 */
function flattenPatchBody(body) {

    const flat = {};

    if (!body || typeof body !== "object" || Array.isArray(body)) {

        return flat;

    }

    const root = body.values && typeof body.values === "object"
        ? body.values
        : body;

    for (const key of RUNTIME_CONFIG_EDITABLE_KEYS) {

        if (root[key] !== undefined && root[key] !== null && root[key] !== "") {

            flat[key] = root[key];

        }

    }

    if (root.timers && typeof root.timers === "object") {

        const timers = root.timers;

        if (timers.setupTimeoutMs != null) {

            flat.setupTimeoutMs = timers.setupTimeoutMs;

        }

        if (timers.paymentTimeoutMs != null) {

            flat.paymentTimeoutMs = timers.paymentTimeoutMs;

        }

        if (timers.countdownDurationMs != null) {

            flat.countdownDurationMs = timers.countdownDurationMs;

        }

        if (timers.brakeDurationMs != null) {

            flat.brakeDurationMs = timers.brakeDurationMs;

        }

        if (timers.settlementTimeoutMs != null) {

            flat.settlementTimeoutMs = timers.settlementTimeoutMs;

        }

        if (timers.verifyTimeoutMs != null || timers.verifyTimeoutSec != null) {

            flat.__verifyAttempt = true;

        }

    }

    if (root.financial && typeof root.financial === "object") {

        const financial = root.financial;

        if (financial.baseStake1Gram != null) {

            flat.baseStake1Gram = financial.baseStake1Gram;

        }

        if (financial.baseStake2Gram != null) {

            flat.baseStake2Gram = financial.baseStake2Gram;

        }

        if (financial.ownerFeePercent != null) {

            flat.ownerFeePercent = financial.ownerFeePercent;

        }

    }

    if (root.verifyTimeoutMs != null || root.verifyTimeoutSec != null) {

        flat.__verifyAttempt = true;

    }

    return flat;

}

/**
 * @param {unknown} body
 * @returns {{
 *   ok: boolean,
 *   patch?: Record<string, number>,
 *   error?: string,
 *   details?: string[]
 * }}
 */
export function validateRuntimeConfigurationPatch(body) {

    if (!body || typeof body !== "object" || Array.isArray(body)) {

        return {
            ok: false,
            error: "Request body must be an object"
        };

    }

    const flat = flattenPatchBody(body);
    const details = [];

    if (flat.__verifyAttempt) {

        details.push("Verify Timer is not editable (inherits Setup Timer)");

        delete flat.__verifyAttempt;

    }

    const patch = {};

    for (const [key, raw] of Object.entries(flat)) {

        if (!RUNTIME_CONFIG_EDITABLE_KEYS.includes(key)) {

            details.push(`Unsupported key: ${key}`);

            continue;

        }

        const n = Number(raw);

        if (!Number.isFinite(n)) {

            details.push(`${key} must be a finite number`);

            continue;

        }

        if (TIMER_KEYS.has(key)) {

            if (n <= 0) {

                details.push(`${key} must be a positive number`);

                continue;

            }

            patch[key] = Math.round(n);

            continue;

        }

        if (key === "ownerFeePercent") {

            if (n < 0 || n > 100) {

                details.push("ownerFeePercent must be between 0 and 100");

                continue;

            }

            // Maximum 2 decimal places (0.01% precision). Do not coerce 5.123 → 5.12.
            const scaled = n * 100;
            const nearest = Math.round(scaled);

            if (Math.abs(scaled - nearest) > 1e-6) {

                details.push(
                    "ownerFeePercent allows at most 2 decimal places"
                );

                continue;

            }

            patch[key] = nearest / 100;

            continue;

        }

        if (key === "baseStake1Gram" || key === "baseStake2Gram") {

            if (n <= 0) {

                details.push(`${key} must be a positive number`);

                continue;

            }

            patch[key] = Math.round(n * 1000) / 1000;

        }

    }

    if (details.length > 0) {

        return {
            ok: false,
            error: "Validation failed",
            details
        };

    }

    if (Object.keys(patch).length === 0) {

        return {
            ok: false,
            error: "No editable parameters provided"
        };

    }

    if (patch.baseStake1Gram !== undefined
        && patch.baseStake2Gram !== undefined
        && patch.baseStake1Gram === patch.baseStake2Gram) {

        return {
            ok: false,
            error: "Validation failed",
            details: ["baseStake1Gram and baseStake2Gram must differ"]
        };

    }

    return {
        ok: true,
        patch
    };

}
