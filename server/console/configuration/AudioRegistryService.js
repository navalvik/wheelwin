/**
 * R17.9I.4 — Audio Registry mutation service.
 *
 * Persists versioned overrides for enabled/loop only.
 * Playback permission helpers fail silently for missing/disabled assets.
 */

import { LoggingManager } from "../../logging/LoggingManager.js";
import { LOG_LEVELS } from "../../logging/levels.js";
import { INITIAL_AUDIO_REGISTRY_ENTRIES } from "./audioRegistryEntries.js";
import { appendAudioRegistryAudit } from "./audioRegistryAuditStore.js";
import {
    readAudioRegistryState,
    writeAudioRegistryState
} from "./audioRegistryStore.js";
import { AUDIO_REGISTRY_EDITABLE_FIELDS } from "./audioRegistryKeys.js";
import { validateAudioRegistryPatch } from "./validateAudioRegistryPatch.js";
import { buildAudioRegistrySnapshot } from "./buildAudioRegistrySnapshot.js";
import {
    resolveAudioPlaybackPermission,
    resolveAudioPlaybackPermissionById
} from "./resolveAudioPlaybackPermission.js";
import { writeAudioAssetUpload } from "./uploadAudioRegistryAsset.js";
import { checkAudioAsset } from "./checkAudioAsset.js";

export class AudioRegistryService {

    /**
     * @param {{
     *   logger?: { info?: Function, warn?: Function, error?: Function }|null,
     *   env?: NodeJS.ProcessEnv
     * }} [options]
     */
    constructor({
        logger = null,
        env = process.env
    } = {}) {

        this._logger = logger;
        this._env = env;
        this._state = null;
        this._initialized = false;

    }

    initialize() {

        this._state = readAudioRegistryState(this._env)
            ?? Object.freeze({
                schemaVersion: 1,
                configVersion: 0,
                overrides: Object.freeze({}),
                updatedAt: null,
                updatedBy: null
            });

        this._initialized = true;

        return this._state;

    }

    isInitialized() {

        return this._initialized === true;

    }

    getState() {

        return this._state;

    }

    getOverrides() {

        return this._state?.overrides ?? Object.freeze({});

    }

    /**
     * Effective static entries with overrides applied (no asset status).
     * @returns {object[]}
     */
    getEffectiveEntries() {

        const overrides = this.getOverrides();

        return INITIAL_AUDIO_REGISTRY_ENTRIES.map((entry) => {

            const patch = overrides[entry.id];

            if (!patch) {

                return entry;

            }

            return {
                ...entry,
                ...patch
            };

        });

    }

    /**
     * @param {{ canEdit?: boolean, logger?: object|null, assetsRoot?: string|null }} [options]
     */
    buildSnapshot({
        canEdit = true,
        logger = null,
        assetsRoot = null
    } = {}) {

        return buildAudioRegistrySnapshot({
            entries: this.getEffectiveEntries(),
            env: this._env,
            logger,
            assetsRoot,
            canEdit,
            configVersion: this._state?.configVersion ?? 0,
            overrides: this.getOverrides()
        });

    }

    /**
     * Runtime playback gate for future audio sessions.
     * Never throws.
     *
     * @param {string} id
     * @param {{ assetsRoot?: string }} [options]
     */
    resolvePlaybackPermission(id, options = {}) {

        try {

            const snapshot = this.buildSnapshot({
                canEdit: false,
                assetsRoot: options.assetsRoot
            });

            return resolveAudioPlaybackPermissionById(
                snapshot.entries,
                id,
                {
                    assetsRoot: options.assetsRoot,
                    logger: this._logger
                }
            );

        } catch {

            return resolveAudioPlaybackPermission(null);

        }

    }

    /**
     * @param {unknown} body
     * @param {{ username?: string|null, role?: string|null }} actor
     */
    update(body, actor = {}) {

        if (!this._initialized) {

            return {
                ok: false,
                status: 503,
                error: "Audio Registry service is not initialized"
            };

        }

        const validation = validateAudioRegistryPatch(body);

        if (!validation.ok) {

            return {
                ok: false,
                status: 400,
                error: validation.error,
                details: validation.details
            };

        }

        const baselineById = new Map(
            this.getEffectiveEntries().map((entry) => [entry.id, entry])
        );

        const previousOverrides = { ...(this._state.overrides ?? {}) };
        const nextOverrides = { ...previousOverrides };
        const changes = [];

        for (const [id, patch] of Object.entries(validation.patches)) {

            const baseline = baselineById.get(id);

            if (!baseline) {

                continue;

            }

            const merged = {
                ...(previousOverrides[id] ?? {}),
                ...patch
            };

            // Drop stale volume overrides from earlier stages.
            delete merged.volume;

            nextOverrides[id] = merged;

            for (const field of AUDIO_REGISTRY_EDITABLE_FIELDS) {

                if (!Object.prototype.hasOwnProperty.call(patch, field)) {

                    continue;

                }

                const oldValue = baseline[field];
                const newValue = patch[field];

                if (oldValue === newValue) {

                    continue;

                }

                changes.push({
                    id,
                    field,
                    oldValue,
                    newValue
                });

            }

        }

        if (changes.length === 0) {

            return {
                ok: true,
                status: 200,
                state: this._state,
                changes: [],
                auditRecords: [],
                message: "No changes detected"
            };

        }

        const nextVersion = (Number(this._state.configVersion) || 0) + 1;

        const persisted = writeAudioRegistryState({
            configVersion: nextVersion,
            overrides: nextOverrides,
            updatedBy: actor.username ?? null
        }, this._env);

        this._state = persisted;

        const auditRecords = [];

        for (const change of changes) {

            const record = appendAudioRegistryAudit({
                user: actor.username ?? null,
                role: actor.role ?? null,
                id: change.id,
                eventId: change.id,
                field: change.field,
                oldValue: change.oldValue,
                newValue: change.newValue,
                configVersion: nextVersion
            }, this._env);

            auditRecords.push(record);

            this._emitAuditLog(record);

        }

        this._logger?.info?.(
            `AUDIO_REGISTRY_CHANGED | version=${nextVersion}`
            + ` | user=${actor.username ?? "unknown"}`
            + ` | changes=${changes.length}`
        );

        return {
            ok: true,
            status: 200,
            state: this._state,
            changes,
            auditRecords,
            message: "Audio Registry updated for future audio sessions"
        };

    }

    /**
     * R17.9J.2B — Write an .ogg into client/src/assets/audio for a registry id.
     * Does not mutate enabled/loop overrides.
     *
     * @param {string} id
     * @param {Buffer} buffer
     * @param {{
     *   originalFilename?: string|null,
     *   username?: string|null,
     *   role?: string|null,
     *   assetsRoot?: string|null
     * }} [actor]
     */
    uploadAsset(id, buffer, actor = {}) {

        if (!this._initialized) {

            return {
                ok: false,
                status: 503,
                error: "Audio Registry service is not initialized"
            };

        }

        const previousStatus = (() => {

            try {

                const entry = this.getEffectiveEntries()
                    .find((item) => item.id === String(id ?? "").trim());

                if (!entry) {

                    return "MISSING";

                }

                return checkAudioAsset(entry, {
                    ...(actor.assetsRoot
                        ? { assetsRoot: actor.assetsRoot }
                        : {}),
                    logger: this._logger
                });

            } catch {

                return "MISSING";

            }

        })();

        const written = writeAudioAssetUpload({
            id,
            originalFilename: actor.originalFilename ?? null,
            buffer,
            env: this._env,
            assetsRoot: actor.assetsRoot ?? null
        });

        if (!written.ok) {

            return written;

        }

        const auditRecord = appendAudioRegistryAudit({
            user: actor.username ?? null,
            role: actor.role ?? null,
            id: written.entry.id,
            eventId: written.entry.id,
            field: "asset",
            oldValue: previousStatus,
            newValue: written.assetStatus,
            configVersion: this._state?.configVersion ?? 0
        }, this._env);

        this._emitAuditLog(auditRecord);

        this._logger?.info?.(
            `AUDIO_ASSET_UPLOADED | id=${written.entry.id}`
            + ` | file=${written.file}`
            + ` | user=${actor.username ?? "unknown"}`
        );

        return {
            ok: true,
            status: 200,
            file: written.file,
            assetStatus: written.assetStatus,
            exists: true,
            auditRecord,
            message: "Audio asset uploaded to client assets tree",
            // enabled / loop intentionally unchanged
            registry: this.buildSnapshot({
                canEdit: true,
                ...(actor.assetsRoot
                    ? { assetsRoot: actor.assetsRoot }
                    : {})
            })
        };

    }

    /**
     * @param {object} record
     */
    _emitAuditLog(record) {

        const manager = LoggingManager.getInstance();

        if (manager.isInitialized()) {

            manager.audit("AUDIO_REGISTRY_CHANGED", {
                component: "AudioRegistry",
                user: record.user,
                role: record.role,
                id: record.id ?? record.eventId,
                eventId: record.eventId ?? record.id,
                field: record.field,
                oldValue: record.oldValue,
                newValue: record.newValue,
                configVersion: record.configVersion,
                timestamp: record.timestamp
            }, LOG_LEVELS.INFO);

            return;

        }

        this._logger?.info?.(
            `AUDIO_REGISTRY_CHANGED | id=${record.id ?? record.eventId}`
            + ` | field=${record.field}`
            + ` | old=${record.oldValue} | new=${record.newValue}`
            + ` | user=${record.user}`
        );

    }

}
