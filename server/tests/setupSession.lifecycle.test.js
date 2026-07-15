import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { RoomManager } from "../managers/RoomManager.js";
import { GameManager } from "../managers/GameManager.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { LoggerService } from "../services/LoggerService.js";
import {
    shutdownGameplayBootstrap,
    wireGameplayBootstrap
} from "./helpers/gameplayBootstrapHarness.js";

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
    setupDurationMs: 80
});

const lifecycle = harness.setupSessionLifecycle;

{
    const started = [];

    const completed = [];

    eventBus.subscribe(EVENT_TYPES.SETUP_SESSION_STARTED, (envelope) => {

        started.push(envelope.payload);

    });

    eventBus.subscribe(EVENT_TYPES.SETUP_SESSION_COMPLETED, (envelope) => {

        completed.push(envelope.payload);

    });

    const room = roomManager.createRoom();

    assert(room, "room must be created");

    assert(lifecycle.isActive(room.roomId), "Setup Session must be ACTIVE");

    assert(started.length === 1, "SETUP_SESSION_STARTED must emit once");

    assert(
        started[0].startedAt === started[0].expiresAt - 80,
        "expiresAt must equal startedAt + duration"
    );

    const playerIds = ["p1", "p2", "p3"];

    for (const playerId of playerIds) {

        playerManager.createPlayer({ playerId });

        roomManager.addPlayer(room.roomId, playerId);

    }

    assert(completed.length === 1, "ROOM_FULL must complete Setup Session");

    assert(
        !lifecycle.isActive(room.roomId),
        "Setup Session destroyed after COMPLETED"
    );

    assert(
        gameManager.getGames().length === 1,
        "GameManager bootstraps only from SETUP_SESSION_COMPLETED"
    );

    console.log("  atomic create + completion bootstrap passed");
}

{
    const expired = [];

    eventBus.subscribe(EVENT_TYPES.SETUP_SESSION_EXPIRED, (envelope) => {

        expired.push(envelope.payload);

    });

    const room = roomManager.createRoom();

    const roomId = room.roomId;

    const startedAt = lifecycle.getSession(roomId).startedAt;

    const expiresAt = lifecycle.getSession(roomId).expiresAt;

    assert(lifecycle.isActive(roomId), "timeout room starts ACTIVE");

    await wait(120);

    assert(expired.length >= 1, "SETUP_SESSION_EXPIRED must emit");

    assert(
        expired.some((payload) => payload.roomId === roomId),
        "EXPIRED payload must reference the room"
    );

    assert(!roomManager.hasRoom(roomId), "expired room must be destroyed");

    assert(!lifecycle.isActive(roomId), "expired Setup Session removed");

    assert(
        gameManager.getGames().every((game) => game.roomId !== roomId),
        "timeout must never create a Game Session for the expired room"
    );

    assert(
        expiresAt === startedAt + 80,
        "reconnect path never mutates expiresAt (immutability of timer)"
    );

    console.log("  timeout destroys room without GAME_CREATED passed");
}

{
    const room = roomManager.createRoom();

    const before = lifecycle.buildSyncPayload(room.roomId);

    assert(before, "SYNC payload available while ACTIVE");

    const startedAt = before.startedAt;

    const expiresAt = before.expiresAt;

    const syncAgain = lifecycle.buildSyncPayload(room.roomId);

    assert(
        syncAgain.setupSessionId === before.setupSessionId,
        "SYNC must not recreate Setup Session"
    );

    assert(
        syncAgain.startedAt === startedAt
            && syncAgain.expiresAt === expiresAt,
        "SYNC must not restart Start/expires timer"
    );

    roomManager.destroyRoom(room.roomId);

    assert(
        lifecycle.buildSyncPayload(room.roomId) === null,
        "destroyed room has no Setup Session"
    );

    console.log("  SYNC preserves timer identity passed");
}

shutdownGameplayBootstrap(harness);

gameManager.shutdown();

playerManager.shutdown();

roomManager.shutdown();

eventBus.shutdown();

console.log("setupSession.lifecycle.test.js: all assertions passed");
