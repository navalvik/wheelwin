/**
 * R17.9J.2B — Validate and write Audio Registry assets into the client tree.
 *
 * Destination: client/src/assets/audio/<category>/<file>.ogg
 * Never stores audio under server/uploads or runtime storage.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

import {
    checkAudioAsset,
    resolveAudioAssetPath,
    resolveAudioAssetsRoot
} from "./checkAudioAsset.js";
import { AUDIO_ASSET_STATUS } from "./audioRegistryConstants.js";
import { INITIAL_AUDIO_REGISTRY_ENTRIES } from "./audioRegistryEntries.js";

export const AUDIO_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

const OGG_MAGIC = Buffer.from("OggS", "ascii");

/**
 * @param {Buffer} buffer
 * @returns {boolean}
 */
export function isOggBuffer(buffer) {

    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {

        return false;

    }

    return buffer.subarray(0, 4).equals(OGG_MAGIC);

}

/**
 * @param {string} filename
 * @returns {boolean}
 */
export function isAllowedOggFilename(filename) {

    const name = String(filename ?? "").trim();

    if (!name || name.includes("/") || name.includes("\\") || name.includes("\0")) {

        return false;

    }

    if (name === "." || name === ".." || name.includes("..")) {

        return false;

    }

    return /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.ogg$/i.test(name);

}

/**
 * @param {string} id
 * @returns {object|null}
 */
export function findRegistryEntryDef(id) {

    const key = String(id ?? "").trim();

    return INITIAL_AUDIO_REGISTRY_ENTRIES.find((entry) => entry.id === key)
        ?? null;

}

/**
 * Validate upload against a registry entry. Does not write.
 *
 * @param {{
 *   id: string,
 *   originalFilename?: string|null,
 *   buffer: Buffer
 * }} input
 * @returns {{ ok: true, entry: object, absolutePath: string }
 *   | { ok: false, status: number, error: string }}
 */
export function validateAudioAssetUpload({
    id,
    originalFilename = null,
    buffer
} = {}) {

    const entry = findRegistryEntryDef(id);

    if (!entry) {

        return {
            ok: false,
            status: 404,
            error: "Unknown Audio Registry entry"
        };

    }

    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {

        return {
            ok: false,
            status: 400,
            error: "Empty upload body"
        };

    }

    if (buffer.length > AUDIO_UPLOAD_MAX_BYTES) {

        return {
            ok: false,
            status: 413,
            error: `File exceeds ${AUDIO_UPLOAD_MAX_BYTES} byte limit`
        };

    }

    if (!isOggBuffer(buffer)) {

        return {
            ok: false,
            status: 400,
            error: "Only Ogg (.ogg) audio files are allowed"
        };

    }

    const expectedName = basename(entry.file);

    if (originalFilename) {

        const uploadedName = basename(String(originalFilename).trim());

        if (!isAllowedOggFilename(uploadedName)) {

            return {
                ok: false,
                status: 400,
                error: "Invalid .ogg filename"
            };

        }

        if (uploadedName.toLowerCase() !== expectedName.toLowerCase()) {

            return {
                ok: false,
                status: 400,
                error: `Filename must be ${expectedName}`
            };

        }

    }

    const relative = String(entry.file).replace(/\\/g, "/");
    const categoryPrefix = `${entry.category}/`;

    if (!relative.startsWith(categoryPrefix)) {

        return {
            ok: false,
            status: 400,
            error: "Registry category / file mismatch"
        };

    }

    return {
        ok: true,
        entry,
        relative
    };

}

/**
 * Write validated bytes to client/src/assets/audio (or AUDIO_ASSETS_ROOT).
 *
 * @param {{
 *   id: string,
 *   originalFilename?: string|null,
 *   buffer: Buffer,
 *   env?: NodeJS.ProcessEnv,
 *   assetsRoot?: string|null
 * }} input
 */
export function writeAudioAssetUpload({
    id,
    originalFilename = null,
    buffer,
    env = process.env,
    assetsRoot = null
} = {}) {

    const validation = validateAudioAssetUpload({
        id,
        originalFilename,
        buffer
    });

    if (!validation.ok) {

        return validation;

    }

    const root = assetsRoot || resolveAudioAssetsRoot(env);
    const absolutePath = resolveAudioAssetPath(validation.relative, root);

    if (!absolutePath) {

        return {
            ok: false,
            status: 400,
            error: "Unsafe audio asset path"
        };

    }

    try {

        mkdirSync(dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, buffer);

        const status = checkAudioAsset(validation.entry, {
            assetsRoot: root
        });

        if (status !== AUDIO_ASSET_STATUS.AVAILABLE) {

            return {
                ok: false,
                status: 500,
                error: "Upload wrote but asset check did not report AVAILABLE"
            };

        }

        return {
            ok: true,
            status: 200,
            entry: validation.entry,
            file: validation.relative,
            absolutePath,
            assetStatus: status,
            exists: true
        };

    } catch (error) {

        return {
            ok: false,
            status: 500,
            error: error?.message || "Failed to write audio asset"
        };

    }

}
