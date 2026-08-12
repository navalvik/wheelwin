import assert from "node:assert/strict";
import {
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    ForensicArchiveCollector,
    verifySourceFilesUnchanged
} from "../forensic/ForensicArchiveCollector.js";
import {
    ForensicArchiveService
} from "../forensic/ForensicArchiveService.js";
import { MockForensicArchiveUploader } from "../forensic/R2ForensicArchiveUploader.js";
import { resolveForensicArchiveConfig } from "../forensic/forensicArchiveConfig.js";
import { buildForensicArchiveFilename } from "../forensic/forensicArchiveNaming.js";
import { SessionHistoryArchiveManager } from "../history/SessionHistoryArchiveManager.js";
import { LoggingManager } from "../logging/LoggingManager.js";
import { LOG_LEVELS } from "../logging/levels.js";
import { RoomManager } from "../managers/RoomManager.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";
import { LoggerService } from "../services/LoggerService.js";
import { TON_FINANCIAL_RECORD_TYPES } from "../persistence/TonFinancialRecordTypes.js";

SessionHistoryArchiveManager.resetForTests();
LoggingManager.resetForTests();

function createLogger() {

    const loggingManager = LoggingManager.getInstance();

    loggingManager.initialize({
        level: LOG_LEVELS.INFO,
        enableConsole: false,
        enableFile: false,
        format: "console"
    });

    const logger = new LoggerService({ loggingManager });

    logger.initialize();

    return logger;

}

function zipContainsPath(zipPath, entryPath) {

    const buffer = readFileSync(zipPath);

    return buffer.includes(Buffer.from(entryPath));

}

function buildFixture() {

    const root = mkdtempSync(join(tmpdir(), "wheelwin-forensic-"));
    const sessionHistoryDir = join(root, "session-history");
    const diagnosticLogsDir = join(root, "logs", "games");
    const tonFinancialDataDir = join(root, "ton-financial");
    const stagingDir = join(root, "staging");

    mkdirSync(sessionHistoryDir, { recursive: true });
    mkdirSync(diagnosticLogsDir, { recursive: true });
    mkdirSync(join(tonFinancialDataDir, "active", "payment_session"), {
        recursive: true
    });
    mkdirSync(stagingDir, { recursive: true });

    const roomId = "pf6e";
    const gameId = "9aafa4fd";

    const historyFilename = `2026-08-12T10-00-00.000Z_ROOM_${roomId}_GAME_${gameId}_GAME_COMPLETED.json`;
    const historyPath = join(sessionHistoryDir, historyFilename);
    const historyBody = `{"roomId":"${roomId}","gameId":"${gameId}","lifecycleResult":"GAME_COMPLETED"}\n`;

    writeFileSync(historyPath, historyBody, "utf8");

    const logFilename = `2026-08-12T10-00-00.000Z_ROOM_${roomId}_GAME_${gameId}.log`;
    const logPath = join(diagnosticLogsDir, logFilename);
    const logBody = "diagnostic line\n";

    writeFileSync(logPath, logBody, "utf8");

    const paymentRecordId = "pay-001";
    const paymentRelative = join("active", "payment_session", `${paymentRecordId}.json`);
    const paymentPath = join(tonFinancialDataDir, paymentRelative);
    const paymentBody = `{"recordType":"payment_session","recordId":"${paymentRecordId}"}\n`;

    writeFileSync(paymentPath, paymentBody, "utf8");

    const financialPersistence = {
        findByGame(game) {

            if (game !== gameId) {

                return [];

            }

            return [{
                recordType: TON_FINANCIAL_RECORD_TYPES.PAYMENT_SESSION,
                recordId: paymentRecordId,
                roomId,
                gameId
            }];

        },
        findByRoom(room) {

            if (room !== roomId) {

                return [];

            }

            return [{
                recordType: TON_FINANCIAL_RECORD_TYPES.PAYMENT_SESSION,
                recordId: paymentRecordId,
                roomId,
                gameId
            }];

        }
    };

    const sessionHistoryArchive = {
        finalizeIfPending: () => false,
        listRecordFilePathsForRoom(room) {

            if (room !== roomId) {

                return [];

            }

            return [{
                filename: historyFilename,
                absolutePath: historyPath
            }];

        },
        listRecords({ roomId: listedRoomId }) {

            if (listedRoomId !== roomId) {

                return { records: [] };

            }

            return {
                records: [{
                    finishedAt: Date.parse("2026-08-12T10:00:00.000Z")
                }]
            };

        }
    };

    return {
        root,
        roomId,
        gameId,
        sessionHistoryDir,
        diagnosticLogsDir,
        tonFinancialDataDir,
        stagingDir,
        historyFilename,
        logFilename,
        paymentRelative: paymentRelative.split("\\").join("/"),
        financialPersistence,
        sessionHistoryArchive
    };

}

async function testArchiveCreation() {

    const fixture = buildFixture();
    const archiveFilename = buildForensicArchiveFilename({
        roomId: fixture.roomId,
        gameId: fixture.gameId,
        finishedAt: Date.parse("2026-08-12T10:00:00.000Z")
    });
    const zipPath = join(fixture.stagingDir, archiveFilename);

    const collector = new ForensicArchiveCollector({
        sessionHistoryDir: fixture.sessionHistoryDir,
        diagnosticLogsDir: fixture.diagnosticLogsDir,
        tonFinancialDataDir: fixture.tonFinancialDataDir,
        sessionHistoryArchive: fixture.sessionHistoryArchive,
        financialPersistence: fixture.financialPersistence
    });

    const manifest = await collector.collectToZip({
        roomId: fixture.roomId,
        gameId: fixture.gameId,
        zipPath,
        archiveFilename
    });

    assert.equal(manifest.files.length, 3);
    verifySourceFilesUnchanged(manifest.files);

    assert(zipContainsPath(zipPath, `session-history/${fixture.historyFilename}`));
    assert(zipContainsPath(zipPath, `diagnostic-logs/${fixture.logFilename}`));
    assert(zipContainsPath(
        zipPath,
        `ton-financial/${fixture.paymentRelative}`
    ));

    rmSync(fixture.root, { recursive: true, force: true });

    console.log("  archive creation packs byte-for-byte artifacts");

}

async function testUploadSuccess() {

    const fixture = buildFixture();
    const logger = createLogger();
    const uploader = new MockForensicArchiveUploader();

    const service = new ForensicArchiveService({
        logger,
        config: {
            enabled: true,
            required: true,
            bucket: "wheelwin-forensic-archives",
            prefix: "forensic-archives",
            stagingDir: fixture.stagingDir,
            sessionHistoryDir: fixture.sessionHistoryDir,
            diagnosticLogsDir: fixture.diagnosticLogsDir,
            tonFinancialDataDir: fixture.tonFinancialDataDir,
            accountId: "test-account",
            accessKeyId: "test-key",
            secretAccessKey: "test-secret",
            endpoint: "https://example.r2.cloudflarestorage.com",
            r2Configured: true,
            maxUploadAttempts: 2
        },
        uploader,
        sessionHistoryArchive: fixture.sessionHistoryArchive,
        financialPersistence: fixture.financialPersistence
    });

    const result = await service.ensureArchivedAndUploaded({
        roomId: fixture.roomId,
        gameId: fixture.gameId
    });

    assert.equal(result.uploaded, true);
    assert.equal(uploader.uploads.length, 1);
    assert(uploader.uploads[0].objectName.endsWith("_LIFECYCLE_ARCHIVE.zip"));
    assert(uploader.uploads[0].localPath.endsWith(".zip"));
    assert.equal(
        readFileSync(uploader.uploads[0].localPath).subarray(0, 2).toString("binary"),
        "PK",
        "R2 uploader must receive ZIP bytes"
    );

    rmSync(fixture.root, { recursive: true, force: true });

    console.log("  R2 upload success records archive");

}

async function testR2ConfigIgnoresGcsEnv() {

    const config = resolveForensicArchiveConfig({
        R2_BUCKET_NAME: "wheelwin-forensic-archives",
        R2_ACCOUNT_ID: "acct",
        R2_ACCESS_KEY_ID: "key",
        R2_SECRET_ACCESS_KEY: "secret",
        R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
        FORENSIC_ARCHIVE_REQUIRED: "true",
        GCS_FORENSIC_BUCKET: "legacy-gcs-bucket",
        GCS_SERVICE_ACCOUNT_JSON: "{\"type\":\"service_account\"}"
    });

    assert.equal(config.bucket, "wheelwin-forensic-archives");
    assert.equal(config.r2Configured, true);
    assert.equal(config.required, true);
    assert.equal(config.credentialsJson, undefined);

    console.log("  R2 config uses Cloudflare env (not GCS)");

}

async function testUploadFailureBlocksLifecycle() {

    const fixture = buildFixture();
    const logger = createLogger();
    const uploader = new MockForensicArchiveUploader();

    uploader.shouldFail = true;

    const service = new ForensicArchiveService({
        logger,
        config: {
            enabled: true,
            required: true,
            bucket: "wheelwin-forensic-archives",
            prefix: "forensic-archives",
            stagingDir: fixture.stagingDir,
            sessionHistoryDir: fixture.sessionHistoryDir,
            diagnosticLogsDir: fixture.diagnosticLogsDir,
            tonFinancialDataDir: fixture.tonFinancialDataDir,
            accountId: "test-account",
            accessKeyId: "test-key",
            secretAccessKey: "test-secret",
            endpoint: "https://example.r2.cloudflarestorage.com",
            r2Configured: true,
            maxUploadAttempts: 1
        },
        uploader,
        sessionHistoryArchive: fixture.sessionHistoryArchive,
        financialPersistence: fixture.financialPersistence
    });

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    let destroyed = false;

    eventBus.subscribe(EVENT_TYPES.ROOM_DESTROYED, () => {

        destroyed = true;

    });

    const roomManager = new RoomManager({
        logger,
        eventBus,
        roomConfig: { maxPlayers: 3 }
    });

    roomManager.initialize();

    const setupSessionLifecycle = new SetupSessionLifecycle({
        logger,
        eventBus,
        roomManager,
        roomConfig: { setupDurationMs: 10 * 60 * 1000 }
    });

    setupSessionLifecycle.initialize();
    roomManager.attachSetupSessionLifecycle(setupSessionLifecycle);

    const room = roomManager.createRoom();
    const roomId = room.roomId;

    const bridge = new RoomLobbyBridge({
        logger,
        eventBus,
        roomManager,
        playerManager: {
            getPlayer: () => null
        }
    });

    bridge.configureForensicArchiveService(service);

    const historyFilename = `2026-08-12T10-00-00.000Z_ROOM_${roomId}_GAME_test_GAME_COMPLETED.json`;

    writeFileSync(
        join(fixture.sessionHistoryDir, historyFilename),
        `{"roomId":"${roomId}"}\n`,
        "utf8"
    );

    fixture.sessionHistoryArchive.listRecordFilePathsForRoom = (listedRoomId) => {

        if (listedRoomId !== roomId) {

            return [];

        }

        return [{
            filename: historyFilename,
            absolutePath: join(fixture.sessionHistoryDir, historyFilename)
        }];

    };

    await assert.rejects(
        () => service.ensureArchivedAndUploaded({ roomId, gameId: "test" }),
        /Mock R2 upload failure/
    );

    await bridge._closeRoom(roomId, "test_upload_failure");

    assert.equal(destroyed, false, "ROOM_DESTROYED must wait for R2 success");
    assert(roomManager.getRoom(roomId), "room must remain until upload succeeds");

    uploader.shouldFail = false;

    await bridge._closeRoom(roomId, "test_upload_failure_retry");

    assert.equal(destroyed, true, "ROOM_DESTROYED after successful upload");
    assert(!roomManager.getRoom(roomId));

    rmSync(fixture.root, { recursive: true, force: true });

    console.log("  upload failure blocks ROOM_DESTROYED until retry succeeds");

}

async function run() {

    await testArchiveCreation();
    await testUploadSuccess();
    testR2ConfigIgnoresGcsEnv();
    await testUploadFailureBlocksLifecycle();

    console.log("forensicArchive.test.js: all assertions passed");

}

run().catch((error) => {

    console.error(error);
    process.exit(1);

});
