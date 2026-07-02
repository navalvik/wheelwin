import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameManager } from "../managers/GameManager.js";
import { GAME_STATUS } from "../models/GameStatus.js";
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

const emitted = [];

for (const type of [
    EVENT_TYPES.GAME_CREATED,
    EVENT_TYPES.GAME_INITIALIZED,
    EVENT_TYPES.GAME_STARTED,
    EVENT_TYPES.GAME_FINISHED,
    EVENT_TYPES.GAME_DESTROYED
]) {

    eventBus.subscribe(type, (envelope) => {

        emitted.push(envelope.type);

    });

}

const gameManager = new GameManager({ logger, eventBus });

gameManager.initialize();

const game = gameManager.createGame("room-1");

assert(game, "createGame should return a game");

assert(gameManager.hasGame(game.gameId), "game should be registered");

gameManager.initializeGame(game.gameId);

assert(
    gameManager.getGame(game.gameId).status === GAME_STATUS.READY,
    "initializeGame should move game to READY"
);

gameManager.startGame(game.gameId);

gameManager.finishGame(game.gameId);

gameManager.destroyGame(game.gameId);

assert(!gameManager.hasGame(game.gameId), "destroyed game should be removed");

assert(
    emitted.join(",") === [
        EVENT_TYPES.GAME_CREATED,
        EVENT_TYPES.GAME_INITIALIZED,
        EVENT_TYPES.GAME_STARTED,
        EVENT_TYPES.GAME_FINISHED,
        EVENT_TYPES.GAME_DESTROYED
    ].join(","),
    "lifecycle should emit events in order"
);

assert(
    gameManager.startGame("missing-game-id") === null,
    "missing game should return null"
);

const gameIds = new Set();

for (let index = 0; index < 5; index += 1) {

    const created = gameManager.createGame(`room-${index}`);

    assert(created, "game creation should succeed");

    assert(!gameIds.has(created.gameId), "gameId should be unique");

    gameIds.add(created.gameId);

}

assert(gameManager.getGames().length === 5, "registry should track active games");

gameManager.shutdown();

assert(gameManager.getGames().length === 0, "shutdown should destroy all games");

logger.info("GameManager tests passed");
