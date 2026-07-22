import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { ConfigurationEngine } from "../engines/ConfigurationEngine.js";
import { GameCatalog } from "../catalog/GameCatalog.js";
import { GameManager } from "../managers/GameManager.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { LoggerService } from "../services/LoggerService.js";
import { RandomService } from "../services/RandomService.js";
import {
    seedCompletePlayerProfiles,
    shutdownGameplayBootstrap,
    wireGameplayBootstrap
} from "./helpers/gameplayBootstrapHarness.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

const logger = new LoggerService({ logLevel: "error" });

logger.initialize();

const eventBus = new EventBus({
    logger,
    eventBusConfig: { logEvents: false, showDebugPanel: false }
});

eventBus.initialize();

const catalog = new GameCatalog({ logger });

catalog.initialize();

const randomService = new RandomService({ logger });

randomService.initialize();

randomService.setSeed(17);

{
    const engine = new ConfigurationEngine({
        logger,
        eventBus,
        gameCatalog: catalog,
        randomService
    });

    engine.initialize();

    const configuration = engine.buildConfiguration(
        "r517-copy-icons",
        { roomId: "room-r517", stake: 1 },
        [
            {
                playerId: "bob",
                nickname: "Bob",
                sectorCount: 2,
                sectorArrangement: "together",
                colors: ["Orange", "Orange"],
                icon: "frog"
            },
            {
                playerId: "lena",
                nickname: "Lena",
                sectorCount: 2,
                sectorArrangement: "together",
                colors: ["Green", "Green"],
                icon: "fox"
            },
            {
                playerId: "qwe",
                nickname: "qwe",
                sectorCount: 1,
                colors: ["Red"],
                icon: "lion"
            }
        ]
    );

    assert(configuration.sectors.length === 5, "expected 5 sectors");

    for (const player of configuration.players) {

        assert(
            ["frog", "fox", "lion"].includes(player.icon),
            `player icon must be copied (${player.icon})`
        );

    }

    for (const sector of configuration.sectors) {

        const owner = configuration.players.find(
            (player) => player.playerId === sector.ownerId
        );

        assert(owner, "sector owner must exist");

        assert(
            sector.icon === owner.icon,
            "sector.icon must equal authoritative player.icon"
        );

    }

    assert(
        configuration.players.every((player) => player.icon !== "dice")
            || configuration.players.some((player) => player.icon === "frog"),
        "ConfigurationEngine must not replace VERIFY icons with random catalog picks"
    );

    console.log("  ConfigurationEngine copies player.icon → sector.icon");

    engine.shutdown();
}

{
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
        devMode: true
    });

    const room = roomManager.createRoom();

    const playerIds = ["r517-a", "r517-b", "r517-c"];

    seedCompletePlayerProfiles(playerManager, playerIds);

    for (const playerId of playerIds) {

        roomManager.addPlayer(room.roomId, playerId);

    }

    const gameId = gameManager.getGames()[0]?.gameId;

    const configuration = harness.configurationEngine.getConfiguration(gameId);

    assert(configuration, "configuration builds with seeded VERIFY icons");

    const icons = configuration.players.map((player) => player.icon);

    assert(
        new Set(icons).size === icons.length,
        "player icons must be unique"
    );

    for (const sector of configuration.sectors) {

        const owner = configuration.players.find(
            (player) => player.playerId === sector.ownerId
        );

        assert(
            sector.icon === owner.icon,
            "wheel sector icons match committed player icons"
        );

    }

    console.log("  seeded VERIFY icons flow into WHEEL_CONFIGURATION");

    shutdownGameplayBootstrap(harness);

    gameManager.shutdown();

    playerManager.shutdown();

    roomManager.shutdown();
}

eventBus.shutdown();

logger.shutdown();

console.log("R5.17 VERIFY icon assignment tests passed");
