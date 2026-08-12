import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync
} from "node:fs";
import { join } from "node:path";

import { ForensicArchiveCollector, writeStagingStatus } from "./ForensicArchiveCollector.js";
import {
    buildForensicArchiveFilename,
    resolveArchiveFilenameResult
} from "./forensicArchiveNaming.js";
import { resolveForensicArchiveConfig } from "./forensicArchiveConfig.js";

const LOG = Object.freeze({
    CREATE_STARTED: "FORENSIC_ARCHIVE_CREATE_STARTED",
    CREATED: "FORENSIC_ARCHIVE_CREATED",
    UPLOAD_STARTED: "R2_UPLOAD_STARTED",
    UPLOAD_SUCCESS: "R2_UPLOAD_SUCCESS",
    UPLOAD_FAILED: "R2_UPLOAD_FAILED",
    ENABLED: "R2_FORENSIC_ARCHIVE_ENABLED"
});

/**
 * R13.9H — Orchestrate forensic ZIP creation + private Cloudflare R2 upload.
 * Blocks room destruction until upload succeeds when required.
 */
export class ForensicArchiveService {

    constructor({
        logger,
        config = null,
        collector = null,
        uploader = null,
        sessionHistoryArchive = null,
        financialPersistence = null
    }) {

        this._logger = logger;
        this._config = config ?? resolveForensicArchiveConfig();
        this._sessionHistoryArchive = sessionHistoryArchive;
        this._financialPersistence = financialPersistence;
        this._collector = collector ?? new ForensicArchiveCollector({
            sessionHistoryDir: this._config.sessionHistoryDir,
            diagnosticLogsDir: this._config.diagnosticLogsDir,
            tonFinancialDataDir: this._config.tonFinancialDataDir,
            sessionHistoryArchive,
            financialPersistence
        });
        this._uploader = uploader;
        this._inFlight = new Map();

        if (this._config.enabled && this._uploader?.isConfigured?.()) {

            this._logInfo(
                `${LOG.ENABLED} | bucket=${this._config.bucket || "unset"}`
                + ` | required=${this._config.required === true}`
            );

        }

    }

    isBlockingEnabled() {

        return this._config.enabled
            && this._config.required
            && this._uploader?.isConfigured?.() === true;

    }

    /**
     * @returns {Promise<{ skipped?: boolean, uploaded?: boolean, archiveFilename?: string }>}
     */
    async ensureArchivedAndUploaded({
        roomId,
        gameId = null,
        reason = "room_destroyed"
    }) {

        if (!this._config.enabled) {

            return { skipped: true };

        }

        if (this._inFlight.has(roomId)) {

            return this._inFlight.get(roomId);

        }

        const task = this._ensureArchivedAndUploadedInner({
            roomId,
            gameId,
            reason
        });

        this._inFlight.set(roomId, task);

        try {

            return await task;

        } finally {

            this._inFlight.delete(roomId);

        }

    }

    async _ensureArchivedAndUploadedInner({
        roomId,
        gameId,
        reason
    }) {

        const stagingRoomDir = join(this._config.stagingDir, safeSegment(roomId));
        const statusPath = join(stagingRoomDir, "status.json");
        const existingStatus = readStatus(statusPath);

        if (existingStatus?.state === "uploaded") {

            this._logInfo(
                `${LOG.UPLOAD_SUCCESS} | roomId=${roomId} | gameId=${gameId ?? "null"}`
                + ` | archive=${existingStatus.archiveFilename ?? "?"} | cached=1`
            );

            return {
                uploaded: true,
                archiveFilename: existingStatus.archiveFilename
            };

        }

        if (!this._uploader?.isConfigured?.()) {

            if (this._config.required) {

                throw new Error(
                    "Forensic archive upload required but R2 bucket is not configured"
                );

            }

            this._logInfo(
                `FORENSIC_ARCHIVE_SKIPPED | roomId=${roomId} | reason=no_r2_bucket`
            );

            return { skipped: true };

        }

        const finishedAt = this._resolveFinishedAt(roomId) ?? Date.now();
        const lifecycleResult = this._resolveLifecycleResult(roomId, reason);
        const archiveFilename = buildForensicArchiveFilename({
            roomId,
            gameId,
            finishedAt,
            lifecycleResult,
            reason
        });

        const zipPath = join(stagingRoomDir, archiveFilename);

        this._logInfo(
            `${LOG.CREATE_STARTED} | roomId=${roomId} | gameId=${gameId ?? "null"}`
            + ` | lifecycleResult=${lifecycleResult}`
            + ` | archive=${archiveFilename}`
        );

        mkdirSync(stagingRoomDir, { recursive: true });

        let manifest;

        try {

            manifest = await this._collector.collectToZip({
                roomId,
                gameId,
                reason,
                zipPath,
                archiveFilename
            });

            this._logInfo(
                `${LOG.CREATED} | roomId=${roomId} | gameId=${gameId ?? "null"}`
                + ` | archive=${archiveFilename} | files=${manifest.files.length}`
            );

        } catch (error) {

            writeStagingStatus(statusPath, {
                state: "failed",
                phase: "collect",
                roomId,
                gameId,
                archiveFilename,
                error: error.message,
                updatedAt: Date.now()
            });

            throw error;

        }

        writeStagingStatus(statusPath, {
            state: "pending_upload",
            roomId,
            gameId,
            archiveFilename,
            zipPath,
            manifest,
            updatedAt: Date.now()
        });

        let attempt = existingStatus?.attempts ?? 0;

        while (attempt < this._config.maxUploadAttempts) {

            attempt += 1;

            this._logInfo(
                `${LOG.UPLOAD_STARTED} | roomId=${roomId} | gameId=${gameId ?? "null"}`
                + ` | archive=${archiveFilename} | attempt=${attempt}`
            );

            try {

                const upload = await this._uploader.uploadFile(
                    zipPath,
                    archiveFilename
                );

                writeStagingStatus(statusPath, {
                    state: "uploaded",
                    roomId,
                    gameId,
                    archiveFilename,
                    zipPath,
                    objectName: upload.objectName,
                    generation: upload.generation,
                    manifest,
                    attempts: attempt,
                    uploadedAt: Date.now()
                });

                this._logInfo(
                    `${LOG.UPLOAD_SUCCESS} | roomId=${roomId} | gameId=${gameId ?? "null"}`
                    + ` | archive=${archiveFilename} | object=${upload.objectName}`
                );

                return {
                    uploaded: true,
                    archiveFilename
                };

            } catch (error) {

                writeStagingStatus(statusPath, {
                    state: "failed",
                    phase: "upload",
                    roomId,
                    gameId,
                    archiveFilename,
                    zipPath,
                    manifest,
                    attempts: attempt,
                    error: error.message,
                    updatedAt: Date.now()
                });

                this._logError(
                    `${LOG.UPLOAD_FAILED} | roomId=${roomId} | gameId=${gameId ?? "null"}`
                    + ` | archive=${archiveFilename} | attempt=${attempt}`
                    + ` | error=${error.message}`
                );

                if (attempt >= this._config.maxUploadAttempts) {

                    throw error;

                }

            }

        }

        throw new Error("Forensic archive upload exhausted retries");

    }

    _resolveFinishedAt(roomId) {

        const listed = this._sessionHistoryArchive?.listRecords?.({
            roomId,
            limit: 1,
            sort: "newest"
        });

        return listed?.records?.[0]?.finishedAt ?? null;

    }

    /**
     * Prefer existing session-history lifecycleResult; else map close reason.
     * Does not invent values — only normalizes known outcomes for filenames.
     */
    _resolveLifecycleResult(roomId, reason) {

        this._sessionHistoryArchive?.finalizeIfPending?.({
            roomId,
            reason
        });

        const listed = this._sessionHistoryArchive?.listRecords?.({
            roomId,
            limit: 1,
            sort: "newest"
        });

        const fromHistory = listed?.records?.[0]?.lifecycleResult ?? null;

        return resolveArchiveFilenameResult({
            lifecycleResult: fromHistory,
            reason
        });

    }

    _logInfo(message) {

        this._logger?.info?.(message);

    }

    _logError(message) {

        this._logger?.error?.(message);

    }

}

function safeSegment(value) {

    return String(value ?? "unknown").replace(/[^\w.-]+/g, "_");

}

function readStatus(path) {

    if (!existsSync(path)) {

        return null;

    }

    try {

        return JSON.parse(readFileSync(path, "utf8"));

    } catch {

        return null;

    }

}

export { LOG as FORENSIC_ARCHIVE_LOG };
