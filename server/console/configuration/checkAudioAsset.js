/**
 * R17.9I.2 — Missing-file safe audio asset checks.
 *
 * Never throws. Missing assets must never affect gameplay or crash the console.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { AUDIO_ASSET_STATUS } from "./audioRegistryConstants.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Default: <repo>/client/src/assets/audio */
export const DEFAULT_AUDIO_ASSETS_ROOT = resolve(
    MODULE_DIR,
    "../../../client/src/assets/audio"
);

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveAudioAssetsRoot(env = process.env) {

    const configured = String(env.AUDIO_ASSETS_ROOT || "").trim();

    return configured || DEFAULT_AUDIO_ASSETS_ROOT;

}

/**
 * Resolve a relative registry path under the assets root.
 * Rejects path traversal. Never throws.
 *
 * @param {string} audioFile
 * @param {string} [assetsRoot]
 * @returns {string|null} absolute path or null if unsafe/invalid
 */
export function resolveAudioAssetPath(audioFile, assetsRoot = DEFAULT_AUDIO_ASSETS_ROOT) {

    try {

        const relative = String(audioFile ?? "").trim().replace(/\\/g, "/");

        if (!relative || relative.includes("\0") || relative.startsWith("/")) {

            return null;

        }

        if (relative.split("/").some((part) => part === ".." || part === "")) {

            return null;

        }

        const root = resolve(assetsRoot);
        const absolute = resolve(root, relative);
        const normalizedRoot = normalize(root + sep);
        const normalizedAbsolute = normalize(absolute);

        if (!normalizedAbsolute.startsWith(normalizedRoot)
            && normalizedAbsolute !== root) {

            return null;

        }

        return absolute;

    } catch {

        return null;

    }

}

/**
 * Check whether a registry entry's audio file exists on disk.
 * Never throws.
 *
 * @param {{ audioFile?: string }|string|null|undefined} entryOrPath
 * @param {{
 *   assetsRoot?: string,
 *   logger?: { warn?: Function }|null
 * }} [options]
 * @returns {"AVAILABLE"|"MISSING"}
 */
export function checkAudioAsset(entryOrPath, {
    assetsRoot = DEFAULT_AUDIO_ASSETS_ROOT,
    logger = null
} = {}) {

    try {

        const audioFile = typeof entryOrPath === "string"
            ? entryOrPath
            : entryOrPath?.audioFile;

        const absolute = resolveAudioAssetPath(audioFile, assetsRoot);

        if (!absolute) {

            logMissing(logger, audioFile ?? "(invalid)", null);

            return AUDIO_ASSET_STATUS.MISSING;

        }

        if (!existsSync(absolute)) {

            logMissing(logger, audioFile, absolute);

            return AUDIO_ASSET_STATUS.MISSING;

        }

        const stats = statSync(absolute);

        if (!stats.isFile() || stats.size <= 0) {

            logMissing(logger, audioFile, absolute);

            return AUDIO_ASSET_STATUS.MISSING;

        }

        return AUDIO_ASSET_STATUS.AVAILABLE;

    } catch {

        try {

            const audioFile = typeof entryOrPath === "string"
                ? entryOrPath
                : entryOrPath?.audioFile;

            logMissing(logger, audioFile ?? "(error)", null);

        } catch {

            // swallow
        }

        return AUDIO_ASSET_STATUS.MISSING;

    }

}

/**
 * @param {{ warn?: Function }|null} logger
 * @param {string} audioFile
 * @param {string|null} absolute
 */
function logMissing(logger, audioFile, absolute) {

    const message = absolute
        ? `AUDIO_MISSING_FILE | audioFile=${audioFile} | path=${absolute}`
        : `AUDIO_MISSING_FILE | audioFile=${audioFile}`;

    if (logger?.warn) {

        logger.warn(message);

        return;

    }

    // Fail silently for gameplay — console/dev only soft warn when no logger.
    if (typeof console !== "undefined" && typeof console.warn === "function") {

        // Avoid noisy spam in unit tests unless a logger is injected.
    }

}
