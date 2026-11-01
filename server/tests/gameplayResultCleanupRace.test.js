import assert from "node:assert/strict";

import { TIMER_PHASES } from "../catalog/Timers.js";
import { DEFAULT_GAMEPLAY_PHASE_DURATIONS_MS } from "../config/gameplayPhases.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameClockEngine } from "../engines/GameClockEngine.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { GameplayLifecycle } from "../gameplay/GameplayLifecycle.js";
import { GameplayPhaseLifecycle } from "../gameplay/GameplayPhaseLifecycle.js";
import { LoggerService } from "../services/LoggerService.js";

const RESULT_DURATION_MS = 40;
const GAME_ID = "result-cleanup-race";

const logger = new LoggerService({ logLevel: "error" });
logger.initialize();

const eventBus = new EventBus({
    logger,
    eventBusConfig: { logEvents: false, showDebugPanel: false }
});
eventBus.initialize();

const timers = Object.fromEntries(
    Object.values(TIMER_PHASES).map((phase) => [
        phase,
        { phase, durationMs: phase === TIMER_PHASES.RESULT ? RESULT_DURATION_MS : 2 }
    ])
);
const gameCatalog = { getTimers: () => timers };
const gameClockEngine = new GameClockEngine({ logger, eventBus, gameCatalog });
gameClockEngine.initialize();

const states = new Map([[GAME_ID, GAME_STATES.BRAKE]]);
const gameStateEngine = {
    getState: (gameId) => states.get(gameId) ?? null,
    transition(gameId, nextState, { reason } = {}) {
        const previousState = states.get(gameId) ?? null;
        states.set(gameId, nextState);
        eventBus.emit({
            source: EVENT_SOURCES.GAME_STATE_ENGINE,
            type: EVENT_TYPES.GAME_STATE_CHANGED,
            payload: { gameId, previousState, currentState: nextState, reason }
        });
        return { gameId, currentState: nextState };
    },
    removeState: (gameId) => states.delete(gameId)
};

const winnerResult = { winner: { playerId: "winner" } };
const winnerEngine = {
    getResult: (gameId) => gameId === GAME_ID ? winnerResult : null,
    removeResult() {}
};

const gameplayPhaseLifecycle = new GameplayPhaseLifecycle({
    logger,
    eventBus,
    gameStateEngine,
    gameClockEngine,
    winnerEngine
});

const eventOrder = [];
for (const eventType of [
    EVENT_TYPES.RESULT_STARTED,
    EVENT_TYPES.RESULT_COMPLETED,
    EVENT_TYPES.GAME_RESULT_READY,
    EVENT_TYPES.OPEN_PAGE6,
    EVENT_TYPES.CLEANUP_COMPLETED
]) {
    // Subscribe first so nested synchronous lifecycle events are recorded
    // after their triggering RESULT_COMPLETED event.
    eventBus.subscribe(eventType, () => eventOrder.push(eventType));
}

gameplayPhaseLifecycle.initialize();

const gameplayLifecycle = new GameplayLifecycle({
    logger,
    eventBus,
    gameCatalog,
    physicsEngine: { getSimulation: () => null, removeSimulation() {} },
    inputAuthority: { hasGame: () => false, removeGame() {} },
    gameClockEngine,
    gameStateEngine,
    configurationEngine: {
        getConfiguration: () => null,
        removeConfiguration() {}
    },
    winnerEngine,
    winnerActivation: null,
    gameManager: { hasGame: () => false, getGames: () => [] },
    waitForAudit: true
});
gameplayLifecycle.initialize();

// Reproduce the production race condition: audit is already terminal when the
// RESULT state transition schedules gameplay cleanup.
eventBus.emit({
    source: EVENT_SOURCES.AUDIT_ENGINE,
    type: EVENT_TYPES.AUDIT_READY,
    payload: { gameId: GAME_ID }
});

// RESULT is entered from the normal authoritative clock callback after BRAKE.
eventBus.subscribe(EVENT_TYPES.BRAKE_COMPLETED, ({ payload }) => {
    if (payload?.gameId === GAME_ID) {
        assert.ok(gameClockEngine.beginResultPhase(GAME_ID));
    }
});

gameClockEngine.createClock(GAME_ID);
gameClockEngine.startClock(GAME_ID);

await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("RESULT cleanup timed out")), 2000);
    const poll = setInterval(() => {
        if (eventOrder.includes(EVENT_TYPES.CLEANUP_COMPLETED)) {
            clearTimeout(deadline);
            clearInterval(poll);
            resolve();
        }
    }, 2);
});

assert.deepEqual(eventOrder, [
    EVENT_TYPES.RESULT_STARTED,
    EVENT_TYPES.RESULT_COMPLETED,
    EVENT_TYPES.GAME_RESULT_READY,
    EVENT_TYPES.OPEN_PAGE6,
    EVENT_TYPES.CLEANUP_COMPLETED
]);
assert.equal(
    eventOrder.filter((eventType) => eventType === EVENT_TYPES.OPEN_PAGE6).length,
    1,
    "Page6 must open exactly once before cleanup"
);
assert.equal(
    JSON.stringify(DEFAULT_GAMEPLAY_PHASE_DURATIONS_MS),
    JSON.stringify({
        [GAME_STATES.PRE_GAME_READY]: 180000,
        [GAME_STATES.READY]: 3000,
        [GAME_STATES.SELF_TEST]: 2000,
        [GAME_STATES.SPEED]: 8000,
        [GAME_STATES.BRAKE]: 6000,
        [GAME_STATES.RESULT]: 4000
    }),
    "all existing gameplay phase timers must remain unchanged"
);

gameplayLifecycle.shutdown();
gameplayPhaseLifecycle.shutdown();
gameClockEngine.shutdown();
eventBus.shutdown();
logger.shutdown();

console.log("gameplayResultCleanupRace.test.js: all assertions passed");
