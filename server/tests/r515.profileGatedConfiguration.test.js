import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameManager } from "../managers/GameManager.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import {
    areRoomPlayerProfilesComplete,
    isPlayerProfileComplete
} from "../managers/playerProfileCompleteness.js";
import { LoggerService } from "../services/LoggerService.js";
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

{
    assert(
        !isPlayerProfileComplete(null),
        "null identity is incomplete"
    );

    assert(
        !isPlayerProfileComplete({
            playerId: "p1",
            nickname: "Bob",
            sectorCount: 1,
            color: "Red"
        }),
        "missing icon is incomplete"
    );

    assert(
        !isPlayerProfileComplete({
            playerId: "p1",
            nickname: "Bob",
            sectorCount: 1,
            color: "Red",
            icon: "dice"
        }),
        "missing baseStake is incomplete"
    );

    assert(
        isPlayerProfileComplete({
            playerId: "p1",
            nickname: "Bob",
            baseStake: 10,
            sectorCount: 1,
            color: "Red",
            icon: "dice"
        }),
        "single-sector profile with color+icon+stake is complete"
    );

    assert(
        !isPlayerProfileComplete({
            playerId: "p1",
            nickname: "Bob",
            baseStake: 10,
            sectorCount: 2,
            color: "Orange",
            icon: "dice"
        }),
        "two-sector profile without colorSector2 is incomplete"
    );

    console.log("  profile completeness checks passed");
}

const logger = new LoggerService({ logLevel: "error" });

logger.initialize();

const eventBus = new EventBus({
    logger,
    eventBusConfig: { logEvents: false, showDebugPanel: false }
});

eventBus.initialize();

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

{
    const room = roomManager.createRoom();

    const playerIds = ["r515-a", "r515-b", "r515-c"];

    for (const playerId of playerIds) {

        playerManager.createPlayer({ playerId });

        roomManager.addPlayer(room.roomId, playerId);

    }

    const gameId = gameManager.getGames()[0]?.gameId;

    assert(gameId, "ROOM_FULL still creates a game");

    assert(
        !harness.configurationEngine.getConfiguration(gameId),
        "configuration must NOT build before Page2 profiles"
    );

    assert(
        !areRoomPlayerProfilesComplete(playerManager, playerIds),
        "empty identities are incomplete"
    );

    seedCompletePlayerProfiles(playerManager, playerIds);

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.ALL_PLAYER_PROFILES_READY,
        payload: { roomId: room.roomId }
    });

    const configuration = harness.configurationEngine.getConfiguration(gameId);

    assert(configuration, "configuration builds after profiles ready");

    assert(
        configuration.stake === 10,
        `configuration stake must come from Page2 baseStake, got ${configuration.stake}`
    );

    assert(
        configuration.sectors.length === 5,
        `expected 5 sectors, got ${configuration.sectors.length}`
    );

    const colorIds = configuration.sectors.map((sector) => sector.colorId).sort();

    assert(
        JSON.stringify(colorIds) === JSON.stringify([
            "GREEN",
            "GREEN",
            "ORANGE",
            "ORANGE",
            "RED"
        ]),
        `expected Orange×2 Green×2 Red, got ${JSON.stringify(colorIds)}`
    );

    for (const player of configuration.players) {

        assert(player.nickname, "committed player nickname must be set");
        assert(player.sectorCount === 1 || player.sectorCount === 2, "sectorCount set");
        assert(player.color, "committed player color must be set");
    }

    console.log("  deferred configuration after profiles passed");
}

shutdownGameplayBootstrap(harness);

gameManager.shutdown();

playerManager.shutdown();

roomManager.shutdown();

eventBus.shutdown();

logger.shutdown();

console.log("R5.15 profile-gated configuration tests passed");
