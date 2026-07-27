/**
 * R6.2C — GameDiagnosticLogManager post-mortem report checks.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameDiagnosticLogManager } from "../logging/GameDiagnosticLogManager.js";
import { LoggingManager } from "../logging/LoggingManager.js";
import { LOG_LEVELS } from "../logging/levels.js";
import { LoggerService } from "../services/LoggerService.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function createHarness(directory) {

    LoggingManager.resetForTests();

    GameDiagnosticLogManager.resetForTests();

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

    const diagnostics = GameDiagnosticLogManager.getInstance();

    diagnostics.initialize({
        enabled: true,
        eventBus,
        loggingManager,
        directory
    });

    return { diagnostics, eventBus, loggingManager, logger };

}

function teardown(harness) {

    harness.diagnostics.shutdown();

    harness.eventBus.shutdown();

    harness.logger.shutdown();

    LoggingManager.resetForTests();

    GameDiagnosticLogManager.resetForTests();

}

const directory = mkdtempSync(join(tmpdir(), "wheelwin-diag-r62c-"));

// ---------------------------------------------------------------------------
// A. Normal game → SUMMARY GAME_COMPLETED + renamed file
// ---------------------------------------------------------------------------

{

    const harness = createHarness(directory);

    const { diagnostics, eventBus } = harness;

    const roomId = "NORMAL01";

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.SETUP_SESSION_STARTED,
        payload: { roomId, setupSessionId: "s1", expiresAt: Date.now() + 60_000 }
    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.ROOM_CREATED,
        payload: { roomId, status: "CREATED", maxPlayers: 3, playerCount: 0 }
    });

    for (let i = 1; i <= 3; i += 1) {

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PLAYER_JOINED,
            payload: { roomId, playerId: `player_${i}`, playerCount: i }
        });

    }

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.SETUP_SESSION_COMPLETED,
        payload: { roomId }
    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAME_CREATED,
        payload: { roomId, gameId: "game_normal" }
    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAME_INITIALIZED,
        payload: { roomId, gameId: "game_normal" }
    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.SESSION_FINISHED,
        payload: { roomId, gameId: "game_normal" }
    });

    const filePath = diagnostics.getLogPath(roomId);

    assert(filePath, "A: closed log path must exist");

    assert(
        basename(filePath).endsWith("_GAME_COMPLETED.log"),
        `A: filename must end with GAME_COMPLETED, got ${basename(filePath)}`
    );

    const text = diagnostics.readLog(roomId).toString("utf8");

    assert(text.includes("SUMMARY"), "A: must include SUMMARY");

    assert(text.includes("Room result:\nGAME_COMPLETED"), "A: room result GAME_COMPLETED");

    assert(text.includes("CHECKLIST"), "A: must include CHECKLIST");

    assert(text.includes("ROOM_CREATED") && text.includes("OK"), "A: checklist ROOM_CREATED OK");

    assert(text.includes("GAME_INITIALIZED") && text.includes("OK"), "A: checklist GAME_INITIALIZED");

    console.log("  A normal game → GAME_COMPLETED passed");

    teardown(harness);

}

// ---------------------------------------------------------------------------
// B. Setup timeout → SETUP_EXPIRED filename
// ---------------------------------------------------------------------------

{

    const harness = createHarness(directory);

    const { diagnostics, eventBus } = harness;

    const roomId = "EXPIRED1";

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.SETUP_SESSION_STARTED,
        payload: { roomId, expiresAt: Date.now() - 1 }
    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.ROOM_CREATED,
        payload: { roomId, status: "CREATED", maxPlayers: 3, playerCount: 0 }
    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.SETUP_SESSION_EXPIRED,
        payload: { roomId }
    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.ROOM_DESTROYED,
        payload: { roomId, status: "DESTROYED", maxPlayers: 3, playerCount: 0 }
    });

    const filePath = diagnostics.getLogPath(roomId);

    assert(
        basename(filePath).endsWith("_SETUP_EXPIRED.log"),
        `B: filename must end with SETUP_EXPIRED, got ${basename(filePath)}`
    );

    const text = diagnostics.readLog(roomId).toString("utf8");

    assert(text.includes("Room result:\nSETUP_EXPIRED"), "B: room result SETUP_EXPIRED");

    assert(text.includes("Setup Session:\nEXPIRED"), "B: setup EXPIRED");

    console.log("  B setup timeout → SETUP_EXPIRED passed");

    teardown(harness);

}

// ---------------------------------------------------------------------------
// C. Recovery success → checklist recovery stages OK
// ---------------------------------------------------------------------------

{

    const harness = createHarness(directory);

    const { diagnostics, eventBus, loggingManager } = harness;

    const roomId = "RECSUCC1";

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.SETUP_SESSION_STARTED,
        payload: { roomId, expiresAt: Date.now() + 60_000 }
    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.ROOM_CREATED,
        payload: { roomId, status: "CREATED", maxPlayers: 3, playerCount: 0 }
    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PLAYER_JOINED,
        payload: { roomId, playerId: "player_1", playerCount: 1 }
    });

    loggingManager.write({
        level: LOG_LEVELS.INFO,
        service: "test",
        message: "[R6.2A Recovery] soft disconnect | roomId=RECSUCC1 | playerId=player_1 | socket.id=sock-old",
        fields: { roomId, playerId: "player_1", socketId: "sock-old" }
    });

    loggingManager.write({
        level: LOG_LEVELS.INFO,
        service: "test",
        message: "[R6.2A Recovery] SESSION_RECOVERY_REQUEST received | roomId=RECSUCC1 | playerId=player_1 | socket.id=sock-new",
        fields: { roomId, playerId: "player_1", socketId: "sock-new" }
    });

    loggingManager.write({
        level: LOG_LEVELS.INFO,
        service: "test",
        message: "[R6.2A Recovery] stash lookup | roomId=RECSUCC1 | playerId=player_1 | socket.id=sock-new | result=hit",
        fields: { roomId, playerId: "player_1", socketId: "sock-new" }
    });

    loggingManager.write({
        level: LOG_LEVELS.INFO,
        service: "test",
        message: "[R6.2A Recovery] socket rebound | roomId=RECSUCC1 | playerId=player_1 | socket.id=sock-new",
        fields: { roomId, playerId: "player_1", socketId: "sock-new" }
    });

    loggingManager.write({
        level: LOG_LEVELS.INFO,
        service: "test",
        message: "[R6.2A Recovery] SETUP_SESSION_SYNC emitted | roomId=RECSUCC1 | playerId=player_1 | socket.id=sock-new",
        fields: { roomId, playerId: "player_1", socketId: "sock-new" }
    });

    loggingManager.write({
        level: LOG_LEVELS.INFO,
        service: "test",
        message: "[R6.2A Recovery] reclaim success | roomId=RECSUCC1 | playerId=player_1 | socket.id=sock-new",
        fields: { roomId, playerId: "player_1", socketId: "sock-new" }
    });

    loggingManager.flushSync();

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAME_INITIALIZED,
        payload: { roomId, gameId: "game_rec" }
    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.ROOM_DESTROYED,
        payload: { roomId, status: "DESTROYED", maxPlayers: 3, playerCount: 1 }
    });

    const text = diagnostics.readLog(roomId).toString("utf8");

    assert(/SESSION_RECOVERY_REQUEST\.+OK/.test(text), "C: SESSION_RECOVERY_REQUEST OK");

    assert(/PLAYER_FOUND\.+OK/.test(text), "C: PLAYER_FOUND OK");

    assert(/SOCKET_REBOUND\.+OK/.test(text), "C: SOCKET_REBOUND OK");

    assert(/SETUP_SESSION_SYNC\.+OK/.test(text), "C: SETUP_SESSION_SYNC OK");

    assert(/RECOVERY_COMPLETED\.+OK/.test(text), "C: RECOVERY_COMPLETED OK");

    assert(text.includes("Attempt #1\n\nSUCCESS"), "C: attempt summary SUCCESS");

    assert(
        !text.includes("RECOVERY FAILURE"),
        "C: must not include RECOVERY FAILURE section"
    );

    console.log("  C recovery success → checklist OK passed");

    teardown(harness);

}

// ---------------------------------------------------------------------------
// D. Recovery failure → failed stage + RECOVERY FAILURE section
// ---------------------------------------------------------------------------

{

    const harness = createHarness(directory);

    const { diagnostics, eventBus, loggingManager } = harness;

    const roomId = "RECFAIL1";

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.SETUP_SESSION_STARTED,
        payload: { roomId, expiresAt: Date.now() + 60_000 }
    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.ROOM_CREATED,
        payload: { roomId, status: "CREATED", maxPlayers: 3, playerCount: 0 }
    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PLAYER_JOINED,
        payload: { roomId, playerId: "player_1", playerCount: 1 }
    });

    loggingManager.write({
        level: LOG_LEVELS.INFO,
        service: "test",
        message: "[R6.2A Recovery] soft disconnect | roomId=RECFAIL1 | playerId=player_1 | socket.id=sock-old",
        fields: { roomId, playerId: "player_1", socketId: "sock-old" }
    });

    loggingManager.write({
        level: LOG_LEVELS.INFO,
        service: "test",
        message: "[R6.2A Recovery] SESSION_RECOVERY_REQUEST received | roomId=RECFAIL1 | playerId=player_1 | socket.id=sock-new",
        fields: { roomId, playerId: "player_1", socketId: "sock-new" }
    });

    loggingManager.write({
        level: LOG_LEVELS.INFO,
        service: "test",
        message: "[R6.2A Recovery] stash lookup | roomId=RECFAIL1 | playerId=player_1 | socket.id=sock-new | result=hit",
        fields: { roomId, playerId: "player_1", socketId: "sock-new" }
    });

    loggingManager.write({
        level: LOG_LEVELS.INFO,
        service: "test",
        message: "[R6.2A Recovery] reclaim failure | roomId=RECFAIL1 | playerId=player_1 | socket.id=sock-new | reason=Recovery identity is not authorized",
        fields: { roomId, playerId: "player_1", socketId: "sock-new" }
    });

    loggingManager.flushSync();

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.ROOM_DESTROYED,
        payload: { roomId, status: "DESTROYED", maxPlayers: 3, playerCount: 1 }
    });

    const filePath = diagnostics.getLogPath(roomId);

    assert(
        basename(filePath).endsWith("_RECOVERY_FAILED.log"),
        `D: filename must end with RECOVERY_FAILED, got ${basename(filePath)}`
    );

    const text = diagnostics.readLog(roomId).toString("utf8");

    assert(text.includes("RECOVERY FAILURE"), "D: must include RECOVERY FAILURE");

    assert(text.includes("SOCKET_REBOUND"), "D: failure point SOCKET_REBOUND");

    assert(text.includes("Recovery identity is not authorized"), "D: failure reason");

    assert(/PLAYER_FOUND\.+OK/.test(text), "D: PLAYER_FOUND still OK");

    assert(/SOCKET_REBOUND\.+FAILED/.test(text), "D: SOCKET_REBOUND FAILED");

    assert(text.includes("Attempt #1\n\nFAILED"), "D: attempt summary FAILED");

    assert(existsSync(filePath), "D: renamed file must exist on disk");

    console.log("  D recovery failure → RECOVERY FAILURE passed");

    teardown(harness);

}

// ---------------------------------------------------------------------------
// E. Room destroyed before gameplay → ROOM_DESTROYED
// ---------------------------------------------------------------------------

{

    const harness = createHarness(directory);

    const { diagnostics, eventBus } = harness;

    const roomId = "EARLYDST";

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.SETUP_SESSION_STARTED,
        payload: { roomId, expiresAt: Date.now() + 60_000 }
    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.ROOM_CREATED,
        payload: { roomId, status: "CREATED", maxPlayers: 3, playerCount: 0 }
    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PLAYER_JOINED,
        payload: { roomId, playerId: "player_1", playerCount: 1 }
    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.ROOM_DESTROYED,
        payload: { roomId, status: "DESTROYED", maxPlayers: 3, playerCount: 1 }
    });

    const filePath = diagnostics.getLogPath(roomId);

    assert(
        basename(filePath).endsWith("_ROOM_DESTROYED.log"),
        `E: filename must end with ROOM_DESTROYED, got ${basename(filePath)}`
    );

    const text = diagnostics.readLog(roomId).toString("utf8");

    assert(text.includes("Room result:\nROOM_DESTROYED"), "E: room result ROOM_DESTROYED");

    assert(text.includes("Gameplay:\nNOT_STARTED"), "E: gameplay NOT_STARTED");

    assert(/GAME_INITIALIZED\.+NO/.test(text), "E: GAME_INITIALIZED NO");

    console.log("  E early destroy → ROOM_DESTROYED passed");

    teardown(harness);

}

// ---------------------------------------------------------------------------
// Production gate
// ---------------------------------------------------------------------------

{

    const harness = createHarness(directory);

    GameDiagnosticLogManager.resetForTests();

    const disabled = GameDiagnosticLogManager.getInstance();

    disabled.initialize({
        enabled: false,
        eventBus: harness.eventBus,
        loggingManager: harness.loggingManager,
        directory
    });

    assert(!disabled.isEnabled(), "disabled diagnostics must not enable");

    harness.eventBus.emit({
        source: "test",
        type: EVENT_TYPES.SETUP_SESSION_STARTED,
        payload: { roomId: "NOP", expiresAt: Date.now() }
    });

    assert(disabled.getLogPath("NOP") === null, "disabled must not open files");

    disabled.shutdown();

    harness.eventBus.shutdown();

    harness.logger.shutdown();

    LoggingManager.resetForTests();

    GameDiagnosticLogManager.resetForTests();

    console.log("  production gate passed");

}

rmSync(directory, { recursive: true, force: true });

console.log("gameDiagnosticLogManager.test.js: all assertions passed");
