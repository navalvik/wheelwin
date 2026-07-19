import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { LoggerService } from "../services/LoggerService.js";
import { GameplayTimer } from "../models/GameplayTimer.js";
import { GameplayTimerLifecycle } from "../gameplay/GameplayTimerLifecycle.js";
import { GameplayTimerActivation } from "../gameplay/GameplayTimerActivation.js";
import { GameClockEngine } from "../engines/GameClockEngine.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { GameCatalog } from "../catalog/GameCatalog.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

const logger = new LoggerService({ logLevel: "error" });

logger.initialize();

{
    const startedAt = 1_000_000;

    const timer = new GameplayTimer({
        gameId: "g1",
        roomId: "r1",
        startedAt,
        expiresAt: startedAt + 300_000,
        durationMs: 300_000
    });

    assert(timer.remainingTime(startedAt) === 300_000, "full remaining");

    assert(
        timer.remainingTime(startedAt + 300_000) === 0,
        "zero at expiry"
    );

    const snap = timer.toSnapshot(startedAt + 60_000);

    assert(snap.remainingTime === 240_000, "snapshot remaining");

    console.log("  GameplayTimer model passed");
}

{
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const collected = [];

    for (const type of [
        EVENT_TYPES.GAMEPLAY_TIMER_STARTED,
        EVENT_TYPES.GAMEPLAY_TIMER_SYNC,
        EVENT_TYPES.GAMEPLAY_TIMER_WARNING,
        EVENT_TYPES.GAMEPLAY_TIMER_EXPIRED
    ]) {

        eventBus.subscribe(type, (envelope) => {

            collected.push(envelope.type);

        });

    }

    const lifecycle = new GameplayTimerLifecycle({
        logger,
        eventBus,
        gameplayTimerConfig: {
            gameplayDurationMs: 80,
            gameplayWarningMs: 40
        }
    });

    lifecycle.initialize();

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAME_INITIALIZED,
        payload: { gameId: "game-timer-1", roomId: "room-1" }
    });

    assert(
        lifecycle.hasTimer("game-timer-1"),
        "timer created on GAME_INITIALIZED"
    );

    assert(
        collected.includes(EVENT_TYPES.GAMEPLAY_TIMER_STARTED),
        "STARTED emitted"
    );

    assert(
        collected.includes(EVENT_TYPES.GAMEPLAY_TIMER_SYNC),
        "SYNC emitted"
    );

    const sync = lifecycle.buildSyncPayload("game-timer-1");

    assert(sync?.durationMs === 80, "sync carries duration");

    assert(
        Number.isFinite(sync.startedAt) && Number.isFinite(sync.expiresAt),
        "sync carries immutable anchors"
    );

    await wait(50);

    assert(
        collected.filter((t) => t === EVENT_TYPES.GAMEPLAY_TIMER_WARNING)
            .length === 1,
        "WARNING once"
    );

    await wait(50);

    assert(
        collected.includes(EVENT_TYPES.GAMEPLAY_TIMER_EXPIRED),
        "EXPIRED emitted"
    );

    const afterExpiry = lifecycle.getTimer("game-timer-1");

    assert(afterExpiry?.expired === true, "timer marked expired");

    // Natural RESULT cancels before double-expire.
    lifecycle.create("game-timer-2", { roomId: "room-2" });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAME_STATE_CHANGED,
        payload: {
            gameId: "game-timer-2",
            currentState: GAME_STATES.RESULT
        }
    });

    assert(
        !lifecycle.hasTimer("game-timer-2"),
        "RESULT destroys timer"
    );

    lifecycle.shutdown();

    eventBus.shutdown();

    console.log("  GameplayTimerLifecycle events passed");
}

{
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const catalog = new GameCatalog({ logger });

    catalog.initialize();

    catalog.getTimers = () => ({
        COUNTDOWN: { phase: "COUNTDOWN", durationMs: 20 },
        SELF_TEST: { phase: "SELF_TEST", durationMs: 20 },
        SPEED: { phase: "SPEED", durationMs: null },
        BRAKE: { phase: "BRAKE", durationMs: 20 },
        RESULT: { phase: "RESULT", durationMs: 20 }
    });

    const gameStateEngine = new GameStateEngine({ logger, eventBus });

    const gameClockEngine = new GameClockEngine({
        logger,
        eventBus,
        gameCatalog: catalog
    });

    gameStateEngine.initialize();

    gameClockEngine.initialize();

    const gameId = "game-force-brake";

    gameStateEngine.initializeGameState(gameId);

    gameStateEngine.transition(gameId, GAME_STATES.COUNTDOWN, {
        reason: "test"
    });

    gameStateEngine.transition(gameId, GAME_STATES.SELF_TEST, {
        reason: "test"
    });

    gameStateEngine.transition(gameId, GAME_STATES.SPEED, {
        reason: "test"
    });

    gameClockEngine.createClock(gameId);

    gameClockEngine.startClock(gameId);

    assert(
        gameStateEngine.getState(gameId) === GAME_STATES.SPEED,
        "game state at SPEED before expiry"
    );

    const activation = new GameplayTimerActivation({
        logger,
        eventBus,
        gameClockEngine,
        gameStateEngine
    });

    activation.initialize();

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAMEPLAY_TIMER_EXPIRED,
        payload: { gameId }
    });

    await wait(5);

    assert(
        gameStateEngine.getState(gameId) === GAME_STATES.BRAKE,
        "expiry forces BRAKE game state"
    );

    // Second expiry is a no-op.
    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAMEPLAY_TIMER_EXPIRED,
        payload: { gameId }
    });

    activation.shutdown();

    gameClockEngine.shutdown();

    gameStateEngine.shutdown();

    eventBus.shutdown();

    console.log("  GameplayTimerActivation force-BRAKE passed");
}

logger.info("gameplayTimer.lifecycle.test.js: all assertions passed");
