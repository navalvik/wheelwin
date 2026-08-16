/**
 * R17.9G.1 — Durable runtime configuration overrides (survives restart).
 * Never stores secrets or wallet mnemonics.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RUNTIME_CONFIG_EDITABLE_KEYS } from "./runtimeConfigurationKeys.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const DEFAULT_STATE_PATH = resolve(
    MODULE_DIR,
    "../../runtime/runtime-configuration.json"
);

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveRuntimeConfigurationPath(env = process.env) {

    const configured = String(env.RUNTIME_CONFIGURATION_STATE_PATH || "").trim();

    return configured || DEFAULT_STATE_PATH;

}

/**
 * @param {unknown} raw
 * @returns {object|null}
 */
function normalizeDocument(raw) {

    if (!raw || typeof raw !== "object") {

        return null;

    }

    const values = {};

    const source = raw.values && typeof raw.values === "object"
        ? raw.values
        : raw;

    for (const key of RUNTIME_CONFIG_EDITABLE_KEYS) {

        if (source[key] === undefined || source[key] === null) {

            continue;

        }

        const n = Number(source[key]);

        if (Number.isFinite(n)) {

            values[key] = n;

        }

    }

    const previousValues = {};

    if (raw.previousValues && typeof raw.previousValues === "object") {

        for (const key of RUNTIME_CONFIG_EDITABLE_KEYS) {

            if (raw.previousValues[key] === undefined
                || raw.previousValues[key] === null) {

                continue;

            }

            const n = Number(raw.previousValues[key]);

            if (Number.isFinite(n)) {

                previousValues[key] = n;

            }

        }

    }

    const configVersion = Number(raw.configVersion);

    return Object.freeze({
        schemaVersion: 1,
        configVersion: Number.isFinite(configVersion) && configVersion >= 0
            ? Math.floor(configVersion)
            : 0,
        values: Object.freeze({ ...values }),
        previousValues: Object.freeze({ ...previousValues }),
        updatedAt: raw.updatedAt ?? null,
        updatedBy: raw.updatedBy ?? null
    });

}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object|null}
 */
export function readRuntimeConfigurationState(env = process.env) {

    const statePath = resolveRuntimeConfigurationPath(env);

    if (!existsSync(statePath)) {

        return null;

    }

    try {

        const parsed = JSON.parse(readFileSync(statePath, "utf8"));

        return normalizeDocument(parsed);

    } catch {

        return null;

    }

}

/**
 * @param {{
 *   configVersion: number,
 *   values: Record<string, number>,
 *   previousValues?: Record<string, number>,
 *   updatedBy?: string|null
 * }} state
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object}
 */
export function writeRuntimeConfigurationState(state, env = process.env) {

    const statePath = resolveRuntimeConfigurationPath(env);

    mkdirSync(dirname(statePath), { recursive: true });

    const values = {};

    for (const key of RUNTIME_CONFIG_EDITABLE_KEYS) {

        if (state.values?.[key] === undefined || state.values?.[key] === null) {

            continue;

        }

        values[key] = Number(state.values[key]);

    }

    const previousValues = {};

    for (const key of RUNTIME_CONFIG_EDITABLE_KEYS) {

        if (state.previousValues?.[key] === undefined
            || state.previousValues?.[key] === null) {

            continue;

        }

        previousValues[key] = Number(state.previousValues[key]);

    }

    const payload = {
        schemaVersion: 1,
        configVersion: Math.floor(Number(state.configVersion) || 0),
        values,
        previousValues,
        updatedAt: new Date().toISOString(),
        updatedBy: state.updatedBy ?? null
    };

    writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    return normalizeDocument(payload);

}
