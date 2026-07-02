import { TIMER_PHASES } from "../catalog/Timers.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameClockEngine } from "../engines/GameClockEngine.js";
import { LoggerService } from "../services/LoggerService.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function createFastCatalog() {

    return {
        getTimers() {

            return {
                [TIMER_PHASES.COUNTDOWN]: {
                    phase: TIMER_PHASES.COUNTDOWN,
                    durationMs: 15
                },
                [TIMER_PHASES.SELF_TEST]: {
                    phase: TIMER_PHASES.SELF_TEST,
                    durationMs: 15
                },
                [TIMER_PHASES.SPEED]: {
                    phase: TIMER_PHASES.SPEED,
                    durationMs: null
                },
                [TIMER_PHASES.BRAKE]: {
                    phase: TIMER_PHASES.BRAKE,
                    durationMs: 15
                },
                [TIMER_PHASES.RESULT]: {
                    phase: TIMER_PHASES.RESULT,
                    durationMs: null
                }
            };

        }
    };

}

function waitForPhase(eventBus, gameId, phase) {

    return new Promise((resolve) => {

        const handler = (envelope) => {

            if (envelope.payload.gameId !== gameId) {

                return;

            }

            if (envelope.payload.phase !== phase) {

                return;

            }

            eventBus.unsubscribe(EVENT_TYPES.PHASE_TIMEOUT, handler);

            resolve(envelope.payload);

        };

        eventBus.subscribe(EVENT_TYPES.PHASE_TIMEOUT, handler);

    });

}

const logger = new LoggerService();

logger.initialize();

const eventBus = new EventBus({
    logger,
    eventBusConfig: { logEvents: false, showDebugPanel: false }
});

eventBus.initialize();

const gameClockEngine = new GameClockEngine({
    logger,
    eventBus,
    gameCatalog: createFastCatalog()
});

gameClockEngine.initialize();

const gameId = "clock-test-game";

const timeouts = [];

eventBus.subscribe(EVENT_TYPES.PHASE_TIMEOUT, (envelope) => {

    if (envelope.payload.gameId === gameId) {

        timeouts.push(envelope.payload.phase);

    }

});

assert(
    gameClockEngine.createClock(gameId),
    "createClock should succeed"
);

assert(
    gameClockEngine.createClock(gameId) === null,
    "duplicate clock should be rejected"
);

gameClockEngine.startClock(gameId);

assert(gameClockEngine.isRunning(gameId), "clock should be running");

await waitForPhase(eventBus, gameId, "COUNTDOWN");

await waitForPhase(eventBus, gameId, "SELF_TEST");

const elapsedBeforePause = gameClockEngine.getElapsed(gameId);

gameClockEngine.pauseClock(gameId);

assert(
    gameClockEngine.getClock(gameId).paused,
    "clock should be paused"
);

await new Promise((resolve) => {

    setTimeout(resolve, 20);

});

const elapsedWhilePaused = gameClockEngine.getElapsed(gameId);

assert(
    elapsedWhilePaused >= elapsedBeforePause
    && elapsedWhilePaused <= elapsedBeforePause + 5,
    "elapsed time should not advance while paused"
);

gameClockEngine.resumeClock(gameId);

gameClockEngine.completePhase(gameId);

await waitForPhase(eventBus, gameId, "BRAKE");

gameClockEngine.stopClock(gameId);

assert(!gameClockEngine.isRunning(gameId), "clock should be stopped");

gameClockEngine.removeClock(gameId);

assert(
    gameClockEngine.getClock(gameId) === null,
    "clock should be removed"
);

assert(
    timeouts.join(",") === "COUNTDOWN,SELF_TEST,SPEED,BRAKE",
    "phase timeouts should fire in order"
);

gameClockEngine.shutdown();

logger.info("GameClockEngine tests passed");
