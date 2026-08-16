/**
 * R17.9I.4 — Safe playback permission resolver (presentation only).
 *
 * Never throws. Missing / disabled audio must silently skip.
 */

import { AUDIO_ASSET_STATUS } from "./audioRegistryConstants.js";
import { checkAudioAsset } from "./checkAudioAsset.js";

export const AUDIO_PLAYBACK_DENY_REASONS = Object.freeze({
    NOT_FOUND: "NOT_FOUND",
    DISABLED: "DISABLED",
    MISSING: "MISSING",
    INVALID: "INVALID"
});

/**
 * Decide whether a registry entry may play.
 *
 * @param {object|null|undefined} entry
 * @param {{
 *   assetsRoot?: string,
 *   recheckAsset?: boolean,
 *   logger?: { warn?: Function }|null
 * }} [options]
 * @returns {{
 *   allowed: boolean,
 *   reason: string,
 *   id: string|null,
 *   file: string|null,
 *   loop: boolean,
 *   status: string|null
 * }}
 */
export function resolveAudioPlaybackPermission(entry, {
    assetsRoot = undefined,
    recheckAsset = false,
    logger = null
} = {}) {

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

        if (!id || !file) {

            return Object.freeze({
                allowed: false,
                reason: AUDIO_PLAYBACK_DENY_REASONS.INVALID,
                id,
                file,
                loop: false,
                status: entry.status ?? null
            });

        }

        if (entry.enabled !== true) {

            return Object.freeze({
                allowed: false,
                reason: AUDIO_PLAYBACK_DENY_REASONS.DISABLED,
                id,
                file,
                loop: entry.loop === true,
                status: entry.status ?? null
            });

        }

        let status = entry.status ?? null;

        if (recheckAsset || !status) {

            status = checkAudioAsset({
                audioFile: file,
                file
            }, {
                assetsRoot,
                logger
            });

        }

        if (status !== AUDIO_ASSET_STATUS.AVAILABLE) {

            return Object.freeze({
                allowed: false,
                reason: AUDIO_PLAYBACK_DENY_REASONS.MISSING,
                id,
                file,
                loop: entry.loop === true,
                status: status || AUDIO_ASSET_STATUS.MISSING
            });

        }

        return Object.freeze({
            allowed: true,
            reason: "OK",
            id,
            file,
            loop: entry.loop === true,
            status: AUDIO_ASSET_STATUS.AVAILABLE
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
 * Lookup helper: find entry by id in a list, then resolve permission.
 * Never throws.
 *
 * @param {object[]} entries
 * @param {string} id
 * @param {object} [options]
 */
export function resolveAudioPlaybackPermissionById(entries, id, options = {}) {

    try {

        const key = String(id ?? "").trim();
        const list = Array.isArray(entries) ? entries : [];
        const entry = list.find((item) => item?.id === key
            || item?.eventId === key)
            ?? null;

        return resolveAudioPlaybackPermission(entry, options);

    } catch {

        return resolveAudioPlaybackPermission(null);

    }

}
