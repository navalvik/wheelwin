/**
 * C4.11 — Long Run Stability.
 *
 * Proves Gameplay Core v1.0 remains stable after FIFTY consecutive complete
 * gameplay sessions. Each session runs the full authoritative lifecycle through
 * the real production wiring. After EVERY Cleanup all runtime counters must
 * match the Baseline exactly; any drift fails immediately.
 *
 * This test changes no gameplay behavior — it only observes. The "[C4.11]"
 * logs are temporary validation instrumentation for this stage.
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
    completeRoomProfilesForConfiguration,
    emitEntryPaymentCompleted,
    exhaustAllPlayerInput,
    shutdownGameplayBootstrap,
    wireGameplayBootstrap
} from "./helpers/gameplayBootstrapHarness.js";

const LONG_RUN_GAMES = 50;

const MILESTONE_GAMES = [10, 20, 30, 40, 50];

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

function countSocketGatewayGameplayListeners(gateway) {

    let count = 0;

    for (const key in gateway) {

        if (key.endsWith("Handler") && gateway[key]) {

            count += 1;

        }

    }

    return count;

}

function normalizePlayerId(entry) {

    if (typeof entry === "string") {

        return entry;

    }

    return entry?.playerId ?? entry?.id ?? null;

}

function formatMemory(memory) {

    const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

    return `rss=${mb(memory.rss)} heapUsed=${mb(memory.heapUsed)} `
        + `heapTotal=${mb(memory.heapTotal)} external=${mb(memory.external)}`;

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

const current = { gameId: null, roomId: null, roster: [], cleanupCompleted: false };

eventBus.subscribe(EVENT_TYPES.GAME_CREATED, (envelope) => {

    current.gameId = envelope.payload?.gameId;

    current.roster = (envelope.payload?.players ?? [])
        .map(normalizePlayerId)
        .filter(Boolean);

});

eventBus.subscribe(EVENT_TYPES.GAME_INITIALIZED, (envelope) => {

    current.roomId = envelope.payload?.roomId ?? null;

});

eventBus.subscribe(EVENT_TYPES.CLEANUP_COMPLETED, () => {

    current.cleanupCompleted = true;

});

// -------------------------------------------------------------------
// Runtime counter snapshot — every counter listed in the C4.11 spec.
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
        "SocketGateway.gameplayListeners":
            countSocketGatewayGameplayListeners(socketGateway),
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

function assertMatchesBaseline(baseline, after, gameIndex) {

    const mismatches = diff(baseline, after);

    assert(
        mismatches.length === 0,
        `game #${gameIndex}: counters drifted from baseline -> `
            + mismatches.join(", ")
    );

}

function printMilestoneTable(baseline, milestoneSnapshots) {

    const labels = ["Base", ...milestoneSnapshots.map((entry) => `G#${entry.game}`)];

    const nameWidth = Math.max(...COUNTER_KEYS.map((key) => key.length));

    const colWidth = 4;

    const header = "Counter".padEnd(nameWidth)
        + labels.map((label) => ` | ${label.padStart(colWidth)}`).join("");

    console.log(`  ${header}`);

    console.log(`  ${"-".repeat(header.length)}`);

    for (const key of COUNTER_KEYS) {

        const cells = [
            String(baseline[key]).padStart(colWidth),
            ...milestoneSnapshots.map(
                (entry) => String(entry.snapshot[key]).padStart(colWidth)
            )
        ];

        console.log(`  ${key.padEnd(nameWidth)}`
            + cells.map((cell) => ` | ${cell}`).join(""));

    }

}

// -------------------------------------------------------------------
// One full, independent gameplay session driven by lobby events.
// -------------------------------------------------------------------

async function playOneGame(index, seenGameIds, seenRoomIds) {

    current.gameId = null;

    current.roomId = null;

    current.roster = [];

    current.cleanupCompleted = false;

    const roomsBefore = roomManager.getRooms().length;

    const sockets = [
        `c4.11-g${index}-s1`,
        `c4.11-g${index}-s2`,
        `c4.11-g${index}-s3`
    ];

    eventBus.emit({
        source: EVENT_SOURCES.SOCKET_GATEWAY,
        type: EVENT_TYPES.LOBBY_CREATE_ROOM_REQUEST,
        payload: { socketId: sockets[0] }
    });

    assert(
        roomManager.getRooms().length === roomsBefore + 1,
        `game #${index}: a new room should be created`
    );

    const room = roomManager.getRooms().find(
        (entry) => !seenRoomIds.has(entry.roomId)
    );

    assert(room, `game #${index}: new room should be distinct`);

    const roomId = room.roomId;

    seenRoomIds.add(roomId);

    for (let i = 1; i < sockets.length; i += 1) {

        eventBus.emit({
            source: EVENT_SOURCES.SOCKET_GATEWAY,
            type: EVENT_TYPES.LOBBY_JOIN_ROOM_REQUEST,
            payload: { socketId: sockets[i], roomId }
        });

    }

    const bootstrapped = await poll(() => Boolean(current.gameId));

    assert(bootstrapped, `game #${index}: ROOM_FULL should bootstrap a game`);

    completeRoomProfilesForConfiguration(playerManager, eventBus, room);

    emitEntryPaymentCompleted(eventBus, roomId);

    const gameId = current.gameId;

    assert(
        !seenGameIds.has(gameId),
        `game #${index}: gameId must not reuse a previous session`
    );

    seenGameIds.add(gameId);

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

    // Return to Page1 — deliberate leave releases recovery-window survivors.
    eventBus.emit({
        source: EVENT_SOURCES.SOCKET_GATEWAY,
        type: EVENT_TYPES.LOBBY_LEAVE_ROOM_REQUEST,
        payload: { socketId: sockets[0] }
    });

    await wait(20);

    return { gameId, roomId };

}

// ===========================================================================

async function run() {

    // STEP 1 — Baseline (captured after full wiring + observers subscribed).
    const baseline = snapshot();

    for (const key of COUNTER_KEYS) {

        if (key === "EventBus.listeners"
            || key === "SocketGateway.gameplayListeners") {

            continue;

        }

        assert(
            baseline[key] === 0,
            `baseline ${key} should be 0 on an idle server (got ${baseline[key]})`
        );

    }

    // STEP 6 — observational memory before Game #1.
    const memoryBefore = process.memoryUsage();

    console.log(`  [C4.11] memory before Game #1: ${formatMemory(memoryBefore)}`);

    const seenGameIds = new Set();

    const seenRoomIds = new Set();

    const milestoneSnapshots = [];

    const startedAt = Date.now();

    // STEP 2 + 3 — fifty independent games; fail immediately on any drift.
    for (let index = 1; index <= LONG_RUN_GAMES; index += 1) {

        await playOneGame(index, seenGameIds, seenRoomIds);

        const after = snapshot();

        assertMatchesBaseline(baseline, after, index);

        if (MILESTONE_GAMES.includes(index)) {

            milestoneSnapshots.push({ game: index, snapshot: after });

            console.log(`  [C4.11] milestone Game #${index} verified`);

        }

    }

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

    // STEP 6 — observational memory after Game #50.
    const memoryAfter = process.memoryUsage();

    console.log(`  [C4.11] memory after Game #${LONG_RUN_GAMES}: `
        + `${formatMemory(memoryAfter)}`);

    // STEP 5 — compact milestone report.
    console.log("");

    printMilestoneTable(baseline, milestoneSnapshots);

    console.log("");

    console.log(
        `  long-run stability verified (${LONG_RUN_GAMES} games in ${elapsedSec}s, `
            + `${seenGameIds.size} unique gameIds, ${seenRoomIds.size} unique rooms)`
    );

}

// ===========================================================================

try {

    await run();

    console.log(
        "gameplayLongRunStability.integration.test.js: all assertions passed"
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
