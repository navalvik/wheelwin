import { createHash } from "node:crypto";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { RoomManager } from "../managers/RoomManager.js";
import { GameManager } from "../managers/GameManager.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { ConfigurationEngine } from "../engines/ConfigurationEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { WinnerEngine } from "../engines/WinnerEngine.js";
import { PHYSICS_SIMULATION_STATE } from "../engines/physics/PhysicsSimulationState.js";
import { Room } from "../models/Room.js";
import { Game } from "../models/Game.js";
import { GAME_STATUS } from "../models/GameStatus.js";
import { ROOM_STATUS } from "../models/RoomStatus.js";
import { PlayerIdentity } from "../models/PlayerIdentity.js";
import { PlayerRuntime } from "../models/PlayerRuntime.js";
import { GameCatalog } from "../catalog/GameCatalog.js";
import { LoggerService } from "../services/LoggerService.js";
import { stableStringify } from "../persistence/tonFinancialRecordUtils.js";

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
// Event isolation counters — every forbidden removal/lifecycle event is
// counted globally so any indirect emission through normal destruction paths
// would fail the test.
// ---------------------------------------------------------------------------

const FORBIDDEN_EVENTS = Object.freeze([
    EVENT_TYPES.ROOM_DESTROYED,
    EVENT_TYPES.GAME_DESTROYED,
    EVENT_TYPES.PLAYER_REMOVED,
    EVENT_TYPES.CONFIGURATION_REMOVED,
    EVENT_TYPES.GAME_RESULT_REMOVED,
    EVENT_TYPES.ROOM_CREATED,
    EVENT_TYPES.GAME_CREATED,
    EVENT_TYPES.PLAYER_CREATED,
    EVENT_TYPES.CONFIGURATION_READY,
    EVENT_TYPES.GAME_RESULT_READY,
    EVENT_TYPES.WINNING_SECTOR_RESOLVED,
    EVENT_TYPES.PHYSICS_STOPPED,
    EVENT_TYPES.CLOCK_STOPPED
]);

const eventCounts = new Map();

for (const eventType of FORBIDDEN_EVENTS) {

    eventCounts.set(eventType, 0);

    eventBus.subscribe(eventType, () => {

        eventCounts.set(eventType, (eventCounts.get(eventType) ?? 0) + 1);

    });

}

function resetEventCounts() {

    for (const eventType of FORBIDDEN_EVENTS) {

        eventCounts.set(eventType, 0);

    }

}

function assertZeroForbiddenEvents(label) {

    for (const [eventType, count] of eventCounts) {

        assert(
            count === 0,
            `${label}: forbidden event ${eventType} was emitted (count=${count})`
        );

    }

}

// ---------------------------------------------------------------------------
// RoomManager — detachRoom
// ---------------------------------------------------------------------------

(function testRoomDetach() {

    resetEventCounts();

    const roomManager = new RoomManager({
        logger,
        eventBus,
        roomConfig: { maxPlayers: 3 }
    });

    roomManager.initialize();

    const roomAId = "detach-room-a";

    const roomBId = "detach-room-b";

    const player1 = "player-1";

    const player2 = "player-2";

    const player3 = "player-3";

    // Entry exists before detach.
    const roomA = new Room({
        roomId: roomAId,
        createdAt: 1000,
        status: ROOM_STATUS.FULL,
        maxPlayers: 3,
        players: [player1, player2]
    });

    const roomB = new Room({
        roomId: roomBId,
        createdAt: 2000,
        status: ROOM_STATUS.FULL,
        maxPlayers: 3,
        players: [player3]
    });

    assert(roomManager.attachRoom(roomA), "room A should attach");

    assert(roomManager.attachRoom(roomB), "room B should attach");

    assert(roomManager.hasRoom(roomAId), "room A should exist before detach");

    assert(roomManager.hasRoom(roomBId), "room B should exist before detach");

    // Detach removes exactly the requested entry.
    assert(
        roomManager.detachRoom(roomAId) === true,
        "detachRoom should return true for an existing room"
    );

    assert(
        !roomManager.hasRoom(roomAId),
        "room A must be removed by detachRoom"
    );

    assert(
        roomManager.getRoom(roomAId) === null,
        "getRoom must return null for the detached room"
    );

    // Unrelated entries remain intact.
    assert(
        roomManager.hasRoom(roomBId),
        "room B must remain intact"
    );

    assert(
        roomManager.getRoom(roomBId).roomId === roomBId,
        "room B snapshot must remain accessible"
    );

    // _playerRoomIndex behavior (observable via addPlayer semantics):
    // player1/player2 mappings were removed -> they can join another room;
    // player3 mapping still points to room B -> joining another room fails.
    const probeRoom = new Room({
        roomId: "probe-room",
        createdAt: 3000,
        status: ROOM_STATUS.WAITING_FOR_PLAYERS,
        maxPlayers: 3,
        players: []
    });

    assert(roomManager.attachRoom(probeRoom), "probe room should attach");

    assert(
        roomManager.addPlayer("probe-room", player1) === true,
        "detached room's player1 mapping must be removed (can rejoin)"
    );

    assert(
        roomManager.addPlayer("probe-room", player2) === true,
        "detached room's player2 mapping must be removed (can rejoin)"
    );

    assert(
        roomManager.addPlayer("probe-room", player3) === false,
        "player3 mapping must still point to room B (cannot rejoin elsewhere)"
    );

    // Duplicate detach is a safe no-op.
    assert(
        roomManager.detachRoom(roomAId) === false,
        "duplicate detachRoom must be a safe no-op returning false"
    );

    // Unknown identity is safe.
    assert(
        roomManager.detachRoom("unknown-room") === false,
        "unknown roomId must return false without modification"
    );

    assert(
        roomManager.detachRoom(null) === false,
        "null roomId must return false without modification"
    );

    // No forbidden side effects / events.
    assertZeroForbiddenEvents("RoomManager.detachRoom");

    roomManager.shutdown();

})();

// ---------------------------------------------------------------------------
// GameManager — detachGame
// ---------------------------------------------------------------------------

(function testGameDetach() {

    resetEventCounts();

    const gameManager = new GameManager({ logger, eventBus });

    gameManager.initialize();

    const gameIdA = "game_detach_a";

    const gameIdB = "game_detach_b";

    const gameA = new Game({
        gameId: gameIdA,
        roomId: "room-a",
        createdAt: 1000,
        status: GAME_STATUS.RUNNING,
        players: ["p1", "p2", "p3"],
        metadata: {}
    });

    const gameB = new Game({
        gameId: gameIdB,
        roomId: "room-b",
        createdAt: 2000,
        status: GAME_STATUS.RUNNING,
        players: ["p4", "p5", "p6"],
        metadata: {}
    });

    assert(gameManager.attachGame(gameA), "game A should attach");

    assert(gameManager.attachGame(gameB), "game B should attach");

    // Populate GameManager-owned bookkeeping for both games.
    gameManager.markEntryPaymentActivated(gameIdA);

    gameManager.markEntryPaymentActivated(gameIdB);

    gameManager._pendingGameplayActivation.set("room-a", gameIdA);

    gameManager._pendingGameplayActivation.set("room-b", gameIdB);

    gameManager._pendingConfigurationByRoom.set("room-a", gameIdA);

    gameManager._pendingConfigurationByRoom.set("room-b", gameIdB);

    // Entry exists before detach.
    assert(gameManager.hasGame(gameIdA), "game A should exist before detach");

    // Detach removes exactly the requested entry.
    assert(
        gameManager.detachGame(gameIdA) === true,
        "detachGame should return true for an existing game"
    );

    assert(!gameManager.hasGame(gameIdA), "game A must be removed");

    assert(
        gameManager.getGame(gameIdA) === null,
        "getGame must return null for the detached game"
    );

    // Manager lookup methods remain consistent.
    assert(
        gameManager.getGameIdByRoomId("room-a") === null,
        "lookup by room must not find the detached game"
    );

    assert(
        gameManager.hasInitializedGameplay("room-a") === false,
        "hasInitializedGameplay must be false for the detached game's room"
    );

    // Unrelated entries remain intact.
    assert(gameManager.hasGame(gameIdB), "game B must remain intact");

    assert(
        gameManager.getGameIdByRoomId("room-b") === gameIdB,
        "game B lookup by room must remain consistent"
    );

    assert(
        gameManager.wasEntryPaymentActivated(gameIdB) === true,
        "game B entry-payment marker must remain"
    );

    // Bookkeeping owned by GameManager for the detached game is cleaned.
    assert(
        gameManager.wasEntryPaymentActivated(gameIdA) === false,
        "detached game's entry-payment marker must be removed"
    );

    assert(
        gameManager.getPendingGameplayGameId("room-a") === null,
        "detached game's pending activation entry must be removed"
    );

    assert(
        gameManager.getPendingGameplayGameId("room-b") === gameIdB,
        "unrelated pending activation entry must remain"
    );

    // Duplicate detach is a safe no-op.
    assert(
        gameManager.detachGame(gameIdA) === false,
        "duplicate detachGame must be a safe no-op returning false"
    );

    // Unknown identity is safe.
    assert(
        gameManager.detachGame("unknown-game") === false,
        "unknown gameId must return false without modification"
    );

    // No destroy event occurred.
    assertZeroForbiddenEvents("GameManager.detachGame");

    gameManager.shutdown();

})();

// ---------------------------------------------------------------------------
// PlayerManager — detachPlayer
// ---------------------------------------------------------------------------

(function testPlayerDetach() {

    resetEventCounts();

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

    const playerIdA = "player-detach-a";

    const playerIdB = "player-detach-b";

    function buildIdentity(playerId, nickname) {

        return new PlayerIdentity({
            playerId,
            nickname,
            wallet: `EQwallet-${nickname}`,
            icon: "dice",
            age: 25,
            color: "RED",
            colorSector2: null,
            sectorCount: 1,
            sectorArrangement: "together",
            baseStake: 10,
            createdAt: 1000
        });

    }

    assert(
        playerManager.attachPlayer({
            playerId: playerIdA,
            playerIndex: 0,
            identity: buildIdentity(playerIdA, "PlayerA"),
            runtime: new PlayerRuntime({ lastSeen: 1000 })
        }),
        "player A should attach"
    );

    assert(
        playerManager.attachPlayer({
            playerId: playerIdB,
            playerIndex: 1,
            identity: buildIdentity(playerIdB, "PlayerB"),
            runtime: new PlayerRuntime({ lastSeen: 2000 })
        }),
        "player B should attach"
    );

    // Entry exists before detach.
    assert(playerManager.hasPlayer(playerIdA), "player A should exist");

    // Detach removes exactly the requested identity + runtime entry.
    assert(
        playerManager.detachPlayer(playerIdA) === true,
        "detachPlayer should return true for an existing player"
    );

    assert(!playerManager.hasPlayer(playerIdA), "player A must be removed");

    assert(
        playerManager.getPlayer(playerIdA) === null,
        "getPlayer must return null for the detached player"
    );

    assert(
        playerManager.getIdentity(playerIdA) === null,
        "identity entry must be removed"
    );

    assert(
        playerManager.getRuntime(playerIdA) === null,
        "runtime entry must be removed"
    );

    // Unrelated entries remain intact.
    assert(playerManager.hasPlayer(playerIdB), "player B must remain intact");

    assert(
        playerManager.getIdentity(playerIdB).nickname === "PlayerB",
        "player B identity must remain unchanged"
    );

    assert(
        playerManager.getRuntime(playerIdB).lastSeen === 2000,
        "player B runtime must remain unchanged"
    );

    // Duplicate detach is a safe no-op.
    assert(
        playerManager.detachPlayer(playerIdA) === false,
        "duplicate detachPlayer must be a safe no-op returning false"
    );

    // Unknown identity is safe.
    assert(
        playerManager.detachPlayer("unknown-player") === false,
        "unknown playerId must return false without modification"
    );

    assert(
        playerManager.detachPlayer(null) === false,
        "null playerId must return false without modification"
    );

    // No PLAYER_REMOVED event.
    assertZeroForbiddenEvents("PlayerManager.detachPlayer");

    playerManager.shutdown();

})();

// ---------------------------------------------------------------------------
// ConfigurationEngine — detachConfiguration
// ---------------------------------------------------------------------------

const CONFIG_GAME_ID_A = "game_cfg_detach_a";

const CONFIG_GAME_ID_B = "game_cfg_detach_b";

const CONFIG_ROOM_ID = "room_cfg_detach";

function buildConfiguration(gameId) {

    return {
        gameId,
        configurationVersion: "1.0",
        createdAt: 1000,
        traceSeed: `trace-seed-${gameId}`,
        sectors: [
            {
                sectorId: `${gameId}-sector-0`,
                ownerId: "cfg-player-0",
                color: "#d62828",
                icon: "dice",
                sectorIndexForPlayer: 0,
                angleStart: 0,
                angleEnd: 120
            },
            {
                sectorId: `${gameId}-sector-1`,
                ownerId: "cfg-player-1",
                color: "#00aa44",
                icon: "spade",
                sectorIndexForPlayer: 0,
                angleStart: 120,
                angleEnd: 240
            },
            {
                sectorId: `${gameId}-sector-2`,
                ownerId: "cfg-player-2",
                color: "#1c73d0",
                icon: "queen",
                sectorIndexForPlayer: 0,
                angleStart: 240,
                angleEnd: 360
            }
        ],
        players: [
            {
                playerId: "cfg-player-0",
                nickname: "Player0",
                color: "RED",
                colors: ["RED"],
                icon: "dice",
                sectorCount: 1,
                sectorArrangement: null
            },
            {
                playerId: "cfg-player-1",
                nickname: "Player1",
                color: "GREEN",
                colors: ["GREEN"],
                icon: "spade",
                sectorCount: 1,
                sectorArrangement: null
            },
            {
                playerId: "cfg-player-2",
                nickname: "Player2",
                color: "BLUE",
                colors: ["BLUE"],
                icon: "queen",
                sectorCount: 1,
                sectorArrangement: null
            }
        ],
        wheel: {
            startAngle: 0,
            minSectors: 3,
            maxSectors: 6,
            sectorCount: 3,
            playerOrder: [0, 1, 2]
        },
        triangle: {
            startAngle: 0,
            ratio: { height: 0.04, width: 0.03 }
        },
        timers: {
            PRE_GAME_READY: { phase: "PRE_GAME_READY", durationMs: 180000 },
            READY: { phase: "READY", durationMs: 3000 },
            SELF_TEST: { phase: "SELF_TEST", durationMs: 1500 },
            SPEED: { phase: "SPEED", durationMs: 8000 },
            BRAKE: { phase: "BRAKE", durationMs: 6000 },
            RESULT: { phase: "RESULT", durationMs: 4000 }
        },
        stake: 10,
        metadata: {
            roomId: CONFIG_ROOM_ID,
            catalogVersion: "1.0"
        }
    };

}

function computeConfigurationHash(configuration) {

    return createHash("sha256")
        .update(stableStringify(configuration))
        .digest("hex");

}

function buildRandomService() {

    let calls = 0;

    return {
        generateTraceSeed() {

            calls += 1;

            return "generated-trace-seed";

        },
        nextInt() {

            calls += 1;

            return 0;

        },
        getCallCount() {

            return calls;

        }
    };

}

(function testConfigurationDetach() {

    resetEventCounts();

    const gameCatalog = new GameCatalog({ logger });

    gameCatalog.initialize();

    const configurationEngine = new ConfigurationEngine({
        logger,
        eventBus,
        gameCatalog,
        randomService: buildRandomService()
    });

    configurationEngine.initialize();

    const configurationA = buildConfiguration(CONFIG_GAME_ID_A);

    const configurationB = buildConfiguration(CONFIG_GAME_ID_B);

    assert(
        configurationEngine.attachConfiguration({
            gameId: CONFIG_GAME_ID_A,
            roomId: CONFIG_ROOM_ID,
            configuration: configurationA,
            configurationHash: computeConfigurationHash(configurationA)
        }),
        "configuration A should attach"
    );

    assert(
        configurationEngine.attachConfiguration({
            gameId: CONFIG_GAME_ID_B,
            roomId: CONFIG_ROOM_ID,
            configuration: configurationB,
            configurationHash: computeConfigurationHash(configurationB)
        }),
        "configuration B should attach"
    );

    // Economy registry state for game A (part of per-game runtime state).
    const economyA = configurationEngine.freezeEconomy(CONFIG_GAME_ID_A);

    assert(economyA, "economy A should freeze");

    // Entry exists before detach.
    assert(
        configurationEngine.getConfiguration(CONFIG_GAME_ID_A),
        "configuration A should exist before detach"
    );

    // Detach removes exactly the requested configuration (+ its economy).
    assert(
        configurationEngine.detachConfiguration(CONFIG_GAME_ID_A) === true,
        "detachConfiguration should return true for an existing configuration"
    );

    assert(
        configurationEngine.getConfiguration(CONFIG_GAME_ID_A) === null,
        "detached configuration must be unavailable via getConfiguration"
    );

    assert(
        configurationEngine.getEconomy(CONFIG_GAME_ID_A) === null,
        "detached game's economy entry must be removed"
    );

    assert(
        !configurationEngine.listConfigurationIds().includes(CONFIG_GAME_ID_A),
        "detached configuration id must be absent from listConfigurationIds"
    );

    // Unrelated entries remain intact.
    assert(
        configurationEngine.getConfiguration(CONFIG_GAME_ID_B)?.gameId
            === CONFIG_GAME_ID_B,
        "configuration B must remain intact"
    );

    assert(
        configurationEngine.listConfigurationIds().length === 1,
        "exactly one unrelated configuration must remain"
    );

    // Catalog/version data untouched (configurations can still be attached).
    assert(
        configurationEngine.attachConfiguration({
            gameId: "game_cfg_probe",
            roomId: CONFIG_ROOM_ID,
            configuration: buildConfiguration("game_cfg_probe"),
            configurationHash:
                computeConfigurationHash(buildConfiguration("game_cfg_probe"))
        }),
        "engine must remain fully functional after detach"
    );

    configurationEngine.detachConfiguration("game_cfg_probe");

    // Duplicate detach is a safe no-op.
    assert(
        configurationEngine.detachConfiguration(CONFIG_GAME_ID_A) === false,
        "duplicate detachConfiguration must be a safe no-op returning false"
    );

    // Unknown identity is safe.
    assert(
        configurationEngine.detachConfiguration("unknown-game") === false,
        "unknown gameId must return false without modification"
    );

    // No CONFIGURATION_REMOVED event.
    assertZeroForbiddenEvents("ConfigurationEngine.detachConfiguration");

    configurationEngine.shutdown();

})();

// ---------------------------------------------------------------------------
// WinnerEngine — detachResult
// ---------------------------------------------------------------------------

(function testWinnerResultDetach() {

    resetEventCounts();

    const gameCatalog = new GameCatalog({ logger });

    gameCatalog.initialize();

    const configurationEngine = new ConfigurationEngine({
        logger,
        eventBus,
        gameCatalog,
        randomService: buildRandomService()
    });

    configurationEngine.initialize();

    const physicsEngine = new PhysicsEngine({
        logger,
        eventBus,
        gameClock: null
    });

    physicsEngine.initialize();

    const winnerEngine = new WinnerEngine({
        logger,
        eventBus,
        physicsEngine,
        configurationEngine,
        gameCatalog
    });

    winnerEngine.initialize();

    const RESULT_GAME_ID_A = "game_result_detach_a";

    const RESULT_GAME_ID_B = "game_result_detach_b";

    for (const gameId of [RESULT_GAME_ID_A, RESULT_GAME_ID_B]) {

        const configuration = buildConfiguration(gameId);

        configurationEngine.attachConfiguration({
            gameId,
            roomId: CONFIG_ROOM_ID,
            configuration,
            configurationHash: computeConfigurationHash(configuration)
        });

        physicsEngine.attachSimulation({
            gameId,
            runtime: {
                state: PHYSICS_SIMULATION_STATE.STOPPED,
                angle: 2.5,
                triangleAngle: 1.0,
                angularVelocity: 0,
                triangleAngularVelocity: 0,
                angularAcceleration: 0
            },
            commandLog: []
        }, { emitEvents: false });

        assert(
            winnerEngine.restoreResult(gameId),
            `restoreResult should succeed for ${gameId}`
        );

    }

    // Entry exists before detach.
    assert(
        winnerEngine.getResult(RESULT_GAME_ID_A),
        "result A should exist before detach"
    );

    // Detach removes exactly the requested result.
    assert(
        winnerEngine.detachResult(RESULT_GAME_ID_A) === true,
        "detachResult should return true for an existing result"
    );

    assert(
        winnerEngine.getResult(RESULT_GAME_ID_A) === null,
        "detached result must be unavailable via getResult"
    );

    assert(
        winnerEngine.getDebugSnapshot(RESULT_GAME_ID_A) === null,
        "detached result must be absent from debug snapshot"
    );

    // Unrelated entries remain intact.
    assert(
        winnerEngine.getResult(RESULT_GAME_ID_B)?.gameId === RESULT_GAME_ID_B,
        "result B must remain intact"
    );

    // Configuration/physics untouched by detach.
    assert(
        configurationEngine.getConfiguration(RESULT_GAME_ID_A) !== null,
        "configuration must remain untouched by detachResult"
    );

    assert(
        physicsEngine.getSimulation(RESULT_GAME_ID_A) !== null,
        "physics simulation must remain untouched by detachResult"
    );

    // Duplicate detach is a safe no-op.
    assert(
        winnerEngine.detachResult(RESULT_GAME_ID_A) === false,
        "duplicate detachResult must be a safe no-op returning false"
    );

    // Unknown identity is safe.
    assert(
        winnerEngine.detachResult("unknown-game") === false,
        "unknown gameId must return false without modification"
    );

    // No GAME_RESULT_REMOVED event.
    assertZeroForbiddenEvents("WinnerEngine.detachResult");

    winnerEngine.shutdown();

    physicsEngine.shutdown();

    configurationEngine.shutdown();

})();

// ---------------------------------------------------------------------------
// Normal-path regression — existing remove APIs keep emitting their events.
// ---------------------------------------------------------------------------

(function testNormalRemovalStillEmits() {

    const roomManager = new RoomManager({
        logger,
        eventBus,
        roomConfig: { maxPlayers: 3 }
    });

    roomManager.initialize();

    const gameManager = new GameManager({ logger, eventBus });

    gameManager.initialize();

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

    let roomDestroyed = 0;

    let gameDestroyed = 0;

    let playerRemoved = 0;

    eventBus.subscribe(EVENT_TYPES.ROOM_DESTROYED, () => {

        roomDestroyed += 1;

    });

    eventBus.subscribe(EVENT_TYPES.GAME_DESTROYED, () => {

        gameDestroyed += 1;

    });

    eventBus.subscribe(EVENT_TYPES.PLAYER_REMOVED, () => {

        playerRemoved += 1;

    });

    const room = new Room({
        roomId: "normal-room",
        createdAt: 1000,
        status: ROOM_STATUS.WAITING_FOR_PLAYERS,
        maxPlayers: 3,
        players: []
    });

    roomManager.attachRoom(room);

    assert(
        roomManager.destroyRoom("normal-room") === true,
        "destroyRoom should still work normally"
    );

    assert(roomDestroyed === 1, "destroyRoom must still emit ROOM_DESTROYED");

    const game = new Game({
        gameId: "game_normal_destroy",
        roomId: "normal-room-2",
        createdAt: 1000,
        status: GAME_STATUS.CREATED,
        players: [],
        metadata: {}
    });

    gameManager.attachGame(game);

    assert(
        gameManager.destroyGame("game_normal_destroy") === true,
        "destroyGame should still work normally"
    );

    assert(gameDestroyed === 1, "destroyGame must still emit GAME_DESTROYED");

    const created = playerManager.createPlayer({ nickname: "Normal" });

    assert(
        playerManager.removePlayer(created.identity.playerId) === true,
        "removePlayer should still work normally"
    );

    assert(playerRemoved === 1, "removePlayer must still emit PLAYER_REMOVED");

    roomManager.shutdown();

    gameManager.shutdown();

    playerManager.shutdown();

})();

logger.info("R17.9T.6-D3 silent recovery detach tests passed");