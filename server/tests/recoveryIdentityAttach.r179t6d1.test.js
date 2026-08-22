import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { RoomManager } from "../managers/RoomManager.js";
import { GameManager } from "../managers/GameManager.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { Room } from "../models/Room.js";
import { Game } from "../models/Game.js";
import { GAME_STATUS } from "../models/GameStatus.js";
import { PlayerIdentity } from "../models/PlayerIdentity.js";
import { PlayerRuntime } from "../models/PlayerRuntime.js";
import { ROOM_STATUS } from "../models/RoomStatus.js";
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

// ---------------------------------------------------------------------------
// RoomManager — attachRoom
// ---------------------------------------------------------------------------

(function testRoomManagerAttachRoom() {

    const roomManager = new RoomManager({
        logger,
        eventBus,
        roomConfig: { maxPlayers: 3 }
    });

    roomManager.initialize();

    const existingRoomId = "recovery-room-001";

    const room = new Room({
        roomId: existingRoomId,
        createdAt: 1000,
        status: ROOM_STATUS.WAITING_FOR_PLAYERS,
        maxPlayers: 3,
        players: ["player-a", "player-b"]
    });

    // attachRoom registers an existing Room using its existing roomId
    const attached = roomManager.attachRoom(room);

    assert(attached, "attachRoom should return the room");

    assert(
        attached.roomId === existingRoomId,
        "attachRoom must preserve the existing roomId"
    );

    assert(
        roomManager.hasRoom(existingRoomId),
        "attached room should be registered in hasRoom"
    );

    assert(
        roomManager.getRoom(existingRoomId).roomId === existingRoomId,
        "getRoom should return the attached room by its existing roomId"
    );

    // attachRoom does not generate a replacement roomId
    assert(
        roomManager.getRoom(existingRoomId).roomId === existingRoomId,
        "attachRoom must not generate a replacement roomId"
    );

    // duplicate roomId is rejected safely
    const duplicate = new Room({
        roomId: existingRoomId,
        createdAt: 2000,
        status: ROOM_STATUS.WAITING_FOR_PLAYERS,
        maxPlayers: 3,
        players: []
    });

    assert(
        roomManager.attachRoom(duplicate) === null,
        "duplicate roomId should be rejected safely (null)"
    );

    // the original room is not overwritten by the duplicate
    assert(
        roomManager.getRoom(existingRoomId).createdAt === 1000,
        "duplicate attach must not overwrite the existing room"
    );

    // attachRoom with missing room is rejected
    assert(
        roomManager.attachRoom(null) === null,
        "attachRoom(null) should return null"
    );

    // attachRoom with missing roomId is rejected
    const noIdRoom = new Room({ roomId: null });

    assert(
        roomManager.attachRoom(noIdRoom) === null,
        "attachRoom with null roomId should return null"
    );

    // existing createRoom behavior remains unchanged
    const created = roomManager.createRoom();

    // createRoom requires SetupSessionLifecycle; without it returns null
    assert(created === null, "createRoom without SetupSessionLifecycle should return null");

    roomManager.shutdown();

})();

// ---------------------------------------------------------------------------
// GameManager — attachGame
// ---------------------------------------------------------------------------

(function testGameManagerAttachGame() {

    const gameManager = new GameManager({ logger, eventBus });

    gameManager.initialize();

    const existingGameId = "game_recovery_001";

    const game = new Game({
        gameId: existingGameId,
        roomId: "recovery-room-001",
        createdAt: 1000,
        status: GAME_STATUS.CREATED,
        players: ["player-a", "player-b", "player-c"],
        metadata: {}
    });

    // attachGame registers an existing Game using its existing gameId
    const attached = gameManager.attachGame(game);

    assert(attached, "attachGame should return the game");

    assert(
        attached.gameId === existingGameId,
        "attachGame must preserve the existing gameId"
    );

    assert(
        gameManager.hasGame(existingGameId),
        "attached game should be registered in hasGame"
    );

    assert(
        gameManager.getGame(existingGameId).gameId === existingGameId,
        "getGame should return the attached game by its existing gameId"
    );

    // attachGame does not generate a replacement gameId
    assert(
        gameManager.getGame(existingGameId).gameId === existingGameId,
        "attachGame must not generate a replacement gameId"
    );

    // duplicate gameId is rejected safely
    const duplicate = new Game({
        gameId: existingGameId,
        roomId: "another-room",
        createdAt: 2000,
        status: GAME_STATUS.CREATED,
        players: [],
        metadata: {}
    });

    assert(
        gameManager.attachGame(duplicate) === null,
        "duplicate gameId should be rejected safely (null)"
    );

    // the original game is not overwritten by the duplicate
    assert(
        gameManager.getGame(existingGameId).createdAt === 1000,
        "duplicate attach must not overwrite the existing game"
    );

    // attachGame with missing game is rejected
    assert(
        gameManager.attachGame(null) === null,
        "attachGame(null) should return null"
    );

    // attachGame with missing gameId is rejected
    const noIdGame = new Game({ gameId: null });

    assert(
        gameManager.attachGame(noIdGame) === null,
        "attachGame with null gameId should return null"
    );

    // existing createGame behavior remains unchanged
    const created = gameManager.createGame("room-normal-1");

    assert(created, "createGame should return a game");

    assert(
        created.gameId.startsWith("game_"),
        "createGame should generate a game_ prefixed UUID gameId"
    );

    assert(
        gameManager.hasGame(created.gameId),
        "createGame result should be registered"
    );

    gameManager.shutdown();

})();

// ---------------------------------------------------------------------------
// PlayerManager — attachPlayer
// ---------------------------------------------------------------------------

(function testPlayerManagerAttachPlayer() {

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

    const existingPlayerId = "player_recovery_001";

    const identity = new PlayerIdentity({
        playerId: existingPlayerId,
        nickname: "RecoveredPlayer",
        wallet: "EQwallet001",
        icon: "icon-a",
        age: 25,
        color: "red",
        colorSector2: null,
        sectorCount: 1,
        sectorArrangement: "together",
        baseStake: 10,
        createdAt: 1000
    });

    const runtime = new PlayerRuntime({
        lastSeen: 2000
    });

    // attachPlayer registers an existing Player using its existing playerId
    const attached = playerManager.attachPlayer(identity, runtime);

    assert(attached, "attachPlayer should return a player object");

    assert(
        attached.identity.playerId === existingPlayerId,
        "attachPlayer must preserve the existing playerId"
    );

    assert(
        playerManager.hasPlayer(existingPlayerId),
        "attached player should be registered in hasPlayer"
    );

    assert(
        playerManager.getPlayer(existingPlayerId).identity.playerId === existingPlayerId,
        "getPlayer should return the attached player by its existing playerId"
    );

    // attachPlayer does not generate a replacement playerId
    assert(
        playerManager.getIdentity(existingPlayerId).playerId === existingPlayerId,
        "attachPlayer must not generate a replacement playerId"
    );

    // attachPlayer preserves the existing identity fields
    assert(
        playerManager.getIdentity(existingPlayerId).nickname === "RecoveredPlayer",
        "attachPlayer must preserve the existing nickname"
    );

    assert(
        playerManager.getIdentity(existingPlayerId).wallet === "EQwallet001",
        "attachPlayer must preserve the existing wallet"
    );

    // attachPlayer preserves the existing runtime fields
    assert(
        playerManager.getRuntime(existingPlayerId).lastSeen === 2000,
        "attachPlayer must preserve the existing runtime lastSeen"
    );

    // duplicate playerId is rejected safely
    const dupIdentity = new PlayerIdentity({
        playerId: existingPlayerId,
        nickname: "DuplicatePlayer"
    });

    const dupRuntime = new PlayerRuntime({});

    assert(
        playerManager.attachPlayer(dupIdentity, dupRuntime) === null,
        "duplicate playerId should be rejected safely (null)"
    );

    // the original player is not overwritten by the duplicate
    assert(
        playerManager.getIdentity(existingPlayerId).nickname === "RecoveredPlayer",
        "duplicate attach must not overwrite the existing player identity"
    );

    // attachPlayer with missing identity is rejected
    assert(
        playerManager.attachPlayer(null, runtime) === null,
        "attachPlayer(null, runtime) should return null"
    );

    // attachPlayer with missing runtime is rejected
    assert(
        playerManager.attachPlayer(identity, null) === null,
        "attachPlayer(identity, null) should return null"
    );

    // attachPlayer with missing playerId is rejected
    const noIdIdentity = new PlayerIdentity({ playerId: null });

    assert(
        playerManager.attachPlayer(noIdIdentity, runtime) === null,
        "attachPlayer with null playerId should return null"
    );

    // existing createPlayer behavior remains unchanged
    const created = playerManager.createPlayer({ nickname: "NormalPlayer" });

    assert(created, "createPlayer should return a player");

    assert(
        created.identity.playerId.startsWith("player_"),
        "createPlayer should generate a player_ prefixed UUID playerId"
    );

    assert(
        playerManager.hasPlayer(created.identity.playerId),
        "createPlayer result should be registered"
    );

    // createPlayer with explicit playerId still works (existing behavior)
    const explicitId = "player_explicit_001";

    const explicitPlayer = playerManager.createPlayer({ playerId: explicitId });

    assert(explicitPlayer, "createPlayer with explicit playerId should succeed");

    assert(
        explicitPlayer.identity.playerId === explicitId,
        "createPlayer should use the provided playerId"
    );

    playerManager.shutdown();

})();

logger.info("R17.9T.6-D1 recovery identity attach tests passed");