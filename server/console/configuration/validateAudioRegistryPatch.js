/**
 * R17.9I.3 — Validate Audio Registry administrator patches.
 * Only enabled / volume / loop may change.
 */

import { AUDIO_REGISTRY_EDITABLE_FIELDS } from "./audioRegistryKeys.js";
import { INITIAL_AUDIO_REGISTRY_ENTRIES } from "./audioRegistryEntries.js";

const KNOWN_EVENT_IDS = new Set(
    INITIAL_AUDIO_REGISTRY_ENTRIES.map((entry) => entry.eventId)
);

/**
 * @param {unknown} body
 * @returns {{
 *   ok: boolean,
 *   patches?: Record<string, { enabled?: boolean, volume?: number, loop?: boolean }>,
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
            ? Object.entries(body.patches).map(([eventId, patch]) => ({
                eventId,
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

        const eventId = String(raw.eventId ?? "").trim();

        if (!eventId) {

            details.push("eventId is required");

            continue;

        }

        if (!KNOWN_EVENT_IDS.has(eventId)) {

            details.push(`Unknown eventId: ${eventId}`);

            continue;

        }

        if (Object.prototype.hasOwnProperty.call(raw, "audioFile")
            || Object.prototype.hasOwnProperty.call(raw, "category")) {

            details.push(
                `${eventId}: audioFile and category are immutable`
            );

            continue;

        }

        const patch = {};

        for (const key of Object.keys(raw)) {

            if (key === "eventId") {

                continue;

            }

            if (!AUDIO_REGISTRY_EDITABLE_FIELDS.includes(key)) {

                details.push(`${eventId}: unsupported field ${key}`);

                continue;

            }

            if (key === "enabled" || key === "loop") {

                if (typeof raw[key] !== "boolean") {

                    details.push(`${eventId}.${key} must be a boolean`);

                    continue;

                }

                patch[key] = raw[key];

                continue;

            }

            if (key === "volume") {

                const volume = Number(raw.volume);

                if (!Number.isFinite(volume) || volume < 0 || volume > 1) {

                    details.push(`${eventId}.volume must be between 0.0 and 1.0`);

                    continue;

                }

                patch.volume = Math.round(volume * 1000) / 1000;

            }

        }

        if (Object.keys(patch).length === 0) {

            details.push(`${eventId}: no editable fields provided`);

            continue;

        }

        patches[eventId] = {
            ...(patches[eventId] ?? {}),
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
