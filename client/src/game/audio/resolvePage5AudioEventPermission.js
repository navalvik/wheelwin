/**
 * R17.9I.5 — Resolve Page5 event playback permission via Audio Registry.
 * No Web Audio / asset imports. Never throws.
 */

import { mapAudioEventToRegistryId } from "./audioRegistryCatalog.js";
import { resolveAudioPlaybackPermission } from "./resolveAudioPlaybackPermission.js";

/**
 * @param {string} eventId
 * @param {Map<string, object>|Record<string, object>|object[]|null} registry
 * @param {{ treatBundledAsAvailable?: (file: string) => boolean }} [options]
 */
export function resolvePage5AudioEventPermission(
    eventId,
    registry,
    { treatBundledAsAvailable = null } = {}
) {

    try {

        const registryId = mapAudioEventToRegistryId(eventId);

        if (!registryId) {

            return resolveAudioPlaybackPermission(null);

        }

        let entry = null;

        if (registry instanceof Map) {

            entry = registry.get(registryId) ?? null;

        } else if (Array.isArray(registry)) {

            entry = registry.find((item) => item?.id === registryId) ?? null;

        } else if (registry && typeof registry === "object") {

            entry = registry[registryId] ?? null;

        }

        if (!entry) {

            return resolveAudioPlaybackPermission(null);

        }

        const file = String(entry.file ?? entry.audioFile ?? "").trim();
        const bundled = typeof treatBundledAsAvailable === "function"
            && file
            && treatBundledAsAvailable(file) === true;

        const enriched = {
            ...entry,
            id: entry.id ?? registryId,
            file
        };

        if (entry.status == null && bundled) {

            enriched.status = "AVAILABLE";
            enriched.exists = true;

        } else if (bundled && entry.exists !== false) {

            enriched.exists = true;

        }

        return resolveAudioPlaybackPermission(enriched);

    } catch {

        return resolveAudioPlaybackPermission(null);

    }

}
