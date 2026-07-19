/**
 * C4.9 — Gameplay Completion Validation & Full Cleanup.
 *
 * Drives ONE complete gameplay session through the real authoritative pipeline,
 * exactly as production wires it, and proves that after the game finishes and the
 * clients return to Page1 the server holds ZERO active gameplay objects.
 *
 * Flow validated:
 *   Lobby (create/join x3)  -> ROOM_FULL -> game bootstrap
 *   COUNTDOWN -> SELF_TEST -> SPEED (ends on authoritative input exhaustion)
 *   -> BRAKE -> RESULT -> Winner -> Payment -> Audit -> Cleanup -> Destroy Game
 *   -> Return to Page1 (deliberate leave) -> Destroy Room + mapping
 *
 * This test changes no gameplay behavior; it only observes the pipeline. The
 * diagnostic "[C4.9]" log lines below are temporary lifecycle instrumentation
 * for this validation stage (they subscribe to already-emitted events only).
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
import { GameClockBroadcaster } from "../gameplay/GameClockBroadcaster.js";
import { RecoveryEngine } from "../engines/RecoveryEngine.js";
import { AuditEngine } from "../engines/AuditEngine.js";
import { AuditActivation } from "../gameplay/AuditActivation.js";
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

// Sum of live EventBus subscribers across every registered event. Used to prove
// a completed game leaves no orphan subscriptions behind (all component
// subscriptions are registered once at init, never per-game).
function totalSubscribers(eventBus) {

    return eventBus
        .getDebugSnapshot()
        .registeredEvents
        .reduce((sum, entry) => sum + entry.subscriberCount, 0);

}

// ---------------------------------------------------------------------------
// Full authoritative stack (gameplay core + speed + offline continuation +
// winner + payment + audit + recovery + lifecycle + broadcaster + lobby).
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

// -------------------------------------------------------------------
// Temporary lifecycle diagnostics (C4.9). Observers on existing events.
// -------------------------------------------------------------------

const captured = {
    gameId: null,
    roster: [],
    cleanupCompleted: false
};

function normalizePlayerId(entry) {

    if (typeof entry === "string") {

        return entry;

    }

    return entry?.playerId ?? entry?.id ?? null;

}

eventBus.subscribe(EVENT_TYPES.ROOM_LOCKED, (envelope) => {

    console.log(`  [C4.9] ROOM LOCKED       roomId=${envelope.payload?.roomId}`);

});

eventBus.subscribe(EVENT_TYPES.GAME_CREATED, (envelope) => {

    captured.gameId = envelope.payload?.gameId;

    captured.roster = (envelope.payload?.players ?? [])
        .map(normalizePlayerId)
        .filter(Boolean);

    console.log(
        `  [C4.9] GAME CREATED      gameId=${captured.gameId} `
            + `players=${captured.roster.length}`
    );

});

eventBus.subscribe(EVENT_TYPES.PHYSICS_STARTED, (envelope) => {

    console.log(`  [C4.9] PHYSICS CREATED   gameId=${envelope.payload?.gameId}`);

});

eventBus.subscribe(EVENT_TYPES.PHYSICS_STOPPED, (envelope) => {

    console.log(`  [C4.9] PHYSICS STOPPED   gameId=${envelope.payload?.gameId}`);

});

eventBus.subscribe(EVENT_TYPES.CLOCK_STARTED, (envelope) => {

    console.log(`  [C4.9] CLOCK CREATED     gameId=${envelope.payload?.gameId}`);

});

eventBus.subscribe(EVENT_TYPES.CLOCK_STOPPED, (envelope) => {

    console.log(`  [C4.9] CLOCK STOPPED     gameId=${envelope.payload?.gameId}`);

});

eventBus.subscribe(EVENT_TYPES.WINNER_DETERMINED, (envelope) => {

    console.log(`  [C4.9] WINNER RESOLVED   gameId=${envelope.payload?.gameId}`);

});

eventBus.subscribe(EVENT_TYPES.CLEANUP_COMPLETED, (envelope) => {

    captured.cleanupCompleted = true;

    console.log(
        `  [C4.9] GAME CLEANUP DONE gameId=${envelope.payload?.gameId}`
    );

});

// ===========================================================================

async function run() {

    // Baseline captured AFTER all components + diagnostics have subscribed.
    const baselineSubscribers = totalSubscribers(eventBus);

    // -------------------------------------------------------------------
    // 1. Lobby: create + fill a room via the authoritative lobby events.
    //    ROOM_FULL bootstraps the game; GAME_INITIALIZED maps room->game.
    // -------------------------------------------------------------------

    const sockets = ["c4.9-sock-1", "c4.9-sock-2", "c4.9-sock-3"];

    eventBus.emit({
        source: EVENT_SOURCES.SOCKET_GATEWAY,
        type: EVENT_TYPES.LOBBY_CREATE_ROOM_REQUEST,
        payload: { socketId: sockets[0] }
    });

    const room = roomManager.getRooms()[0];

    assert(room, "a lobby room should be created");

    const roomId = room.roomId;

    for (let index = 1; index < sockets.length; index += 1) {

        eventBus.emit({
            source: EVENT_SOURCES.SOCKET_GATEWAY,
            type: EVENT_TYPES.LOBBY_JOIN_ROOM_REQUEST,
            payload: { socketId: sockets[index], roomId }
        });

    }

    const bootstrapped = await poll(() => Boolean(captured.gameId));

    assert(bootstrapped, "ROOM_FULL should bootstrap a game");

    emitEntryPaymentCompleted(eventBus, roomId);

    const gameId = captured.gameId;

    assert(captured.roster.length === 3, "game roster should have 3 players");

    // The lobby retains the started room + room->game mapping for the recovery
    // window: both must be live while the game is in flight.
    assert(roomManager.getRooms().length === 1, "room should be active in-game");

    assert(
        gameplayContextResolver.resolveRoomByGameId(gameId) === roomId,
        "room->game mapping should be active in-game"
    );

    // -------------------------------------------------------------------
    // 2. Complete the game authoritatively (SPEED ends on input exhaustion).
    // -------------------------------------------------------------------

    const reachedSpeed = await poll(
        () => harness.gameStateEngine.getState(gameId) === GAME_STATES.SPEED
    );

    assert(reachedSpeed, "game should reach SPEED");

    // Mid-flight sanity: the live gameplay objects exist while playing.
    assert(
        harness.physicsEngine.getActiveSimulationCount() === 1
            && harness.gameClockEngine.getActiveClockCount() === 1
            && harness.simulationLoop.getActiveGameCount() === 1,
        "one live simulation/clock/loop entry should exist during play"
    );

    exhaustAllPlayerInput(harness.inputAuthority, gameId, captured.roster);

    // -------------------------------------------------------------------
    // 3. Wait for the full lifecycle to complete and tear down the game.
    // -------------------------------------------------------------------

    const tornDown = await poll(
        () => captured.cleanupCompleted && !gameManager.hasGame(gameId)
    );

    assert(tornDown, "game should reach RESULT, audit, and tear down");

    // Give any deferred broadcaster stop (CLOCK_STOPPED/CLEANUP) a tick to run.
    await wait(20);

    // -------------------------------------------------------------------
    // 4. Assert ZERO active gameplay objects after Cleanup (Step 2 / Step 5).
    // -------------------------------------------------------------------

    const checks = [
        ["SimulationLoop active simulations",
            harness.simulationLoop.getActiveGameCount()],
        ["PhysicsEngine simulations",
            harness.physicsEngine.getActiveSimulationCount()],
        ["GameClockEngine clocks",
            harness.gameClockEngine.getActiveClockCount()],
        ["GameClockBroadcaster broadcasters",
            gameClockBroadcaster.getActiveBroadcastCount()],
        ["SpeedActivation active games",
            harness.speedActivation.getActiveGameCount()],
        ["OfflineInputContinuation continuations",
            harness.offlineInputContinuation.getActiveContinuations().length],
        ["PaymentEngine active payments",
            harness.paymentEngine.getActivePaymentCount()],
        ["AuditEngine active audits",
            auditEngine.getActiveAuditCount()],
        ["GameManager active games",
            gameManager.getGames().length],
        ["GameplayLifecycle pending teardowns",
            harness.gameplayLifecycle.getPendingTeardownCount()]
    ];

    for (const [label, value] of checks) {

        assert(value === 0, `${label} must be 0 after cleanup (got ${value})`);

    }

    // Per-game keyed pools must not retain the finished game.
    assert(
        !harness.winnerEngine.getResult(gameId),
        "WinnerEngine must hold no result after cleanup"
    );

    assert(
        !recoveryEngine.getRecoverySnapshot(gameId),
        "RecoveryEngine must hold no temporary snapshot after cleanup"
    );

    assert(
        !harness.configurationEngine.getConfiguration(gameId),
        "ConfigurationEngine must hold no configuration after cleanup"
    );

    assert(
        !harness.inputAuthority.hasGame(gameId),
        "InputAuthority must hold no registry after cleanup"
    );

    assert(
        !harness.gameStateEngine.getState(gameId),
        "GameStateEngine must hold no state after cleanup"
    );

    console.log("  gameplay-core cleanup verified (all pools at zero)");

    // -------------------------------------------------------------------
    // 5. Return to Page1: deliberate leave ends the lobby session and
    //    releases the last recovery-window survivors (room + mapping).
    // -------------------------------------------------------------------

    // The room + mapping are intentionally still alive here (recovery window).
    assert(
        roomManager.getRooms().length === 1,
        "room is retained after gameplay teardown (recovery window)"
    );

    assert(
        gameplayContextResolver.resolveRoomByGameId(gameId) === roomId,
        "room->game mapping retained after teardown (recovery window)"
    );

    eventBus.emit({
        source: EVENT_SOURCES.SOCKET_GATEWAY,
        type: EVENT_TYPES.LOBBY_LEAVE_ROOM_REQUEST,
        payload: { socketId: sockets[0] }
    });

    console.log("  [C4.9] ROOM DESTROYED    (return to Page1)");

    assert(
        roomManager.getRooms().length === 0,
        "RoomManager must hold no rooms after return to Page1"
    );

    assert(
        !gameplayContextResolver.resolveRoomByGameId(gameId),
        "GameplayContextResolver must hold no mapping after return to Page1"
    );

    // -------------------------------------------------------------------
    // 6. No orphan subscriptions; no lingering timers.
    // -------------------------------------------------------------------

    assert(
        totalSubscribers(eventBus) === baselineSubscribers,
        "no orphan EventBus subscriptions must remain "
            + `(baseline ${baselineSubscribers}, now ${totalSubscribers(eventBus)})`
    );

    assert(
        harness.gameClockEngine.getActiveClockCount() === 0
            && harness.gameplayLifecycle.getPendingTeardownCount() === 0
            && gameClockBroadcaster.getActiveBroadcastCount() === 0,
        "no gameplay timers/intervals must remain running after cleanup"
    );

    console.log("  full lifecycle clean-state verified (Page1 -> Page1)");

}

// ===========================================================================

try {

    await run();

    console.log(
        "gameplayCompletionCleanup.integration.test.js: all assertions passed"
    );

} finally {

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

}
