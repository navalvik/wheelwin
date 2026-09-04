import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { RoomManager } from "../managers/RoomManager.js";
import { ROOM_STATUS } from "../models/RoomStatus.js";
import {
    isValidRoomId,
    ROOM_ID_LENGTH
} from "../managers/room/roomIdAlphabet.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
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
    EVENT_TYPES.ROOM_CREATED,
    EVENT_TYPES.ROOM_FULL,
    EVENT_TYPES.ROOM_LOCKED,
    EVENT_TYPES.ROOM_DESTROYED
]) {

    eventBus.subscribe(type, (envelope) => {

        emitted.push(envelope.type);

    });

}

const roomManager = new RoomManager({
    logger,
    eventBus,
    roomConfig: { maxPlayers: 3 }
});

roomManager.initialize();

const setupSessionLifecycle = new SetupSessionLifecycle({
    logger,
    eventBus,
    roomManager,
    roomConfig: { setupDurationMs: 10 * 60 * 1000 }
});

setupSessionLifecycle.initialize();

roomManager.attachSetupSessionLifecycle(setupSessionLifecycle);

const room = roomManager.createRoom();

assert(room, "createRoom should return a room");

assert(
    room.roomId.length === ROOM_ID_LENGTH,
    "roomId should be exactly 4 characters"
);

assert(
    isValidRoomId(room.roomId),
    "roomId should use the public room alphabet"
);

assert(
    Number.isInteger(room.roomNumber)
        && room.roomNumber >= 1
        && room.roomNumber <= 64,
    "first room receives a valid Room Number 1..64"
);

assert(
    room.roomId !== String(room.roomNumber),
    "public roomId must remain distinct from Room Number"
);

assert(roomManager.hasRoom(room.roomId), "room should be registered");

assert(
    roomManager.getRoom(room.roomId).status === ROOM_STATUS.WAITING_FOR_PLAYERS,
    "room should move to WAITING_FOR_PLAYERS after creation"
);

assert(
    setupSessionLifecycle.isActive(room.roomId),
    "createRoom must atomically create an active Setup Session"
);

roomManager.addPlayer(room.roomId, "player-1");

roomManager.addPlayer(room.roomId, "player-2");

roomManager.addPlayer(room.roomId, "player-3");

assert(
    roomManager.getRoom(room.roomId).status === ROOM_STATUS.FULL,
    "room should become FULL at capacity"
);

assert(
    !setupSessionLifecycle.isActive(room.roomId),
    "Setup Session completes and is destroyed when room is full"
);

roomManager.lockRoom(room.roomId);

assert(
    !roomManager.addPlayer(room.roomId, "player-4"),
    "locked room should reject new players"
);

assert(
    !roomManager.removePlayer(room.roomId, "player-1"),
    "locked room should reject player removal"
);

roomManager.destroyRoom(room.roomId);

assert(!roomManager.hasRoom(room.roomId), "destroyed room should be removed");

assert(
    emitted.join(",") === [
        EVENT_TYPES.ROOM_CREATED,
        EVENT_TYPES.ROOM_FULL,
        EVENT_TYPES.ROOM_LOCKED,
        EVENT_TYPES.ROOM_DESTROYED
    ].join(","),
    "lifecycle should emit events in order"
);

assert(
    !roomManager.addPlayer("missing-room", "player-1"),
    "missing room should fail gracefully"
);

setupSessionLifecycle.shutdown();

roomManager.shutdown();

logger.info("RoomManager tests passed");
