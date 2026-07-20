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

// -------------------------------------------------------------------------
// Scenario C — WARNING emitted exactly once (natural lifecycle)
// -------------------------------------------------------------------------

{

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const warnings = [];

    eventBus.subscribe(EVENT_TYPES.GAMEPLAY_TIMER_WARNING, (envelope) => {

        warnings.push(envelope.payload);

    });

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
        payload: { gameId: "warn-once", roomId: "room-1" }
    });

    await wait(50);

    assert(warnings.length === 1, "Scenario C: WARNING exactly once");

    assert(
        warnings[0].warningEmitted === true,
        "Scenario C: snapshot marks warningEmitted"
    );

    // buildSyncPayload must not re-emit.
    lifecycle.buildSyncPayload("warn-once");

    assert(warnings.length === 1, "Scenario C: sync does not duplicate WARNING");

    lifecycle.shutdown();

    eventBus.shutdown();

    console.log("  Scenario C: WARNING once passed");

}

// -------------------------------------------------------------------------
// Scenario D — EXPIRED unchanged
// -------------------------------------------------------------------------

{

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const expired = [];

    eventBus.subscribe(EVENT_TYPES.GAMEPLAY_TIMER_EXPIRED, (envelope) => {

        expired.push(envelope.payload);

    });

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
        payload: { gameId: "expiry-ok", roomId: "room-1" }
    });

    await wait(100);

    assert(expired.length === 1, "Scenario D: EXPIRED emitted once");

    assert(expired[0].expired === true, "Scenario D: EXPIRED snapshot flagged");

    const after = lifecycle.getTimer("expiry-ok");

    assert(after?.expired === true, "Scenario D: timer marked expired");

    // Second expiry path is a no-op.
    lifecycle._onExpiry("expiry-ok");

    assert(expired.length === 1, "Scenario D: duplicate expiry ignored");

    lifecycle.shutdown();

    eventBus.shutdown();

    console.log("  Scenario D: EXPIRED regression passed");

}

// -------------------------------------------------------------------------
// Scenario E — missed warning wake-up; expiry path still emits WARNING
// -------------------------------------------------------------------------

{

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const warnings = [];

    eventBus.subscribe(EVENT_TYPES.GAMEPLAY_TIMER_WARNING, (envelope) => {

        warnings.push(envelope.payload);

    });

    const lifecycle = new GameplayTimerLifecycle({
        logger,
        eventBus,
        gameplayTimerConfig: {
            gameplayDurationMs: 100,
            gameplayWarningMs: 40
        }
    });

    lifecycle.initialize();

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAME_INITIALIZED,
        payload: { gameId: "delay-race", roomId: "room-1" }
    });

    // Simulate a delayed/missed warning timer (event-loop stall).
    const warningHandle = lifecycle._warningHandles.get("delay-race");

    clearTimeout(warningHandle);

    lifecycle._warningHandles.delete("delay-race");

    assert(warnings.length === 0, "Scenario E: warning not emitted yet");

    await wait(65);

    assert(
        lifecycle.getTimer("delay-race")?.warningEmitted !== true,
        "Scenario E: missed wake-up left warning un emitted"
    );

    lifecycle._onExpiry("delay-race");

    assert(warnings.length === 1, "Scenario E: expiry path emits WARNING first");

    assert(
        warnings[0].remainingTime <= 40,
        "Scenario E: WARNING derived from remainingTime at expiry boundary"
    );

    lifecycle.shutdown();

    eventBus.shutdown();

    console.log("  Scenario E: delayed event-loop safety passed");

}

// -------------------------------------------------------------------------
// Reconnect — buildSyncPayload evaluates remainingTime and emits WARNING
// -------------------------------------------------------------------------

{

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const warnings = [];

    eventBus.subscribe(EVENT_TYPES.GAMEPLAY_TIMER_WARNING, () => {

        warnings.push(1);

    });

    const lifecycle = new GameplayTimerLifecycle({
        logger,
        eventBus,
        gameplayTimerConfig: {
            gameplayDurationMs: 200,
            gameplayWarningMs: 80
        },
        devMode: true
    });

    lifecycle.initialize();

    const anchor = Date.now();

    lifecycle.create("reconnect-game", {
        roomId: "room-1",
        now: anchor - 130
    });

    const warningHandle = lifecycle._warningHandles.get("reconnect-game");

    clearTimeout(warningHandle);

    lifecycle._warningHandles.delete("reconnect-game");

    assert(warnings.length === 0, "reconnect: no WARNING before sync");

    const sync = lifecycle.buildSyncPayload("reconnect-game");

    assert(sync !== null, "reconnect: sync payload available");

    assert(warnings.length === 1, "reconnect: sync evaluates WARNING once");

    lifecycle.shutdown();

    eventBus.shutdown();

    console.log("  Reconnect sync WARNING passed");

}

// -------------------------------------------------------------------------
// GameplayTimer model + legacy lifecycle flow (STARTED → WARNING → EXPIRED)
// -------------------------------------------------------------------------

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

logger.info("gameplayTimer.warningReliability.test.js: all assertions passed");
