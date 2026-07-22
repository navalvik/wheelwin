import { GameCatalog } from "../catalog/GameCatalog.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { ConfigurationEngine } from "../engines/ConfigurationEngine.js";
import { ConfigurationValidationError } from "../engines/configuration/ConfigurationValidationError.js";
import { LoggerService } from "../services/LoggerService.js";
import { RandomService } from "../services/RandomService.js";
import { createStandardConfigurationPlayers } from "./helpers/configurationPlayers.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

const logger = new LoggerService();

logger.initialize();

const catalog = new GameCatalog({ logger });

catalog.initialize();

const eventBus = new EventBus({
    logger,
    eventBusConfig: { logEvents: false, showDebugPanel: false }
});

eventBus.initialize();

const randomService = new RandomService({ logger });

randomService.initialize();

randomService.setSeed(1458);

const configurationEngine = new ConfigurationEngine({
    logger,
    eventBus,
    gameCatalog: catalog,
    randomService
});

configurationEngine.initialize();

const emitted = [];

eventBus.subscribe(EVENT_TYPES.CONFIGURATION_READY, (envelope) => {

    emitted.push(envelope.type);

});

const gameId = "game_config_test";

const configuration = configurationEngine.generateConfiguration(
    gameId,
    {
        roomId: "room-test",
        stake: 1
    },
    createStandardConfigurationPlayers([
        "player-1",
        "player-2",
        "player-3"
    ])
);

assert(configuration.gameId === gameId, "configuration should include gameId");

assert(configuration.sectors.length === 6, "configuration should include 6 sectors");

assert(
    configuration.players.length === 3,
    "configuration should include 3 players"
);

assert(
    configuration.sectors.every((sector) => Number.isFinite(sector.angleStart)),
    "every sector must include angleStart"
);

assert(
    configuration.sectors.every((sector) => Number.isFinite(sector.angleEnd)),
    "every sector must include angleEnd"
);

assert(
    Object.isFrozen(configuration),
    "configuration should be frozen"
);

const stored = configurationEngine.getConfiguration(gameId);

assert(stored === configuration, "registry should store frozen configuration");

let mutationBlocked = false;

try {

    stored.players.push({ playerId: "hack" });

} catch (error) {

    mutationBlocked = error instanceof TypeError;

}

assert(mutationBlocked, "frozen configuration should reject mutation");

configurationEngine.removeConfiguration(gameId);

assert(
    emitted.length === 1,
    "CONFIGURATION_READY should be emitted once"
);

let rejected = false;

try {

    configurationEngine.generateConfiguration(
        gameId,
        { roomId: "room-test", stake: 99 },
        [{
            playerId: "player-1",
            sectorCount: 6,
            colors: ["Red", "Green", "Blue", "Yellow", "Orange", "Violet"]
        }]
    );

} catch (error) {

    rejected = error instanceof ConfigurationValidationError;

}

assert(rejected, "invalid stake should reject configuration");

configurationEngine.shutdown();

randomService.shutdown();

logger.info("ConfigurationEngine tests passed");
