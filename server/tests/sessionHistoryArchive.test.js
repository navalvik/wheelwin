import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus } from "../events/EventBus.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    LIFECYCLE_RESULTS,
    SessionHistoryArchiveManager
} from "../history/SessionHistoryArchiveManager.js";
import { LoggingManager } from "../logging/LoggingManager.js";
import { LOG_LEVELS } from "../logging/levels.js";
import { LoggerService } from "../services/LoggerService.js";

SessionHistoryArchiveManager.resetForTests();
LoggingManager.resetForTests();

const directory = mkdtempSync(join(tmpdir(), "wheelwin-history-"));

const loggingManager = LoggingManager.getInstance();

loggingManager.initialize({
    level: LOG_LEVELS.INFO,
    enableConsole: false,
    enableFile: false,
    format: "console"
});

const logger = new LoggerService({ loggingManager });

logger.initialize();

const eventBus = new EventBus({
    logger,
    eventBusConfig: { logEvents: false, showDebugPanel: false }
});

eventBus.initialize();

const archive = SessionHistoryArchiveManager.getInstance();

archive.initialize({
    eventBus,
    directory,
    projectionService: {
        buildRoomDetail: () => null
    },
    roomLobbyBridge: {
        getTonConnectDiagnostics: () => null
    },
    playerManager: {
        getPlayer: () => null
    }
});

function emit(type, payload) {

    eventBus.emit({
        source: EVENT_SOURCES.ROOM_MANAGER,
        type,
        payload
    });

}

emit(EVENT_TYPES.ROOM_CREATED, {
    roomId: "ROOMTEST1",
    createdAt: Date.now() - 5000
});

emit(EVENT_TYPES.SETUP_SESSION_STARTED, { roomId: "ROOMTEST1" });

emit(EVENT_TYPES.SETUP_SESSION_EXPIRED, { roomId: "ROOMTEST1" });

emit(EVENT_TYPES.ROOM_DESTROYED, { roomId: "ROOMTEST1", playerCount: 0 });

const listed = archive.listRecords({ roomId: "ROOMTEST1" });

assert.equal(listed.total, 1, "one archived record");
assert.equal(
    listed.records[0].lifecycleResult,
    LIFECYCLE_RESULTS.SETUP_EXPIRED,
    "setup expiry maps to SETUP_EXPIRED"
);

const full = archive.getRecord(listed.records[0].sessionId);

assert.ok(full, "full record readable");
assert.equal(full.lifecycleResult, LIFECYCLE_RESULTS.SETUP_EXPIRED);
assert.ok(Array.isArray(full.timeline) && full.timeline.length > 0);
assert.ok(full.downloadFilename.includes("SETUP_EXPIRED"));
assert.ok(full.downloadFilename.includes("NO_GAME"));

const download = archive.getDownloadBuffer(listed.records[0].sessionId);

assert.ok(download?.buffer?.length > 0, "download buffer present");

archive.shutdown();
eventBus.shutdown();
logger.shutdown();
SessionHistoryArchiveManager.resetForTests();
LoggingManager.resetForTests();
rmSync(directory, { recursive: true, force: true });

console.log("sessionHistoryArchive.test.js: all assertions passed");
