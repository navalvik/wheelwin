/**
 * R17.9I.2 — Build read-only Audio Registry snapshot for Developer Console.
 *
 * Presentation observability only. Never enables playback. Never throws on
 * missing assets.
 */

import {
    AUDIO_ASSET_STATUS,
    AUDIO_REGISTRY_CATEGORIES,
    AUDIO_REGISTRY_SCHEMA_VERSION
} from "./audioRegistryConstants.js";
import { INITIAL_AUDIO_REGISTRY_ENTRIES } from "./audioRegistryEntries.js";
import {
    checkAudioAsset,
    resolveAudioAssetsRoot
} from "./checkAudioAsset.js";

/**
 * @param {unknown} value
 * @returns {number}
 */
function clampVolume(value) {

    const n = Number(value);

    if (!Number.isFinite(n)) {

        return 0.5;

    }

    return Math.max(0, Math.min(1, n));

}

/**
 * @param {object} entry
 * @returns {object}
 */
function normalizeEntry(entry) {

    return Object.freeze({
        eventId: String(entry.eventId ?? "").trim(),
        audioFile: String(entry.audioFile ?? "").trim().replace(/\\/g, "/"),
        category: String(entry.category ?? "System").trim(),
        volume: clampVolume(entry.volume),
        loop: entry.loop === true,
        enabled: entry.enabled !== false
    });

}

/**
 * @param {{
 *   entries?: object[],
 *   env?: NodeJS.ProcessEnv,
 *   logger?: { warn?: Function }|null,
 *   assetsRoot?: string|null,
 *   canEdit?: boolean,
 *   configVersion?: number|null,
 *   overrides?: Record<string, object>|null
 * }} [options]
 * @returns {object}
 */
export function buildAudioRegistrySnapshot({
    entries = INITIAL_AUDIO_REGISTRY_ENTRIES,
    env = process.env,
    logger = null,
    assetsRoot = null,
    canEdit = false,
    configVersion = null,
    overrides = null
} = {}) {

    const root = assetsRoot || resolveAudioAssetsRoot(env);
    const source = Array.isArray(entries) ? entries : INITIAL_AUDIO_REGISTRY_ENTRIES;
    const overrideMap = overrides && typeof overrides === "object"
        ? overrides
        : {};

    let availableCount = 0;
    let missingCount = 0;

    const projected = [];

    for (const raw of source) {

        try {

            const entry = normalizeEntry(raw);

            if (!entry.eventId || !entry.audioFile) {

                continue;

            }

            // loop is required on every entry (normalized above to boolean).
            const status = checkAudioAsset(entry, {
                assetsRoot: root,
                logger
            });

            if (status === AUDIO_ASSET_STATUS.AVAILABLE) {

                availableCount += 1;

            } else {

                missingCount += 1;

            }

            const hasOverride = Boolean(overrideMap[entry.eventId]);

            projected.push(Object.freeze({
                ...entry,
                status,
                fileName: entry.audioFile.split("/").pop() || entry.audioFile,
                overridden: hasOverride,
                editableFields: Object.freeze(["enabled", "volume", "loop"])
            }));

        } catch {

            // Never let a bad entry crash the registry snapshot.
            missingCount += 1;

        }

    }

    return Object.freeze({
        schemaVersion: AUDIO_REGISTRY_SCHEMA_VERSION,
        readOnly: canEdit !== true,
        canEdit: canEdit === true,
        generatedAt: Date.now(),
        configVersion: configVersion ?? null,
        applyScope: "future_audio_sessions_only",
        assetsRootHint: "client/src/assets/audio",
        categories: Object.freeze([...AUDIO_REGISTRY_CATEGORIES]),
        summary: Object.freeze({
            total: projected.length,
            available: availableCount,
            missing: missingCount
        }),
        notes: Object.freeze({
            playback:
                "Audio Registry does not enable playback in this stage.",
            missingFiles:
                "MISSING assets never throw, never block gameplay, never roll back state.",
            loop: "Every entry includes loop: true | false.",
            immutable: "eventId, audioFile, and category are code-controlled."
        }),
        entries: Object.freeze(projected)
    });

}
