import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { GameClockEngine } from "../engines/GameClockEngine.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { InputAuthority } from "../input/InputAuthority.js";
import { SimulationLoop } from "../simulation/SimulationLoop.js";
import { CONNECTION_STATE } from "../models/ConnectionState.js";
import { PLAYER_STATE } from "../models/PlayerState.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { GameStateActivation } from "../gameplay/GameStateActivation.js";
import { GameplayPhaseLifecycle } from "../gameplay/GameplayPhaseLifecycle.js";
import { SpeedActivation } from "../gameplay/SpeedActivation.js";
import { OfflineInputContinuation } from "../gameplay/OfflineInputContinuation.js";
import { LoggerService } from "../services/LoggerService.js";
import {
    createFastInputCatalog,
    createFastTimers,
    exhaustAllPlayerInput
} from "./helpers/gameplayBootstrapHarness.js";
import { GameCatalog } from "../catalog/GameCatalog.js";
import { TIMER_PHASES } from "../catalog/Timers.js";

// Offline SPEED behavior: disconnecting does not synthesize player input or
// change the timed game lifecycle. A held input is released by the server;
// otherwise the player's input count remains as-is while the phase clock runs.

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

async function poll(predicate, { timeoutMs = 3000, intervalMs = 5 } = {}) {

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {

        if (predicate()) {

            return true;

        }

        await wait(intervalMs);

    }

    return false;

}

function pressCycle(inputAuthority, gameId, playerId, cycles) {

    for (let cycle = 0; cycle < cycles; cycle += 1) {

        inputAuthority.handleButtonPress(gameId, playerId);

        inputAuthority.handleButtonRelease(gameId, playerId);

    }

}

function finishPlayerManually(inputAuthority, gameId, playerId) {

    for (let guard = 0; guard < 8; guard += 1) {

        const state = inputAuthority.getPlayerInputState(gameId, playerId);

        if (!state || state.locked) {

            return;

        }

        if (state.buttonPressed) {

            inputAuthority.handleButtonRelease(gameId, playerId);

        }

        inputAuthority.handleButtonPress(gameId, playerId);

        inputAuthority.handleButtonRelease(gameId, playerId);

    }

}

function isLockedAtLimit(inputAuthority, gameId, playerId) {

    const state = inputAuthority.getPlayerInputState(gameId, playerId);

    return Boolean(state && state.locked && state.pressCount === 3);

}

function buildSpeedStack() {

    const logger = new LoggerService({ logLevel: "error" });

    logger.initialize();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const catalog = new GameCatalog({ logger });

    catalog.initialize();

    const fastTimers = createFastTimers();

    // Keep a little more time in the mock SPEED phase so the integration test
    // can exercise disconnect continuation; production timers remain unchanged.
    fastTimers[TIMER_PHASES.SPEED].durationMs = 250;

    catalog.getTimers = () => fastTimers;

    const fastInputCatalog = createFastInputCatalog(catalog);

    const gameStateEngine = new GameStateEngine({ logger, eventBus });

    const gameClockEngine = new GameClockEngine({
        logger,
        eventBus,
        gameCatalog: catalog
    });

    const physicsEngine = new PhysicsEngine({
        logger,
        eventBus,
        gameClock: gameClockEngine
    });

    const playerManager = new PlayerManager({ logger, eventBus });

    const inputAuthority = new InputAuthority({
        logger,
        eventBus,
        gameCatalog: fastInputCatalog,
        playerManager,
        physicsEngine,
        gameStateEngine,
        devMode: true
    });

    gameStateEngine.initialize();

    gameClockEngine.initialize();

    physicsEngine.initialize();

    playerManager.initialize();

    inputAuthority.initialize();

    const simulationLoop = new SimulationLoop({
        logger,
        eventBus,
        physicsEngine,
        inputAuthority,
        devMode: false
    });

    simulationLoop.initialize();

    simulationLoop.start();

    const gameStateActivation = new GameStateActivation({
        logger,
        eventBus,
        gameStateEngine,
        gameClockEngine,
        devMode: true
    });

    gameStateActivation.initialize();

    const gameplayPhaseLifecycle = new GameplayPhaseLifecycle({
        logger,
        eventBus,
        gameStateEngine,
        gameClockEngine,
        devMode: true
    });

    gameplayPhaseLifecycle.initialize();

    const speedActivation = new SpeedActivation({
        logger,
        eventBus,
        gameClockEngine,
        gameStateEngine,
        devMode: true
    });

    speedActivation.initialize();

    const offlineInputContinuation = new OfflineInputContinuation({
        logger,
        eventBus,
        inputAuthority,
        gameStateEngine,
        playerManager,
        gameCatalog: fastInputCatalog,
        devMode: true
    });

    offlineInputContinuation.initialize();

    return {
        logger,
        eventBus,
        gameStateEngine,
        gameClockEngine,
        physicsEngine,
        playerManager,
        inputAuthority,
        simulationLoop,
        gameStateActivation,
        gameplayPhaseLifecycle,
        speedActivation,
        offlineInputContinuation,
        shutdown() {

            offlineInputContinuation.shutdown();

            speedActivation.shutdown();

            gameplayPhaseLifecycle.shutdown();

            gameStateActivation.shutdown();

            simulationLoop.shutdown();

            inputAuthority.shutdown();

            physicsEngine.shutdown();

            gameClockEngine.shutdown();

            gameStateEngine.shutdown();

            playerManager.shutdown();

            eventBus.shutdown();

            logger.shutdown();

        }
    };

}

async function bootstrapSpeedGame(stack, {
    gameId,
    players,
    connectionByPlayer
}) {

    // The fast timer fixture can advance through SPEED before the setup code
    // finishes registering players. Observe the authoritative phase event
    // instead of polling a short-lived state after the fact.
    const speedStarted = new Promise((resolve) => {

        const handler = (envelope) => {

            if (envelope.payload?.gameId !== gameId) {

                return;

            }

            stack.eventBus.unsubscribe(EVENT_TYPES.SPEED_STARTED, handler);

            resolve();

        };

        stack.eventBus.subscribe(EVENT_TYPES.SPEED_STARTED, handler);

    });

    stack.eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAME_CREATED,
        payload: { gameId, roomId: "offline-room", players }
    });

    stack.gameStateEngine.initializeGameState(gameId);

    stack.gameClockEngine.createClock(gameId);

    stack.gameClockEngine.startClock(gameId);

    stack.physicsEngine.createSimulation(gameId);

    stack.physicsEngine.startSimulation(gameId);

    for (const playerId of players) {

        stack.playerManager.createPlayer({ playerId });

        stack.playerManager.setPlayerState(playerId, PLAYER_STATE.PLAYING);

        stack.playerManager.setConnectionState(
            playerId,
            connectionByPlayer[playerId] ?? CONNECTION_STATE.CONNECTED
        );

    }

    stack.inputAuthority.registerPlayers(gameId, players);

    await speedStarted;

    assert(
        stack.gameStateEngine.getState(gameId) === GAME_STATES.SPEED,
        `${gameId} should reach SPEED (actual: ${stack.gameStateEngine.getState(gameId)})`
    );

}

function countSpeedTimeouts(stack, gameId) {

    let count = 0;

    stack.eventBus.subscribe(EVENT_TYPES.PHASE_TIMEOUT, (envelope) => {

        if (envelope.payload?.gameId === gameId
            && envelope.payload?.phase === GAME_STATES.SPEED) {

            count += 1;

        }

    });

    return () => count;

}

// -------------------------------------------------------------------------
// Scenario 1 — three online (regression: unchanged behaviour)
// -------------------------------------------------------------------------

{

    const stack = buildSpeedStack();

    const gameId = "c48b-scenario-1";

    const players = ["p_a", "p_b", "p_c"];

    try {

        await bootstrapSpeedGame(stack, {
            gameId,
            players,
            connectionByPlayer: {
                p_a: CONNECTION_STATE.CONNECTED,
                p_b: CONNECTION_STATE.CONNECTED,
                p_c: CONNECTION_STATE.CONNECTED
            }
        });

        exhaustAllPlayerInput(stack.inputAuthority, gameId, players);

        const reachedBrake = await poll(
            () => stack.gameStateEngine.getState(gameId) === GAME_STATES.BRAKE
        );

        assert(
            reachedBrake,
            "three online players must complete SPEED unchanged"
        );

        assert(
            stack.offlineInputContinuation.getActiveContinuations().length === 0,
            "no continuation should run while all players stay online"
        );

        console.log("  scenario 1 (3 online, regression) passed");

    } finally {

        stack.shutdown();

    }

}

// -------------------------------------------------------------------------
// Scenario 2 — a player disconnects mid-SPEED after one cycle. Their completed
// input remains recorded; the server does not invent the two remaining cycles.
// -------------------------------------------------------------------------

{

    const stack = buildSpeedStack();

    const gameId = "c48b-scenario-2";

    const players = ["p_a", "p_b", "p_c"];

    try {

        await bootstrapSpeedGame(stack, {
            gameId,
            players,
            connectionByPlayer: {
                p_a: CONNECTION_STATE.CONNECTED,
                p_b: CONNECTION_STATE.CONNECTED,
                p_c: CONNECTION_STATE.CONNECTED
            }
        });

        // p_a performs a single cycle, then the two peers finish fully.
        pressCycle(stack.inputAuthority, gameId, "p_a", 1);

        pressCycle(stack.inputAuthority, gameId, "p_b", 3);

        pressCycle(stack.inputAuthority, gameId, "p_c", 3);

        // p_a is not finished, so SPEED must still be running: an incomplete
        // (soon to be offline) player must never be skipped.
        assert(
            stack.gameStateEngine.getState(gameId) === GAME_STATES.SPEED,
            "SPEED must persist while a player still has input remaining"
        );

        // p_a drops while not holding the button. No synthetic input is added.
        stack.playerManager.setConnectionState(
            "p_a",
            CONNECTION_STATE.DISCONNECTED
        );

        const reachedBrake = await poll(
            () => stack.gameStateEngine.getState(gameId) === GAME_STATES.BRAKE
        );

        assert(
            reachedBrake,
            "continuation must drive the offline player to completion -> BRAKE"
        );

        assert(
            stack.inputAuthority.getPlayerInputState(gameId, "p_a")?.pressCount === 1
                && !stack.inputAuthority.getPlayerInputState(gameId, "p_a")?.locked,
            "offline player's input count must remain unchanged"
        );

        console.log("  scenario 2 (disconnect mid-SPEED, timed phase) passed");

    } finally {

        stack.shutdown();

    }

}

// -------------------------------------------------------------------------
// Scenario 3 — every player is offline at SPEED entry. The clock still advances
// the game without generating any player input.
// -------------------------------------------------------------------------

{

    const stack = buildSpeedStack();

    const gameId = "c48b-scenario-3";

    const players = ["p_a", "p_b", "p_c"];

    try {

        await bootstrapSpeedGame(stack, {
            gameId,
            players,
            connectionByPlayer: {
                p_a: CONNECTION_STATE.DISCONNECTED,
                p_b: CONNECTION_STATE.DISCONNECTED,
                p_c: CONNECTION_STATE.DISCONNECTED
            }
        });

        const reachedBrake = await poll(
            () => stack.gameStateEngine.getState(gameId) === GAME_STATES.BRAKE
        );

        assert(
            reachedBrake,
            "all-offline game must still complete SPEED authoritatively"
        );

        for (const playerId of players) {

            assert(
                stack.inputAuthority.getPlayerInputState(gameId, playerId)?.pressCount === 0
                    && !stack.inputAuthority.getPlayerInputState(gameId, playerId)?.locked,
                `offline ${playerId} must keep the initial input state`
            );

        }

        console.log("  scenario 3 (all offline at entry) passed");

    } finally {

        stack.shutdown();

    }

}

// -------------------------------------------------------------------------
// Scenario 4 — a player reconnects during SPEED. Their input remains unchanged
// and they can finish it themselves without duplicate phase completion.
// -------------------------------------------------------------------------

{

    const stack = buildSpeedStack();

    const gameId = "c48b-scenario-4";

    const players = ["p_a", "p_b", "p_c"];

    const speedTimeouts = countSpeedTimeouts(stack, gameId);

    try {

        await bootstrapSpeedGame(stack, {
            gameId,
            players,
            connectionByPlayer: {
                p_a: CONNECTION_STATE.CONNECTED,
                p_b: CONNECTION_STATE.CONNECTED,
                p_c: CONNECTION_STATE.CONNECTED
            }
        });

        pressCycle(stack.inputAuthority, gameId, "p_b", 3);

        pressCycle(stack.inputAuthority, gameId, "p_c", 3);

        // p_a drops while idle; no input continuation is created.
        stack.playerManager.setConnectionState(
            "p_a",
            CONNECTION_STATE.DISCONNECTED
        );

        const activeAfterDrop = stack.offlineInputContinuation
            .getActiveContinuations()
            .some((entry) => entry.gameId === gameId && entry.playerId === "p_a");

        assert(
            !activeAfterDrop,
            "disconnecting an idle player must not create synthetic input work"
        );

        // Reconnect does not change the player's authoritative input count.
        stack.playerManager.setConnectionState(
            "p_a",
            CONNECTION_STATE.CONNECTED
        );

        const activeAfterReturn = stack.offlineInputContinuation
            .getActiveContinuations()
            .some((entry) => entry.gameId === gameId && entry.playerId === "p_a");

        assert(
            !activeAfterReturn,
            "no synthetic input work should exist after reconnect"
        );

        assert(
            stack.gameStateEngine.getState(gameId) === GAME_STATES.SPEED,
            "SPEED must still be running after reconnect (nobody skipped)"
        );

        // The returned player finishes their own remaining input.
        finishPlayerManually(stack.inputAuthority, gameId, "p_a");

        const reachedBrake = await poll(
            () => stack.gameStateEngine.getState(gameId) === GAME_STATES.BRAKE
        );

        assert(reachedBrake, "timed SPEED phase must proceed to BRAKE");

        assert(
            isLockedAtLimit(stack.inputAuthority, gameId, "p_a"),
            "reconnected player must reach exactly the press limit (no doubling)"
        );

        assert(
            speedTimeouts() === 1,
            "SPEED must complete exactly once (no duplicated completion)"
        );

        console.log("  scenario 4 (reconnect during SPEED) passed");

    } finally {

        stack.shutdown();

    }

}

console.log("speedActivationOffline.integration.test.js: all assertions passed");
