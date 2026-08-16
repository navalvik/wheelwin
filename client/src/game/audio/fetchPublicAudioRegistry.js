/**
 * R17.9I.5 — Fetch public Audio Registry snapshot for game clients.
 * Never throws. Falls back to static catalog on failure.
 */

import { resolveBackendUrl } from "../../config/backendUrl.js";
import { CLIENT_AUDIO_REGISTRY_DEFAULTS } from "./audioRegistryCatalog.js";

/**
 * @returns {Promise<object[]>}
 */
export async function fetchPublicAudioRegistry() {

    try {

        const response = await fetch(
            `${resolveBackendUrl()}/audio/registry`,
            {
                method: "GET",
                headers: {
                    Accept: "application/json"
                }
            }
        );

        if (!response.ok) {

            return [...CLIENT_AUDIO_REGISTRY_DEFAULTS];

        }

        const body = await response.json();
        const entries = Array.isArray(body?.entries) ? body.entries : null;

        if (!entries || entries.length === 0) {

            return [...CLIENT_AUDIO_REGISTRY_DEFAULTS];

        }

        return entries.map((entry) => Object.freeze({
            id: String(entry.id ?? "").trim(),
            file: String(entry.file ?? entry.audioFile ?? "").trim(),
            category: String(entry.category ?? "").trim(),
            enabled: entry.enabled !== false,
            loop: entry.loop === true,
            status: entry.status ?? null,
            exists: entry.exists === true
        })).filter((entry) => entry.id && entry.file);

    } catch {

        return [...CLIENT_AUDIO_REGISTRY_DEFAULTS];

    }

}
