/**
 * R17.9I.4 — Build Audio Registry snapshot for Developer Console.
 *
 * Presentation observability only. Never throws on missing assets.
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
 * @param {object} entry
 * @returns {object}
 */
function normalizeEntry(entry) {

    const id = String(entry.id ?? entry.eventId ?? "").trim();
    const file = String(entry.file ?? entry.audioFile ?? "")
        .trim()
        .replace(/\\/g, "/");

    return Object.freeze({
        id,
        file,
        category: String(entry.category ?? "ui").trim(),
        enabled: entry.enabled !== false,
        loop: entry.loop === true,
        // Compatibility aliases for older validators / helpers.
        eventId: id,
        audioFile: file
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

            if (!entry.id || !entry.file) {

                continue;

            }

            const status = checkAudioAsset(entry, {
                assetsRoot: root,
                logger
            });

            if (status === AUDIO_ASSET_STATUS.AVAILABLE) {

                availableCount += 1;

            } else {

                missingCount += 1;

            }

            const hasOverride = Boolean(overrideMap[entry.id]);

            projected.push(Object.freeze({
                ...entry,
                status,
                exists: status === AUDIO_ASSET_STATUS.AVAILABLE,
                fileName: entry.file.split("/").pop() || entry.file,
                overridden: hasOverride,
                editableFields: Object.freeze(["enabled", "loop"])
            }));

        } catch {

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
                "Playback requires enabled=true AND status=AVAILABLE; otherwise silent skip.",
            missingFiles:
                "MISSING assets never throw, never block gameplay, never roll back state.",
            controls: "Administrator may edit enabled and loop only.",
            immutable: "id, file, and category are code-controlled."
        }),
        entries: Object.freeze(projected)
    });

}
