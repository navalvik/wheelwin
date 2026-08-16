/**
 * R17.9I.4 — Client-side audio playback permission helper.
 *
 * Presentation only. Never throws. Does not create AudioContext or play sounds.
 * Pass registry entries from GET /console/configuration/audio-registry (or a
 * future client cache). Missing / disabled entries silently deny playback.
 */

export const AUDIO_PLAYBACK_DENY_REASONS = Object.freeze({
    NOT_FOUND: "NOT_FOUND",
    DISABLED: "DISABLED",
    MISSING: "MISSING",
    INVALID: "INVALID"
});

/**
 * @param {object|null|undefined} entry
 * @returns {{
 *   allowed: boolean,
 *   reason: string,
 *   id: string|null,
 *   file: string|null,
 *   loop: boolean,
 *   status: string|null
 * }}
 */
export function resolveAudioPlaybackPermission(entry) {

    try {

        if (!entry || typeof entry !== "object") {

            return Object.freeze({
                allowed: false,
                reason: AUDIO_PLAYBACK_DENY_REASONS.NOT_FOUND,
                id: null,
                file: null,
                loop: false,
                status: null
            });

        }

        const id = String(entry.id ?? entry.eventId ?? "").trim() || null;
        const file = String(entry.file ?? entry.audioFile ?? "").trim() || null;
        const status = entry.status ?? null;

        if (!id || !file) {

            return Object.freeze({
                allowed: false,
                reason: AUDIO_PLAYBACK_DENY_REASONS.INVALID,
                id,
                file,
                loop: false,
                status
            });

        }

        if (entry.enabled !== true) {

            return Object.freeze({
                allowed: false,
                reason: AUDIO_PLAYBACK_DENY_REASONS.DISABLED,
                id,
                file,
                loop: entry.loop === true,
                status
            });

        }

        if (status === "MISSING" || entry.exists === false) {

            return Object.freeze({
                allowed: false,
                reason: AUDIO_PLAYBACK_DENY_REASONS.MISSING,
                id,
                file,
                loop: entry.loop === true,
                status: status || "MISSING"
            });

        }

        if (status && status !== "AVAILABLE") {

            return Object.freeze({
                allowed: false,
                reason: AUDIO_PLAYBACK_DENY_REASONS.MISSING,
                id,
                file,
                loop: entry.loop === true,
                status
            });

        }

        return Object.freeze({
            allowed: true,
            reason: "OK",
            id,
            file,
            loop: entry.loop === true,
            status: status || "AVAILABLE"
        });

    } catch {

        return Object.freeze({
            allowed: false,
            reason: AUDIO_PLAYBACK_DENY_REASONS.INVALID,
            id: null,
            file: null,
            loop: false,
            status: null
        });

    }

}

/**
 * @param {object[]} entries
 * @param {string} id
 */
export function resolveAudioPlaybackPermissionById(entries, id) {

    try {

        const key = String(id ?? "").trim();
        const list = Array.isArray(entries) ? entries : [];
        const entry = list.find((item) => item?.id === key
            || item?.eventId === key)
            ?? null;

        return resolveAudioPlaybackPermission(entry);

    } catch {

        return resolveAudioPlaybackPermission(null);

    }

}
