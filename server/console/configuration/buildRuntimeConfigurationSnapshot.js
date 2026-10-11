/**
 * R17.9G / R17.9G.1 — Runtime Configuration snapshot for Developer Console.
 *
 * Observes authoritative loaders / catalogs + durable overrides.
 * Viewer responses redact editable fields.
 */

import {
    RUNTIME_CONFIG_EDITABLE_KEYS
} from "./runtimeConfigurationKeys.js";

/**
 * @param {number} ms
 * @returns {number|null}
 */
function msToSeconds(ms) {

    const n = Number(ms);

    if (!Number.isFinite(n) || n < 0) {

        return null;

    }

    return Math.round(n / 1000);

}

/**
 * @param {number|null|undefined} override
 * @param {number|null|undefined} fallback
 * @returns {number|null}
 */
function pickMs(override, fallback) {

    if (Number.isFinite(Number(override)) && Number(override) > 0) {

        return Number(override);

    }

    if (Number.isFinite(Number(fallback)) && Number(fallback) > 0) {

        return Number(fallback);

    }

    return null;

}

/**
 * Build runtime configuration DTO for GET /console/configuration/runtime.
 *
 * @param {{
 *   runtimeConfig?: {
 *     rooms?: object,
 *     gameplayPhases?: object
 *   }|null,
 *   env?: NodeJS.ProcessEnv,
 *   overrides?: Record<string, number>|null,
 *   configVersion?: number|null,
 *   canEdit?: boolean
 * }} [options]
 * @returns {object}
 */
export function buildRuntimeConfigurationSnapshot({
    runtimeConfig = null,
    env = process.env,
    overrides = null,
    configVersion = null,
    canEdit = false
} = {}) {

    const rooms = runtimeConfig?.rooms ?? {};
    const phases = runtimeConfig?.gameplayPhases ?? {};
    const ov = overrides && typeof overrides === "object" ? overrides : {};

    const setupTimeoutMs = pickMs(ov.setupTimeoutMs, rooms.setupDurationMs);
    const countdownDurationMs = pickMs(
        ov.countdownDurationMs,
        phases.readyDurationMs
    );
    const brakeDurationMs = pickMs(ov.brakeDurationMs, phases.brakeDurationMs);

    // Viewer: hide editable values completely.
    if (!canEdit) {

        return Object.freeze({
            schemaVersion: 1,
            readOnly: true,
            canEdit: false,
            generatedAt: Date.now(),
            configVersion: configVersion ?? null,
            applyScope: "next_game_initialization_only",
            notes: Object.freeze({
                access:
                    "Editable Runtime Configuration values require Administrator."
            }),
            timers: null,
            editable: Object.freeze([])
        });

    }

    return Object.freeze({
        schemaVersion: 1,
        readOnly: false,
        canEdit: true,
        generatedAt: Date.now(),
        configVersion: configVersion ?? null,
        applyScope: "next_game_initialization_only",
        notes: Object.freeze({
            verifyTimeout:
                "No separate VERIFY_DURATION_MS. VERIFY rides the Setup Timer.",
            countdown:
                "Displayed as READY phase duration (server GameClock READY).",
            mutation:
                "Changes apply to the next GAME_INITIALIZED snapshot only."
        }),
        editable: Object.freeze([...RUNTIME_CONFIG_EDITABLE_KEYS]),
        timers: Object.freeze({
            setupTimeoutMs,
            setupTimeoutSec: msToSeconds(setupTimeoutMs),
            verifyTimeoutMs: setupTimeoutMs,
            verifyTimeoutSec: msToSeconds(setupTimeoutMs),
            verifyTimeoutSource: "setupTimeout",
            verifyEditable: false,
            resultSessionTimeoutMs: Number(rooms.resultSessionDurationMs) || null,
            resultSessionTimeoutSec: msToSeconds(rooms.resultSessionDurationMs),
            countdownDurationMs,
            countdownDurationSec: msToSeconds(countdownDurationMs),
            preGameReadyDurationMs: Number(phases.preGameReadyDurationMs) || null,
            preGameReadyDurationSec: msToSeconds(phases.preGameReadyDurationMs),
            selfTestDurationMs: Number(phases.selfTestDurationMs) || null,
            selfTestDurationSec: msToSeconds(phases.selfTestDurationMs),
            speedDurationMs: Number(phases.speedDurationMs) || null,
            speedDurationSec: msToSeconds(phases.speedDurationMs),
            brakeDurationMs,
            brakeDurationSec: msToSeconds(brakeDurationMs),
            resultPhaseDurationMs: Number(phases.resultDurationMs) || null,
            resultPhaseDurationSec: msToSeconds(phases.resultDurationMs)
        })
    });

}