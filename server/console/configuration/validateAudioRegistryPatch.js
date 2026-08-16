/**
 * R17.9I.4 — Validate Audio Registry administrator patches.
 * Only enabled / loop may change.
 */

import { AUDIO_REGISTRY_EDITABLE_FIELDS } from "./audioRegistryKeys.js";
import { INITIAL_AUDIO_REGISTRY_ENTRIES } from "./audioRegistryEntries.js";

const KNOWN_IDS = new Set(
    INITIAL_AUDIO_REGISTRY_ENTRIES.map((entry) => entry.id)
);

/**
 * @param {unknown} body
 * @returns {{
 *   ok: boolean,
 *   patches?: Record<string, { enabled?: boolean, loop?: boolean }>,
 *   error?: string,
 *   details?: string[]
 * }}
 */
export function validateAudioRegistryPatch(body) {

    if (!body || typeof body !== "object" || Array.isArray(body)) {

        return {
            ok: false,
            error: "Request body must be an object"
        };

    }

    const details = [];
    const patches = {};

    const list = Array.isArray(body.entries)
        ? body.entries
        : (body.patches && typeof body.patches === "object"
            ? Object.entries(body.patches).map(([id, patch]) => ({
                id,
                ...(patch && typeof patch === "object" ? patch : {})
            }))
            : null);

    if (!list) {

        return {
            ok: false,
            error: "Provide entries[] or patches{} with editable fields"
        };

    }

    for (const raw of list) {

        if (!raw || typeof raw !== "object") {

            details.push("Each patch must be an object");

            continue;

        }

        const id = String(raw.id ?? raw.eventId ?? "").trim();

        if (!id) {

            details.push("id is required");

            continue;

        }

        if (!KNOWN_IDS.has(id)) {

            details.push(`Unknown id: ${id}`);

            continue;

        }

        if (Object.prototype.hasOwnProperty.call(raw, "file")
            || Object.prototype.hasOwnProperty.call(raw, "audioFile")
            || Object.prototype.hasOwnProperty.call(raw, "category")) {

            details.push(`${id}: file and category are immutable`);

            continue;

        }

        if (Object.prototype.hasOwnProperty.call(raw, "volume")) {

            details.push(`${id}: volume is not editable in R17.9I.4`);

            continue;

        }

        const patch = {};

        for (const key of Object.keys(raw)) {

            if (key === "id" || key === "eventId") {

                continue;

            }

            if (!AUDIO_REGISTRY_EDITABLE_FIELDS.includes(key)) {

                details.push(`${id}: unsupported field ${key}`);

                continue;

            }

            if (typeof raw[key] !== "boolean") {

                details.push(`${id}.${key} must be a boolean`);

                continue;

            }

            patch[key] = raw[key];

        }

        if (Object.keys(patch).length === 0) {

            details.push(`${id}: no editable fields provided`);

            continue;

        }

        patches[id] = {
            ...(patches[id] ?? {}),
            ...patch
        };

    }

    if (details.length > 0) {

        return {
            ok: false,
            error: "Validation failed",
            details
        };

    }

    if (Object.keys(patches).length === 0) {

        return {
            ok: false,
            error: "No editable parameters provided"
        };

    }

    return {
        ok: true,
        patches
    };

}
