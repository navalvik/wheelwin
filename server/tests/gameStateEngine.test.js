import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { LoggerService } from "../services/LoggerService.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

const logger = new LoggerService();

logger.initialize();

const eventBus = new EventBus({
    logger,
    eventBusConfig: { logEvents: false, showDebugPanel: false }
});

eventBus.initialize();

const changed = [];

const rejected = [];

eventBus.subscribe(EVENT_TYPES.GAME_STATE_CHANGED, (envelope) => {

    changed.push(envelope.payload.currentState);

});

eventBus.subscribe(EVENT_TYPES.GAME_STATE_REJECTED, (envelope) => {

    rejected.push(envelope.payload.requestedState);

});

const gameStateEngine = new GameStateEngine({ logger, eventBus });

gameStateEngine.initialize();

const gameId = "game-fsm-test";

gameStateEngine.initializeGameState(gameId);

assert(
    gameStateEngine.getState(gameId) === GAME_STATES.READY,
    "initialized game should be READY"
);

const sequence = [
    GAME_STATES.COUNTDOWN,
    GAME_STATES.SELF_TEST,
    GAME_STATES.SPEED,
    GAME_STATES.BRAKE,
    GAME_STATES.RESULT
];

for (const nextState of sequence) {

    assert(
        gameStateEngine.canTransition(gameId, nextState),
        `transition to ${nextState} should be allowed`
    );

    gameStateEngine.transition(gameId, nextState, {
        reason: `Move to ${nextState}`
    });

}

assert(
    gameStateEngine.getState(gameId) === GAME_STATES.RESULT,
    "final state should be RESULT"
);

assert(
    gameStateEngine.getHistory(gameId).length === 6,
    "history should contain all states"
);

assert(
    !gameStateEngine.canTransition(gameId, GAME_STATES.READY),
    "RESULT to READY should be forbidden"
);

gameStateEngine.transition(gameId, GAME_STATES.READY, {
    reason: "Invalid"
});

assert(
    rejected.includes(GAME_STATES.READY),
    "invalid transition should emit GAME_STATE_REJECTED"
);

assert(
    !gameStateEngine.transition(gameId, GAME_STATES.SELF_TEST),
    "invalid transition should return null"
);

gameStateEngine.removeState(gameId);

assert(
    gameStateEngine.getState(gameId) === null,
    "removed game should have no state"
);

gameStateEngine.shutdown();

logger.info("GameStateEngine tests passed");
