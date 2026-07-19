/**
 * C4.10 — Replay Validation.
 *
 * Proves Gameplay Core v1.0 can execute THREE complete game sessions
 * consecutively without accumulating any gameplay state. Each game runs the full
 * authoritative lifecycle (lobby -> ROOM_FULL -> COUNTDOWN -> SELF_TEST -> SPEED
 * -> BRAKE -> RESULT -> Winner -> Payment -> Audit -> Cleanup -> return to Page1)
 * through the real production wiring.
 *
 * The test captures a Baseline snapshot of every runtime counter before Game #1
 * and re-captures it after each Cleanup. Every counter must return to Baseline;
 * any drift fails the test. This changes no gameplay behavior — it only observes.
 * The "[C4.10]" logs are temporary validation instrumentation for this stage.
 */
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { GameManager } from "../managers/GameManager.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { LoggerService } from "../services/LoggerService.js";
import { GameplayContextResolver } from "../socket/GameplayContextResolver.js";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";
import { SocketGateway } from "../socket/SocketGateway.js";
import { GameClockBroadcaster } from "../gameplay/GameClockBroadcaster.js";
import { RecoveryEngine } from "../engines/RecoveryEngine.js";
import { AuditEngine } from "../engines/AuditEngine.js";
import { AuditActivation } from "../gameplay/AuditActivation.js";
import http from "http";
import {
    emitEntryPaymentCompleted,
    exhaustAllPlayerInput,
    shutdownGameplayBootstrap,
    wireGameplayBootstrap
} from "./helpers/gameplayBootstrapHarness.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

async function poll(predicate, { timeoutMs = 5000, intervalMs = 5 } = {}) {

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {

        if (predicate()) {

            return true;

        }

        await wait(intervalMs);

    }

    return false;

}

function totalSubscribers(eventBus) {

    return eventBus
        .getDebugSnapshot()
        .registeredEvents
        .reduce((sum, entry) => sum + entry.subscriberCount, 0);

}

function normalizePlayerId(entry) {

    if (typeof entry === "string") {

        return entry;

    }

    return entry?.playerId ?? entry?.id ?? null;

}

// ---------------------------------------------------------------------------
// Full authoritative stack (identical to production wiring).
// ---------------------------------------------------------------------------

const logger = new LoggerService({ logLevel: "error" });

logger.initialize();

const eventBus = new EventBus({
    logger,
    eventBusConfig: { logEvents: false, showDebugPanel: false }
});

eventBus.initialize();

const roomManager = new RoomManager({
    logger,
    eventBus,
    roomConfig: { maxPlayers: 3 }
});

const playerManager = new PlayerManager({ logger, eventBus });

const gameManager = new GameManager({ logger, eventBus });

roomManager.initialize();

playerManager.initialize();

gameManager.initialize();

const gameplayContextResolver = new GameplayContextResolver({
    logger,
    playerManager,
    roomManager
});

const harness = wireGameplayBootstrap({
    gameManager,
    roomManager,
    playerManager,
    logger,
    eventBus,
    gameplayContextResolver,
    devMode: false,
    enableLifecycle: true
});

const recoveryEngine = new RecoveryEngine({
    logger,
    eventBus,
    gameCatalog: harness.catalog,
    configurationEngine: harness.configurationEngine,
    gameStateEngine: harness.gameStateEngine,
    gameClock: harness.gameClockEngine,
    physicsEngine: harness.physicsEngine,
    inputAuthority: harness.inputAuthority,
    winnerEngine: harness.winnerEngine,
    paymentEngine: harness.paymentEngine
});

recoveryEngine.initialize();

const auditEngine = new AuditEngine({
    logger,
    eventBus,
    gameCatalog: harness.catalog,
    configurationEngine: harness.configurationEngine,
    gameStateEngine: harness.gameStateEngine,
    gameClock: harness.gameClockEngine,
    physicsEngine: harness.physicsEngine,
    inputAuthority: harness.inputAuthority,
    winnerEngine: harness.winnerEngine,
    paymentEngine: harness.paymentEngine,
    recoveryEngine
});

auditEngine.initialize();

const auditActivation = new AuditActivation({
    logger,
    eventBus,
    auditEngine,
    devMode: false
});

auditActivation.initialize();

harness.gameplayLifecycle.configureAudit({ auditEngine, auditActivation });

const gameClockBroadcaster = new GameClockBroadcaster({
    logger,
    eventBus,
    gameClockEngine: harness.gameClockEngine,
    intervalMs: 50,
    devMode: false
});

gameClockBroadcaster.initialize();

const roomLobbyBridge = new RoomLobbyBridge({
    logger,
    eventBus,
    roomManager,
    playerManager,
    gameplayContextResolver
});

roomLobbyBridge.initialize();

const httpServer = http.createServer();

const socketGateway = new SocketGateway({
    logger,
    socketConfig: { cors: { origin: "*" } },
    eventBus,
    inputAuthority: harness.inputAuthority,
    gameplayContextResolver,
    devMode: false
});

socketGateway.initialize(httpServer);

socketGateway.connectEventBus(eventBus);

await new Promise((resolve) => {

    httpServer.listen(0, "127.0.0.1", resolve);

});

// -------------------------------------------------------------------
// Per-game capture (updated by observers; reset each game).
// -------------------------------------------------------------------

const current = { gameId: null, roster: [], cleanupCompleted: false };

eventBus.subscribe(EVENT_TYPES.GAME_CREATED, (envelope) => {

    current.gameId = envelope.payload?.gameId;

    current.roster = (envelope.payload?.players ?? [])
        .map(normalizePlayerId)
        .filter(Boolean);

});

eventBus.subscribe(EVENT_TYPES.CLEANUP_COMPLETED, () => {

    current.cleanupCompleted = true;

});

// -------------------------------------------------------------------
// Runtime counter snapshot. Every counter listed in the C4.10 spec.
// Counters without a public getter are read (read-only) from the owning
// component's internal map — this is test-only introspection, no code change.
// -------------------------------------------------------------------

function snapshot() {

    return {
        "SimulationLoop": harness.simulationLoop.getActiveGameCount(),
        "PhysicsEngine": harness.physicsEngine.getActiveSimulationCount(),
        "GameClockEngine": harness.gameClockEngine.getActiveClockCount(),
        "GameClockBroadcaster": gameClockBroadcaster.getActiveBroadcastCount(),
        "SpeedActivation": harness.speedActivation.getActiveGameCount(),
        "OfflineInputContinuation":
            harness.offlineInputContinuation.getActiveContinuations().length,
        "WinnerEngine": harness.winnerEngine._results.size,
        "RecoveryEngine": recoveryEngine._snapshots.size,
        "PaymentEngine": harness.paymentEngine.getActivePaymentCount(),
        "AuditEngine": auditEngine.getActiveAuditCount(),
        "GameManager": gameManager.getGames().length,
        "RoomManager": roomManager.getRooms().length,
        "ContextResolver.roomGames": gameplayContextResolver._roomGames.size,
        "ContextResolver.socketBindings":
            gameplayContextResolver._socketBindings.size,
        "ConfigurationEngine":
            harness.configurationEngine.listConfigurationIds().length,
        "InputAuthority": harness.inputAuthority._registries.size,
        "GameStateEngine": harness.gameStateEngine._states.size,
        "PlayerRuntimeRegistry": playerManager._runtimes.size,
        "SocketGateway.sockets": socketGateway.getConnectedSocketCount(),
        "EventBus.listeners": totalSubscribers(eventBus),
        "PendingTeardowns": harness.gameplayLifecycle.getPendingTeardownCount()
    };

}

const COUNTER_KEYS = Object.keys(snapshot());

function diff(baseline, other) {

    const mismatches = [];

    for (const key of COUNTER_KEYS) {

        if (baseline[key] !== other[key]) {

            mismatches.push(`${key} (baseline ${baseline[key]} != ${other[key]})`);

        }

    }

    return mismatches;

}

function printTable(baseline, afterGames) {

    const nameWidth = Math.max(...COUNTER_KEYS.map((key) => key.length));

    const header = "Counter".padEnd(nameWidth)
        + " | Base | G#1 | G#2 | G#3";

    console.log(`  ${header}`);

    console.log(`  ${"-".repeat(header.length)}`);

    for (const key of COUNTER_KEYS) {

        const cells = [
            String(baseline[key]).padStart(4),
            String(afterGames[0][key]).padStart(3),
            String(afterGames[1][key]).padStart(3),
            String(afterGames[2][key]).padStart(3)
        ];

        console.log(`  ${key.padEnd(nameWidth)} | ${cells[0]} | `
            + `${cells[1]} | ${cells[2]} | ${cells[3]}`);

    }

}

// -------------------------------------------------------------------
// One full, independent gameplay session driven by lobby events.
// -------------------------------------------------------------------

async function playOneGame(index) {

    console.log(`  [C4.10] GAME #${index} START`);

    current.gameId = null;

    current.roster = [];

    current.cleanupCompleted = false;

    const sockets = [
        `c4.10-g${index}-s1`,
        `c4.10-g${index}-s2`,
        `c4.10-g${index}-s3`
    ];

    eventBus.emit({
        source: EVENT_SOURCES.SOCKET_GATEWAY,
        type: EVENT_TYPES.LOBBY_CREATE_ROOM_REQUEST,
        payload: { socketId: sockets[0] }
    });

    const room = roomManager.getRooms()[0];

    assert(room, `game #${index}: a room should be created`);

    const roomId = room.roomId;

    for (let i = 1; i < sockets.length; i += 1) {

        eventBus.emit({
            source: EVENT_SOURCES.SOCKET_GATEWAY,
            type: EVENT_TYPES.LOBBY_JOIN_ROOM_REQUEST,
            payload: { socketId: sockets[i], roomId }
        });

    }

    const bootstrapped = await poll(() => Boolean(current.gameId));

    assert(bootstrapped, `game #${index}: ROOM_FULL should bootstrap a game`);

    emitEntryPaymentCompleted(eventBus, roomId);

    const gameId = current.gameId;

    assert(current.roster.length === 3, `game #${index}: roster should be 3`);

    const reachedSpeed = await poll(
        () => harness.gameStateEngine.getState(gameId) === GAME_STATES.SPEED
    );

    assert(reachedSpeed, `game #${index}: should reach SPEED`);

    exhaustAllPlayerInput(harness.inputAuthority, gameId, current.roster);

    const tornDown = await poll(
        () => current.cleanupCompleted && !gameManager.hasGame(gameId)
    );

    assert(tornDown, `game #${index}: should complete audit + tear down`);

    // Return to Page1 — deliberate leave releases the recovery-window survivors.
    eventBus.emit({
        source: EVENT_SOURCES.SOCKET_GATEWAY,
        type: EVENT_TYPES.LOBBY_LEAVE_ROOM_REQUEST,
        payload: { socketId: sockets[0] }
    });

    // Let any deferred broadcaster stop / teardown finish before snapshotting.
    await wait(20);

    console.log(`  [C4.10] GAME #${index} CLEANUP COMPLETE`);

    return gameId;

}

// ===========================================================================

async function run() {

    // STEP 1 — Baseline (captured after full wiring + observers subscribed).
    const baseline = snapshot();

    // Baseline must be a genuinely idle server.
    for (const key of COUNTER_KEYS) {

        if (key === "EventBus.listeners") {

            continue;

        }

        assert(
            baseline[key] === 0,
            `baseline ${key} should be 0 on an idle server (got ${baseline[key]})`
        );

    }

    // STEP 2 + 3 — three independent games, compare to baseline after each.
    const afterGames = [];

    for (let index = 1; index <= 3; index += 1) {

        await playOneGame(index);

        const after = snapshot();

        const mismatches = diff(baseline, after);

        assert(
            mismatches.length === 0,
            `game #${index}: counters drifted from baseline -> `
                + mismatches.join(", ")
        );

        afterGames.push(after);

    }

    // STEP 5 — compact comparison table.
    console.log("");

    printTable(baseline, afterGames);

    console.log("");

    // STEP 4 / 6 — explicit replay-consistency (identical across all games).
    for (const key of COUNTER_KEYS) {

        assert(
            afterGames[0][key] === baseline[key]
                && afterGames[1][key] === baseline[key]
                && afterGames[2][key] === baseline[key],
            `counter ${key} must be identical to baseline across all 3 games`
        );

    }

    console.log("  replay consistency verified (3 games, zero accumulation)");

}

// ===========================================================================

try {

    await run();

    console.log(
        "gameplayReplayValidation.integration.test.js: all assertions passed"
    );

} finally {

    await socketGateway.shutdown();

    roomLobbyBridge.shutdown();

    gameClockBroadcaster.shutdown();

    auditActivation.shutdown();

    auditEngine.shutdown();

    recoveryEngine.shutdown();

    shutdownGameplayBootstrap(harness);

    gameManager.shutdown();

    playerManager.shutdown();

    roomManager.shutdown();

    eventBus.shutdown();

    logger.shutdown();

    await new Promise((resolve) => {

        if (!httpServer.listening) {

            resolve();

            return;

        }

        httpServer.close(() => resolve());

    });

}
