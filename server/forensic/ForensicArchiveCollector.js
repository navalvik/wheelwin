import {
    createWriteStream,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    writeFileSync
} from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

import archiver from "archiver";

import { RECORD_STORAGE_CATEGORY } from "../persistence/TonFinancialRecordTypes.js";
import { safeFilenameSegment } from "./forensicArchiveNaming.js";

/**
 * R13.9F — Collect existing forensic artifacts byte-for-byte into a ZIP.
 * Does not parse, filter, or rewrite source JSON/log files.
 */
export class ForensicArchiveCollector {

    constructor({
        sessionHistoryDir,
        diagnosticLogsDir,
        tonFinancialDataDir,
        sessionHistoryArchive = null,
        financialPersistence = null
    }) {

        this._sessionHistoryDir = sessionHistoryDir;
        this._diagnosticLogsDir = diagnosticLogsDir;
        this._tonFinancialDataDir = tonFinancialDataDir;
        this._sessionHistoryArchive = sessionHistoryArchive;
        this._financialPersistence = financialPersistence;

    }

    /**
     * @returns {Promise<{
     *   zipPath: string,
     *   archiveFilename: string,
     *   files: Array<{ sourcePath: string, zipPath: string, sha256: string }>
     * }>}
     */
    async collectToZip({
        roomId,
        gameId = null,
        reason = "room_destroyed",
        zipPath,
        archiveFilename
    }) {

        this._sessionHistoryArchive?.finalizeIfPending?.({
            roomId,
            gameId,
            reason
        });

        const entries = this._discoverArtifactEntries({ roomId, gameId });

        if (entries.length === 0) {

            throw new Error(
                `No forensic artifacts found | roomId=${roomId}`
            );

        }

        mkdirSync(join(zipPath, ".."), { recursive: true });

        const fileManifest = [];

        await this._writeZip({
            zipPath,
            entries,
            onFileAdded(sourcePath, zipEntryPath, sha256) {

                fileManifest.push({
                    sourcePath,
                    zipPath: zipEntryPath,
                    sha256
                });

            }
        });

        return {
            zipPath,
            archiveFilename,
            files: fileManifest
        };

    }

    _discoverArtifactEntries({ roomId, gameId }) {

        const entries = [];
        const seenSources = new Set();

        const pushEntry = (sourcePath, zipPath) => {

            if (!sourcePath || !existsSync(sourcePath)) {

                return;

            }

            const normalized = sourcePath.toLowerCase();

            if (seenSources.has(normalized)) {

                return;

            }

            seenSources.add(normalized);

            entries.push({
                sourcePath,
                zipPath
            });

        };

        for (const file of this._discoverSessionHistoryFiles(roomId)) {

            pushEntry(
                file.absolutePath,
                join("session-history", file.filename)
            );

        }

        for (const file of this._discoverDiagnosticLogFiles(roomId)) {

            pushEntry(
                file.absolutePath,
                join("diagnostic-logs", file.filename)
            );

        }

        for (const file of this._discoverTonFinancialFiles({ roomId, gameId })) {

            pushEntry(
                file.absolutePath,
                join("ton-financial", file.relativePath)
            );

        }

        return entries;

    }

    _discoverSessionHistoryFiles(roomId) {

        if (this._sessionHistoryArchive?.listRecordFilePathsForRoom) {

            return this._sessionHistoryArchive.listRecordFilePathsForRoom(roomId);

        }

        if (!existsSync(this._sessionHistoryDir)) {

            return [];

        }

        const needle = `_ROOM_${safeFilenameSegment(roomId)}_`;

        return readdirSync(this._sessionHistoryDir)
            .filter((name) => name.endsWith(".json") && name !== "index.json")
            .filter((name) => name.includes(needle))
            .map((filename) => ({
                filename,
                absolutePath: join(this._sessionHistoryDir, filename)
            }));

    }

    _discoverDiagnosticLogFiles(roomId) {

        if (!existsSync(this._diagnosticLogsDir)) {

            return [];

        }

        const needle = `_ROOM_${safeFilenameSegment(roomId)}`;

        return readdirSync(this._diagnosticLogsDir)
            .filter((name) => name.endsWith(".log") && name.includes(needle))
            .map((filename) => ({
                filename,
                absolutePath: join(this._diagnosticLogsDir, filename)
            }));

    }

    _discoverTonFinancialFiles({ roomId, gameId }) {

        if (!this._financialPersistence || !existsSync(this._tonFinancialDataDir)) {

            return [];

        }

        const records = new Map();

        const ingest = (envelope) => {

            if (!envelope?.recordType || !envelope?.recordId) {

                return;

            }

            const key = `${envelope.recordType}:${envelope.recordId}`;

            records.set(key, envelope);

        };

        for (const record of this._financialPersistence.findByGame(gameId) ?? []) {

            ingest(record);

        }

        for (const record of this._financialPersistence.findByRoom(roomId) ?? []) {

            ingest(record);

        }

        const files = [];

        for (const record of records.values()) {

            const absolutePath = this._resolveTonFinancialRecordPath(
                record.recordType,
                record.recordId
            );

            if (!absolutePath || !existsSync(absolutePath)) {

                continue;

            }

            files.push({
                absolutePath,
                relativePath: relative(this._tonFinancialDataDir, absolutePath)
                    .split("\\")
                    .join("/")
            });

        }

        return files;

    }

    _resolveTonFinancialRecordPath(recordType, recordId) {

        const category = RECORD_STORAGE_CATEGORY[recordType];

        if (!category) {

            return null;

        }

        return join(
            this._tonFinancialDataDir,
            category,
            recordType,
            `${recordId}.json`
        );

    }

    async _writeZip({ zipPath, entries, onFileAdded }) {

        await new Promise((resolve, reject) => {

            const output = createWriteStream(zipPath);
            const archive = archiver("zip", { zlib: { level: 9 } });

            output.on("close", resolve);
            output.on("error", reject);
            archive.on("error", reject);

            archive.pipe(output);

            for (const entry of entries) {

                const sha256 = this._sha256File(entry.sourcePath);

                onFileAdded(entry.sourcePath, entry.zipPath, sha256);

                archive.file(entry.sourcePath, { name: entry.zipPath });

            }

            archive.finalize();

        });

    }

    _sha256File(filePath) {

        const hash = createHash("sha256");

        hash.update(readFileSync(filePath));

        return hash.digest("hex");

    }

}

/**
 * Verify source files unchanged after archive (test helper).
 */
export function verifySourceFilesUnchanged(manifest) {

    for (const entry of manifest) {

        const hash = createHash("sha256");

        hash.update(readFileSync(entry.sourcePath));

        if (hash.digest("hex") !== entry.sha256) {

            throw new Error(`Source file mutated: ${entry.sourcePath}`);

        }

    }

}

export function writeStagingStatus(stagingPath, payload) {

    mkdirSync(join(stagingPath, ".."), { recursive: true });

    const temp = `${stagingPath}.tmp`;

    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    renameSync(temp, stagingPath);

}
