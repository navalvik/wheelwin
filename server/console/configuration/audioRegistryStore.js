/**
 * R17.9I.4 — Durable Audio Registry overrides (enabled / loop only).
 * Never stores secrets. Static defaults remain in audioRegistryEntries.js.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AUDIO_REGISTRY_EDITABLE_FIELDS } from "./audioRegistryKeys.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const DEFAULT_STATE_PATH = resolve(
    MODULE_DIR,
    "../../runtime/audio-registry-runtime.json"
);

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveAudioRegistryStatePath(env = process.env) {

    const configured = String(env.AUDIO_REGISTRY_STATE_PATH || "").trim();

    return configured || DEFAULT_STATE_PATH;

}

/**
 * @param {unknown} raw
 * @returns {Record<string, object>}
 */
function normalizeOverrides(raw) {

    const overrides = {};

    if (!raw || typeof raw !== "object") {

        return overrides;

    }

    for (const [id, patch] of Object.entries(raw)) {

        const key = String(id ?? "").trim();

        if (!key || !patch || typeof patch !== "object") {

            continue;

        }

        const entry = {};

        if (Object.prototype.hasOwnProperty.call(patch, "enabled")) {

            entry.enabled = patch.enabled === true;

        }

        if (Object.prototype.hasOwnProperty.call(patch, "loop")) {

            entry.loop = patch.loop === true;

        }

        if (Object.keys(entry).length > 0) {

            overrides[key] = Object.freeze(entry);

        }

    }

    return overrides;

}

/**
 * @param {unknown} raw
 * @returns {object|null}
 */
function normalizeDocument(raw) {

    if (!raw || typeof raw !== "object") {

        return null;

    }

    const configVersion = Number(raw.configVersion);

    return Object.freeze({
        schemaVersion: 1,
        configVersion: Number.isFinite(configVersion) && configVersion >= 0
            ? Math.floor(configVersion)
            : 0,
        overrides: Object.freeze(normalizeOverrides(raw.overrides)),
        updatedAt: raw.updatedAt ?? null,
        updatedBy: raw.updatedBy ?? null
    });

}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object|null}
 */
export function readAudioRegistryState(env = process.env) {

    const statePath = resolveAudioRegistryStatePath(env);

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
 *   overrides: Record<string, object>,
 *   updatedBy?: string|null
 * }} state
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object}
 */
export function writeAudioRegistryState(state, env = process.env) {

    const statePath = resolveAudioRegistryStatePath(env);

    mkdirSync(dirname(statePath), { recursive: true });

    const overrides = {};

    for (const [id, patch] of Object.entries(state.overrides ?? {})) {

        const cleaned = {};

        for (const field of AUDIO_REGISTRY_EDITABLE_FIELDS) {

            if (!Object.prototype.hasOwnProperty.call(patch, field)) {

                continue;

            }

            cleaned[field] = patch[field] === true;

        }

        if (Object.keys(cleaned).length > 0) {

            overrides[id] = cleaned;

        }

    }

    const payload = {
        schemaVersion: 1,
        configVersion: Math.floor(Number(state.configVersion) || 0),
        overrides,
        updatedAt: new Date().toISOString(),
        updatedBy: state.updatedBy ?? null
    };

    writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    return normalizeDocument(payload);

}
