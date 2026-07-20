import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { GameManager } from "../managers/GameManager.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { LoggerService } from "../services/LoggerService.js";
import {
    emitEntryPaymentCompleted,
    exhaustAllPlayerInput,
    shutdownGameplayBootstrap,
    wireGameplayBootstrap
} from "./helpers/gameplayBootstrapHarness.js";

// Deterministic-stack dependencies (isolated from the shared server).
import { GameCatalog } from "../catalog/GameCatalog.js";
import { INPUT_RULES } from "../catalog/InputRules.js";
import { ConfigurationEngine } from "../engines/ConfigurationEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { WinnerEngine } from "../engines/WinnerEngine.js";
import { InputAuthority } from "../input/InputAuthority.js";
import { PLAYER_STATE } from "../models/PlayerState.js";
import { CONNECTION_STATE } from "../models/ConnectionState.js";
import { RandomService } from "../services/RandomService.js";
import { SimulationLoop } from "../simulation/SimulationLoop.js";
import { WinnerActivation } from "../gameplay/WinnerActivation.js";

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

// ---------------------------------------------------------------------------
// Shared server (never restarted across all sequential + concurrent games).
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

const harness = wireGameplayBootstrap({
    gameManager,
    roomManager,
    playerManager,
    logger,
    eventBus,
    devMode: false,
    enableLifecycle: true
});

const engines = harness;

// Per-game event tallies to prove every gameplay event occurs exactly once.
const eventCounts = new Map();

const TRACKED_EVENTS = [
    EVENT_TYPES.GAME_CREATED,
    EVENT_TYPES.CONFIGURATION_READY,
    EVENT_TYPES.GAME_INITIALIZED,
    EVENT_TYPES.PHYSICS_STARTED,
    EVENT_TYPES.PHYSICS_STOPPED,
    EVENT_TYPES.WINNER_DETERMINED
];

function tally(gameId, key) {

    if (!gameId) {

        return;

    }

    const record = eventCounts.get(gameId) ?? {};

    record[key] = (record[key] ?? 0) + 1;

    eventCounts.set(gameId, record);

}

for (const type of TRACKED_EVENTS) {

    eventBus.subscribe(type, (envelope) => {

        tally(envelope.payload?.gameId, type);

    });

}

eventBus.subscribe(EVENT_TYPES.GAME_STATE_CHANGED, (envelope) => {

    if (envelope.payload?.currentState === GAME_STATES.RESULT) {

        tally(envelope.payload?.gameId, "RESULT");

    }

});

const roomToGameId = new Map();

const gameWinners = new Map();

eventBus.subscribe(EVENT_TYPES.GAME_CREATED, (envelope) => {

    roomToGameId.set(envelope.payload.roomId, envelope.payload.gameId);

});

eventBus.subscribe(EVENT_TYPES.WINNER_DETERMINED, (envelope) => {

    gameWinners.set(envelope.payload.gameId, envelope.payload);

});

let playerSequence = 0;

function startGame() {

    const room = roomManager.createRoom();

    const players = [];

    for (let index = 0; index < 3; index += 1) {

        playerSequence += 1;

        const playerId = `player_${playerSequence}`;

        playerManager.createPlayer({ playerId });

        players.push(playerId);

    }

    // ROOM_FULL fires synchronously on the third add, running prep bootstrap.
    for (const playerId of players) {

        roomManager.addPlayer(room.roomId, playerId);

    }

    // R1.1 — gameplay clock/physics wait for entry payment completion.
    emitEntryPaymentCompleted(eventBus, room.roomId);

    const gameId = roomToGameId.get(room.roomId);

    return { roomId: room.roomId, gameId, players };

}

async function startGameAndCompleteSpeed() {

    const started = startGame();

    assert(started.gameId, "game should be bootstrapped");

    for (const playerId of started.players) {

        playerManager.setConnectionState(playerId, CONNECTION_STATE.CONNECTED);

    }

    const reachedSpeed = await poll(
        () => engines.gameStateEngine.getState(started.gameId) === GAME_STATES.SPEED
    );

    assert(reachedSpeed, `game ${started.gameId} should reach SPEED`);

    exhaustAllPlayerInput(
        engines.inputAuthority,
        started.gameId,
        started.players
    );

    return started;

}

function assertGameResourcesReleased(gameId) {

    assert(
        !engines.physicsEngine.getSimulation(gameId),
        `physics simulation should be removed for ${gameId}`
    );

    assert(
        !engines.gameClockEngine.getClock(gameId),
        `game clock should be removed for ${gameId}`
    );

    assert(
        !engines.gameStateEngine.getState(gameId),
        `game state should be removed for ${gameId}`
    );

    assert(
        !engines.configurationEngine.getConfiguration(gameId),
        `configuration should be removed for ${gameId}`
    );

    assert(
        !engines.winnerEngine.getResult(gameId),
        `winner result should be removed for ${gameId}`
    );

    assert(
        !engines.inputAuthority.hasGame(gameId),
        `input registry should be removed for ${gameId}`
    );

    assert(
        !gameManager.hasGame(gameId),
        `game record should be destroyed for ${gameId}`
    );

}

function assertEventsExactlyOnce(gameId) {

    const record = eventCounts.get(gameId) ?? {};

    for (const type of TRACKED_EVENTS) {

        assert(
            record[type] === 1,
            `event ${type} should occur exactly once for ${gameId} (got ${record[type]})`
        );

    }

    assert(
        record.RESULT === 1,
        `RESULT transition should occur exactly once for ${gameId} (got ${record.RESULT})`
    );

}

// ===========================================================================

async function run() {

    // -------------------------------------------------------------------
    // 1. Sequential games — many complete games without restarting server.
    // -------------------------------------------------------------------

    const SEQUENTIAL_GAMES = 50;

    const sequentialGameIds = [];

    for (let index = 0; index < SEQUENTIAL_GAMES; index += 1) {

        const { gameId } = await startGameAndCompleteSpeed();

        assert(gameId, `game ${index + 1} should be bootstrapped`);

        // Teardown only occurs after the game reaches RESULT, so observing the
        // stable post-teardown condition avoids racing the transient RESULT
        // display window. RESULT-once is asserted via the permanent event tally.
        const tornDown = await poll(() => !gameManager.hasGame(gameId));

        assert(tornDown, `game ${index + 1} should reach RESULT and be torn down`);

        assertGameResourcesReleased(gameId);

        assertEventsExactlyOnce(gameId);

        assert(
            engines.simulationLoop.getActiveGameCount() === 0,
            "SimulationLoop should have no active games between sequential runs"
        );

        sequentialGameIds.push(gameId);

    }

    assert(
        new Set(sequentialGameIds).size === SEQUENTIAL_GAMES,
        "each sequential game should have a unique gameId"
    );

    console.log(`  sequential (${SEQUENTIAL_GAMES} games) passed`);

    // -------------------------------------------------------------------
    // 2. Concurrent games — independent simulations and winner resolution.
    // -------------------------------------------------------------------

    const CONCURRENT_GAMES = 6;

    const concurrent = [];

    for (let index = 0; index < CONCURRENT_GAMES; index += 1) {

        concurrent.push(await startGameAndCompleteSpeed());

    }

    const uniqueGameIds = new Set(concurrent.map((entry) => entry.gameId));

    assert(
        uniqueGameIds.size === CONCURRENT_GAMES,
        "concurrent games should all have distinct gameIds"
    );

    const allTornDown = await poll(() =>
        concurrent.every((entry) => !gameManager.hasGame(entry.gameId))
    );

    assert(allTornDown, "all concurrent games should reach RESULT and be torn down");

    // Independent winner determination + strict room isolation. gameWinners is
    // captured from WINNER_DETERMINED events, so it survives teardown.
    for (const entry of concurrent) {

        const winner = gameWinners.get(entry.gameId);

        assert(winner, `winner should be resolved for ${entry.gameId}`);

        assert(
            entry.players.includes(winner.winningPlayerId),
            "winner must belong to the game's own room (no cross-room result)"
        );

    }

    for (const entry of concurrent) {

        assertGameResourcesReleased(entry.gameId);

        assertEventsExactlyOnce(entry.gameId);

    }

    assert(
        engines.simulationLoop.getActiveGameCount() === 0,
        "SimulationLoop should have no active games after concurrent batch"
    );

    assert(
        engines.gameplayLifecycle.getPendingTeardownCount() === 0,
        "no teardown timers should remain pending"
    );

    console.log(`  concurrent (${CONCURRENT_GAMES} games) passed`);

    // -------------------------------------------------------------------
    // 3. No orphan gameplay state remains across the whole batch.
    // -------------------------------------------------------------------

    for (const gameId of [...sequentialGameIds, ...concurrent.map((e) => e.gameId)]) {

        assertGameResourcesReleased(gameId);

    }

    console.log("  resource cleanup verified (no orphan simulations/timers)");

}

// ===========================================================================
// 4. Determinism — identical seed + identical input ⇒ identical outcome.
// ===========================================================================

function buildDeterministicStack(seed) {

    const stackLogger = new LoggerService({ logLevel: "error" });

    stackLogger.initialize();

    const stackБus = new EventBus({
        logger: stackLogger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    stackБus.initialize();

    const catalog = new GameCatalog({ logger: stackLogger });

    catalog.initialize();

    const randomService = new RandomService({ logger: stackLogger });

    randomService.initialize();

    randomService.setSeed(seed);

    const stackPlayers = new PlayerManager({ logger: stackLogger, eventBus: stackБus });

    stackPlayers.initialize();

    const configurationEngine = new ConfigurationEngine({
        logger: stackLogger,
        eventBus: stackБus,
        gameCatalog: catalog,
        randomService
    });

    configurationEngine.initialize();

    const physicsEngine = new PhysicsEngine({
        logger: stackLogger,
        eventBus: stackБus,
        gameClock: null
    });

    physicsEngine.initialize();

    const gameStateEngine = new GameStateEngine({
        logger: stackLogger,
        eventBus: stackБus
    });

    gameStateEngine.initialize();

    const winnerEngine = new WinnerEngine({
        logger: stackLogger,
        eventBus: stackБus,
        physicsEngine,
        configurationEngine,
        gameCatalog: catalog
    });

    winnerEngine.initialize();

    const inputAuthority = new InputAuthority({
        logger: stackLogger,
        eventBus: stackБus,
        gameCatalog: {
            getInputRules: () => ({ ...INPUT_RULES, pressCooldownMs: 0 }),
            getColors: () => catalog.getColors(),
            getIcons: () => catalog.getIcons(),
            getStakes: () => catalog.getStakes(),
            getTimers: () => catalog.getTimers(),
            getWheelRules: () => catalog.getWheelRules()
        },
        playerManager: stackPlayers,
        physicsEngine,
        gameStateEngine,
        devMode: false
    });

    inputAuthority.initialize();

    const simulationLoop = new SimulationLoop({
        logger: stackLogger,
        eventBus: stackБus,
        physicsEngine,
        inputAuthority,
        devMode: false
    });

    simulationLoop.initialize();

    const winnerActivation = new WinnerActivation({
        logger: stackLogger,
        eventBus: stackБus,
        physicsEngine,
        winnerEngine,
        gameStateEngine,
        devMode: false
    });

    winnerActivation.initialize();

    return {
        stackPlayers,
        configurationEngine,
        physicsEngine,
        gameStateEngine,
        winnerEngine,
        inputAuthority,
        simulationLoop,
        winnerActivation,
        shutdown() {

            winnerActivation.shutdown();

            simulationLoop.shutdown();

            inputAuthority.shutdown();

            winnerEngine.shutdown();

            gameStateEngine.shutdown();

            physicsEngine.shutdown();

            configurationEngine.shutdown();

            stackPlayers.shutdown();

            randomService.shutdown();

            stackБus.shutdown();

            stackLogger.shutdown();

        }
    };

}

function runDeterministicGame(seed) {

    const stack = buildDeterministicStack(seed);

    try {

        const gameId = "determinism-game";

        const players = ["p_one", "p_two", "p_three"];

        for (const playerId of players) {

            stack.stackPlayers.createPlayer({ playerId });

            stack.stackPlayers.setPlayerState(playerId, PLAYER_STATE.PLAYING);

        }

        let configuration = stack.configurationEngine.buildConfiguration(
            gameId,
            { roomId: "determinism-room", stake: 10 },
            players.map((playerId) => ({ playerId, sectorCount: 2 }))
        );

        stack.configurationEngine.validateConfiguration(configuration);

        configuration = stack.configurationEngine.freezeConfiguration(configuration);

        stack.configurationEngine.commitConfiguration(configuration);

        stack.gameStateEngine.initializeGameState(gameId);

        for (const state of [
            GAME_STATES.COUNTDOWN,
            GAME_STATES.SELF_TEST,
            GAME_STATES.SPEED
        ]) {

            stack.gameStateEngine.transition(gameId, state, { reason: "test" });

        }

        stack.physicsEngine.createSimulation(gameId);

        stack.physicsEngine.startSimulation(gameId);

        stack.inputAuthority.registerPlayers(gameId, players);

        // Identical input sequence for both runs.
        for (const playerId of players) {

            stack.inputAuthority.handleButtonPress(gameId, playerId);

        }

        for (let tick = 0; tick < 12; tick += 1) {

            stack.simulationLoop._onTick();

        }

        stack.gameStateEngine.transition(gameId, GAME_STATES.BRAKE, {
            reason: "test"
        });

        // P5.9 — Winner resolution is independent of RESULT clock activation.
        stack.physicsEngine.stopSimulation(gameId);

        const result = stack.winnerEngine.resolveResult(gameId);

        assert(result, "determinism run must resolve a winner");

        return {
            finalAngle: result.finalAngle,
            sectorId: result.winningSector.sectorId,
            playerId: result.winningPlayer.playerId
        };

    } finally {

        stack.shutdown();

    }

}

function runDeterminismCheck() {

    const first = runDeterministicGame(987654);

    const second = runDeterministicGame(987654);

    assert(
        first.finalAngle === second.finalAngle,
        `deterministic final angle mismatch (${first.finalAngle} vs ${second.finalAngle})`
    );

    assert(
        first.sectorId === second.sectorId,
        "deterministic winning sector mismatch"
    );

    assert(
        first.playerId === second.playerId,
        "deterministic winner mismatch"
    );

    const third = runDeterministicGame(111111);

    // A different seed must be allowed to produce a different geometry, but the
    // run must still be internally valid.
    assert(
        typeof third.sectorId === "string" && typeof third.playerId === "string",
        "alternate seed run should still resolve a valid winner"
    );

    console.log("  determinism (identical seed ⇒ identical outcome) passed");

}

// ===========================================================================

try {

    await run();

    runDeterminismCheck();

    console.log(
        "gameplayCoreValidation.integration.test.js: all assertions passed"
    );

} finally {

    shutdownGameplayBootstrap(harness);

    gameManager.shutdown();

    playerManager.shutdown();

    roomManager.shutdown();

    eventBus.shutdown();

    logger.shutdown();

}
