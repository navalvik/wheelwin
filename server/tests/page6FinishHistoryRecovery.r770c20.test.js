/**
 * R7.70C20 — Page6 FINISH isolation, GAME_COMPLETED history finalize,
 * reconnect overlay without RETURN LOBBY.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { EventBus } from "../events/EventBus.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    LIFECYCLE_RESULTS,
    SessionHistoryArchiveManager
} from "../history/SessionHistoryArchiveManager.js";
import { LoggingManager } from "../logging/LoggingManager.js";
import { LOG_LEVELS } from "../logging/levels.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { ROOM_STATUS } from "../models/RoomStatus.js";
import { RoomManager } from "../managers/RoomManager.js";
import { LoggerService } from "../services/LoggerService.js";

SessionHistoryArchiveManager.resetForTests();
LoggingManager.resetForTests();

const directory = mkdtempSync(join(tmpdir(), "wheelwin-c20-"));

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
    projectionService: { buildRoomDetail: () => null },
    roomLobbyBridge: { getTonConnectDiagnostics: () => null },
    playerManager: { getPlayer: () => null }
});

function emit(type, payload) {
    eventBus.emit({
        source: EVENT_SOURCES.ROOM_MANAGER,
        type,
        payload
    });
}

// --- TEST C + D: History finalizes on OPEN_PAGE6 without FINISH; idempotent ---

emit(EVENT_TYPES.ROOM_CREATED, {
    roomId: "C20HIST",
    createdAt: Date.now() - 5000
});

emit(EVENT_TYPES.GAME_CREATED, {
    roomId: "C20HIST",
    gameId: "game_c20"
});

emit(EVENT_TYPES.OPEN_PAGE6, {
    roomId: "C20HIST",
    gameId: "game_c20"
});

const listed1 = archive.listRecords({ roomId: "C20HIST" });
assert.equal(listed1.total, 1, "TEST C: one archive after OPEN_PAGE6");
assert.equal(
    listed1.records[0].lifecycleResult,
    LIFECYCLE_RESULTS.GAME_COMPLETED,
    "TEST C: GAME_COMPLETED without player FINISH"
);

emit(EVENT_TYPES.OPEN_PAGE6, {
    roomId: "C20HIST",
    gameId: "game_c20"
});

emit(EVENT_TYPES.SESSION_FINISHED, {
    roomId: "C20HIST",
    gameId: "game_c20",
    reason: "session_ended"
});

emit(EVENT_TYPES.ROOM_DESTROYED, {
    roomId: "C20HIST",
    playerCount: 0
});

const listed2 = archive.listRecords({ roomId: "C20HIST" });
assert.equal(listed2.total, 1, "TEST D: still exactly one archive (idempotent)");

console.log("  TEST C/D history finalize on OPEN_PAGE6 + idempotent: OK");

// --- TEST A/B support: locked-room per-player remove ---

const roomManager = new RoomManager({
    logger,
    eventBus,
    roomConfig: { maxPlayers: 3 }
});
roomManager.initialize();

const setupLifecycle = new SetupSessionLifecycle({
    logger,
    eventBus,
    roomManager,
    roomConfig: { setupDurationMs: 5 * 60 * 1000 }
});
setupLifecycle.initialize();
roomManager.attachSetupSessionLifecycle(setupLifecycle);

const room = roomManager.createRoom();
assert.ok(room, "room created for leave isolation");
const roomId = room.roomId;
roomManager.addPlayer(roomId, "bob");
roomManager.addPlayer(roomId, "olga");
roomManager.addPlayer(roomId, "lena");
roomManager.lockRoom(roomId);

assert.equal(
    roomManager.getRoom(roomId).status,
    ROOM_STATUS.LOCKED,
    "room locked for gameplay/result"
);

assert.equal(
    roomManager.removePlayer(roomId, "bob"),
    false,
    "default remove blocked while locked"
);

assert.equal(
    roomManager.removePlayer(roomId, "bob", { allowLocked: true }),
    true,
    "TEST A/B: Bob can leave locked result room alone"
);

const remaining = roomManager.getRoom(roomId);
assert.ok(remaining, "room still exists after Bob leave");
assert.deepEqual(
    remaining.players.slice().sort(),
    ["lena", "olga"],
    "TEST A/B: Olga and Lena remain"
);

assert.equal(
    roomManager.removePlayer(roomId, "olga", { allowLocked: true }),
    true,
    "Olga independent leave"
);
assert.deepEqual(
    roomManager.getRoom(roomId).players,
    ["lena"],
    "Lena still in room"
);

console.log("  TEST A/B per-player locked leave: OK");

// --- TEST E: Recovery overlay has no RETURN LOBBY ---

const overlaySrc = readFileSync(
    fileURLToPath(
        new URL("../../client/src/components/RecoveryOverlay.jsx", import.meta.url)
    ),
    "utf8"
);
assert.ok(
    !/Return to Lobby/i.test(overlaySrc),
    "TEST E: RecoveryOverlay must not render RETURN LOBBY"
);
assert.ok(
    !/returnToLobby/.test(overlaySrc),
    "TEST E: RecoveryOverlay must not bind returnToLobby"
);

console.log("  TEST E reconnect overlay no RETURN LOBBY: OK");

archive.shutdown();
eventBus.shutdown();
logger.shutdown();
setupLifecycle.shutdown();
roomManager.shutdown?.();
SessionHistoryArchiveManager.resetForTests();
LoggingManager.resetForTests();
rmSync(directory, { recursive: true, force: true });

console.log("page6FinishHistoryRecovery.r770c20.test.js: all assertions passed");
