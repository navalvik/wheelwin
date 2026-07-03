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
import { SpeedActivation } from "../gameplay/SpeedActivation.js";
import { OfflineInputContinuation } from "../gameplay/OfflineInputContinuation.js";
import { LoggerService } from "../services/LoggerService.js";
import {
    createFastInputCatalog,
    createFastTimers,
    exhaustAllPlayerInput
} from "./helpers/gameplayBootstrapHarness.js";
import { GameCatalog } from "../catalog/GameCatalog.js";

// C4.8b — Authoritative Offline Input Continuation.
//
// These scenarios prove the original WheelWin philosophy: an offline player
// never stops the game and never changes the outcome merely by disconnecting.
// Their remaining SPEED interaction is continued authoritatively through the
// same InputAuthority path, so they still reach the press limit and still push
// the wheel. SPEED completes on the plain full-roster rule (SpeedActivation),
// never early because a player vanished.

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

    catalog.getTimers = () => createFastTimers();

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
        speedActivation,
        offlineInputContinuation,
        shutdown() {

            offlineInputContinuation.shutdown();

            speedActivation.shutdown();

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

    const reachedSpeed = await poll(
        () => stack.gameStateEngine.getState(gameId) === GAME_STATES.SPEED
    );

    assert(reachedSpeed, `${gameId} should reach SPEED`);

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
// Scenario 2 — a player disconnects mid-SPEED after one cycle.
// The server continues their remaining input; SPEED is NOT terminated early,
// and the disconnected player still reaches the press limit (still pushes the
// wheel) instead of vanishing.
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

        // p_a drops. C4.8a would have ended SPEED immediately here (losing p_a's
        // remaining acceleration). C4.8b continues p_a authoritatively instead.
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
            isLockedAtLimit(stack.inputAuthority, gameId, "p_a"),
            "offline player must reach the full press limit via continuation"
        );

        const sim = stack.physicsEngine.getSimulation(gameId);

        assert(
            sim && sim.runtime.angle > 0,
            "the wheel must have received authoritative acceleration (angle > 0)"
        );

        console.log("  scenario 2 (disconnect mid-SPEED, continued) passed");

    } finally {

        stack.shutdown();

    }

}

// -------------------------------------------------------------------------
// Scenario 3 — every player is offline at SPEED entry.
// The server still finishes gameplay entirely on their behalf.
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
                isLockedAtLimit(stack.inputAuthority, gameId, playerId),
                `offline ${playerId} must be continued to the press limit`
            );

        }

        const sim = stack.physicsEngine.getSimulation(gameId);

        assert(
            sim && sim.runtime.angle > 0,
            "the wheel must still receive acceleration when all are offline"
        );

        console.log("  scenario 3 (all offline at entry) passed");

    } finally {

        stack.shutdown();

    }

}

// -------------------------------------------------------------------------
// Scenario 4 — a player reconnects during SPEED.
// Continuation is handed back cleanly: no duplicated input, no duplicated
// completion, and the player finishes their own remaining input.
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

        // p_a drops: continuation adopts them.
        stack.playerManager.setConnectionState(
            "p_a",
            CONNECTION_STATE.DISCONNECTED
        );

        const activeAfterDrop = stack.offlineInputContinuation
            .getActiveContinuations()
            .some((entry) => entry.gameId === gameId && entry.playerId === "p_a");

        assert(
            activeAfterDrop,
            "continuation must adopt the player immediately on disconnect"
        );

        // p_a returns: continuation must hand control back at once.
        stack.playerManager.setConnectionState(
            "p_a",
            CONNECTION_STATE.CONNECTED
        );

        const activeAfterReturn = stack.offlineInputContinuation
            .getActiveContinuations()
            .some((entry) => entry.gameId === gameId && entry.playerId === "p_a");

        assert(
            !activeAfterReturn,
            "continuation must release the player on reconnect"
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

        assert(reachedBrake, "reconnected player finishing must complete SPEED");

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
