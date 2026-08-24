import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { consumeRoomDestroyContext, registerRoomDestroyContext } from "../diagnostics/RoomDestroyForensics.js";
import { Room } from "../models/Room.js";
import { ROOM_STATUS } from "../models/RoomStatus.js";
import { generateRoomId } from "./room/roomIdAlphabet.js";

export class RoomManager {

    constructor({ logger, eventBus, roomConfig }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._roomConfig = roomConfig;

        this._rooms = new Map();

        this._playerRoomIndex = new Map();

        this._roomListeners = new Map();

        this._infrastructureHandlers = [];

        this._setupSessionLifecycle = null;

        /** @type {{ isAcceptingNewWork: () => boolean } | null} R7.0B */
        this._lifecycleGate = null;

        this._initialized = false;

    }

    /**
     * C5.6C — Attach Setup Session lifecycle so createRoom is atomic with
     * Setup Session creation. Must be called before any createRoom().
     */
    attachSetupSessionLifecycle(setupSessionLifecycle) {

        this._setupSessionLifecycle = setupSessionLifecycle;

    }

    /**
     * R7.0B — Drain gate: reject createRoom while not RUNNING.
     */
    attachLifecycleGate(lifecycleGate) {

        this._lifecycleGate = lifecycleGate;

    }

    initialize() {

        const shutdownHandler = () => {

            this._handleServerShutdown();

        };

        this._eventBus.subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            shutdownHandler
        );

        this._infrastructureHandlers.push({
            event: EVENT_TYPES.SERVER_SHUTDOWN,
            handler: shutdownHandler
        });

        this._initialized = true;

    }

    shutdown() {

        for (const roomId of [...this._rooms.keys()]) {

            registerRoomDestroyContext(roomId, {
                reason: "server_shutdown",
                caller: "RoomManager.shutdown",
                triggerEvent: EVENT_TYPES.SERVER_SHUTDOWN
            });

            this.destroyRoom(roomId);

        }

        for (const subscription of this._infrastructureHandlers) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._infrastructureHandlers = [];

        this._initialized = false;

    }

    createRoom({ maxPlayers } = {}) {

        if (this._lifecycleGate
            && this._lifecycleGate.isAcceptingNewWork() !== true) {

            this._logger.warn(
                "Room creation rejected: server is not accepting new work (drain)"
            );

            return null;

        }

        if (this.isAtCapacity()) {

            this._logger.error(
                "Room creation failed: concurrent room limit reached"
            );

            return null;

        }

        const roomId = this._generateRoomId();

        if (!roomId) {

            this._logger.error(
                "Room creation failed: could not allocate unique roomId"
            );

            return null;

        }

        const resolvedMaxPlayers = maxPlayers ?? this._roomConfig.maxPlayers;

        if (!Number.isFinite(resolvedMaxPlayers) || resolvedMaxPlayers <= 0) {

            this._logger.error("Room creation failed: invalid maxPlayers");

            return null;

        }

        if (!this._setupSessionLifecycle) {

            this._logger.error(
                "Room creation failed: Setup Session lifecycle is not attached"
            );

            return null;

        }

        const room = new Room({
            roomId,
            createdAt: Date.now(),
            status: ROOM_STATUS.CREATED,
            maxPlayers: resolvedMaxPlayers,
            players: []
        });

        this._rooms.set(roomId, room);

        const setupSession = this._setupSessionLifecycle.createForRoom(room);

        if (!setupSession) {

            this._rooms.delete(roomId);

            this._logger.error(
                `Room creation failed: Setup Session was not created (${roomId})`
            );

            return null;

        }

        this._logger.info(`Room Created: ${roomId}`);

        this._emit(EVENT_TYPES.ROOM_CREATED, {
            roomId: room.roomId,
            status: room.status,
            maxPlayers: room.maxPlayers,
            playerCount: room.players.length
        });

        room.status = ROOM_STATUS.WAITING_FOR_PLAYERS;

        return room;

    }

    addPlayer(roomId, playerId) {

        const room = this._getRoomOrLog(roomId, "add player to");

        if (!room) {

            return false;

        }

        if (room.status === ROOM_STATUS.LOCKED) {

            this._logger.error(
                `Add player failed: room is locked (${roomId})`
            );

            return false;

        }

        if (room.status === ROOM_STATUS.DESTROYED) {

            this._logger.error(
                `Add player failed: room is destroyed (${roomId})`
            );

            return false;

        }

        if (!playerId) {

            this._logger.error("Add player failed: playerId is required");

            return false;

        }

        if (room.players.includes(playerId)) {

            this._logger.error(
                `Add player failed: duplicate player in room (${playerId})`
            );

            return false;

        }

        if (this._playerRoomIndex.has(playerId)) {

            this._logger.error(
                `Add player failed: player already assigned to a room (${playerId})`
            );

            return false;

        }

        if (room.players.length >= room.maxPlayers) {

            this._logger.error(
                `Add player failed: room is at capacity (${roomId})`
            );

            return false;

        }

        room.players.push(playerId);

        this._playerRoomIndex.set(playerId, roomId);

        if (room.players.length === room.maxPlayers) {

            room.status = ROOM_STATUS.FULL;

            this._logger.info(`Room Full: ${roomId}`);

            this._emit(EVENT_TYPES.ROOM_FULL, {
                roomId: room.roomId,
                status: room.status,
                maxPlayers: room.maxPlayers,
                playerCount: room.players.length
            });

        }

        return true;

    }

    removePlayer(roomId, playerId, options = {}) {

        const allowLocked = options?.allowLocked === true;

        const room = this._getRoomOrLog(roomId, "remove player from");

        if (!room) {

            return false;

        }

        if (room.status === ROOM_STATUS.LOCKED && !allowLocked) {

            this._logger.error(
                `Remove player failed: room is locked (${roomId})`
            );

            return false;

        }

        if (!playerId) {

            this._logger.error("Remove player failed: playerId is required");

            return false;

        }

        const playerIndex = room.players.indexOf(playerId);

        if (playerIndex === -1) {

            this._logger.error(
                `Remove player failed: player not in room (${playerId})`
            );

            return false;

        }

        room.players.splice(playerIndex, 1);

        this._playerRoomIndex.delete(playerId);

        if (room.status === ROOM_STATUS.FULL) {

            room.status = ROOM_STATUS.WAITING_FOR_PLAYERS;

        }

        return true;

    }

    lockRoom(roomId) {

        const room = this._getRoomOrLog(roomId, "lock");

        if (!room) {

            return false;

        }

        if (room.status === ROOM_STATUS.LOCKED) {

            this._logger.error(`Room lock failed: already locked (${roomId})`);

            return false;

        }

        if (room.status === ROOM_STATUS.DESTROYED) {

            this._logger.error(
                `Room lock failed: room is destroyed (${roomId})`
            );

            return false;

        }

        room.status = ROOM_STATUS.LOCKED;

        this._logger.info(`Room Locked: ${roomId}`);

        this._emit(EVENT_TYPES.ROOM_LOCKED, {
            roomId: room.roomId,
            status: room.status,
            maxPlayers: room.maxPlayers,
            playerCount: room.players.length
        });

        return true;

    }

    unlockRoom(roomId) {

        const room = this._getRoomOrLog(roomId, "unlock");

        if (!room) {

            return false;

        }

        if (room.status !== ROOM_STATUS.LOCKED) {

            this._logger.error(
                `Room unlock failed: room is not locked (${roomId})`
            );

            return false;

        }

        room.status = room.players.length === room.maxPlayers
            ? ROOM_STATUS.FULL
            : ROOM_STATUS.WAITING_FOR_PLAYERS;

        this._emit(EVENT_TYPES.ROOM_UNLOCKED, {
            roomId: room.roomId,
            status: room.status,
            maxPlayers: room.maxPlayers,
            playerCount: room.players.length
        });

        return true;

    }

    destroyRoom(roomId) {

        const room = this._getRoomOrLog(roomId, "destroy");

        if (!room) {

            return false;

        }

        if (room.status === ROOM_STATUS.DESTROYED) {

            this._logger.error(
                `Room destroy failed: already destroyed (${roomId})`
            );

            return false;

        }

        const forensics = consumeRoomDestroyContext(roomId) ?? {};

        const stack = new Error("RoomManager.destroyRoom stack capture").stack
            ?? null;

        console.log("======================================================");
        console.log("ROOM DESTROY CALLED");
        console.log("======================================================");
        console.log("Timestamp:", new Date().toISOString());
        console.log("RoomId:", roomId);
        console.log("GameId:", forensics.gameId ?? "unknown");
        console.log("Reason:", forensics.reason ?? "unspecified");
        console.log("TriggerEvent:", forensics.triggerEvent ?? "unknown");
        console.log("Caller:", forensics.caller ?? "unknown");
        console.log("CurrentGameStage:", forensics.currentGameStage ?? "unknown");
        console.log("SetupSession:", forensics.setupSession ?? "unknown");
        console.log("WalletConnectionSession:", forensics.walletConnectionSession ?? "unknown");
        console.log("PaymentSession:", forensics.paymentSession ?? "unknown");
        console.log("PlayerCount:", room.players.length);
        console.log("SocketCount:", forensics.socketCount ?? "unknown");
        console.log("Stack:", stack);
        console.trace("RoomManager.destroyRoom");
        console.log("======================================================");

        this._logger.info(
            `ROOM_DESTROY_FORENSICS | roomId=${roomId} | reason=${forensics.reason ?? "unspecified"} | `
                + `caller=${forensics.caller ?? "unknown"} | trigger=${forensics.triggerEvent ?? "unknown"} | `
                + `players=${room.players.length}`
        );

        this._logger.decisionTrace({
            stage: "ROOM_DESTROY",
            decision: "DESTROY",
            reason: forensics.reason ?? "unspecified",
            caller: forensics.caller ?? "RoomManager.destroyRoom",
            nextAction: "Cleanup",
            roomId,
            gameId: forensics.gameId ?? null
        });

        room.status = ROOM_STATUS.DESTROYED;

        this._logger.info(`Room Destroyed: ${roomId}`);

        // Abort any residual Setup Session before ROOM_DESTROYED listeners run.
        this._setupSessionLifecycle?.abortForRoom(roomId);

        this._emit(EVENT_TYPES.ROOM_DESTROYED, {
            roomId: room.roomId,
            status: room.status,
            maxPlayers: room.maxPlayers,
            playerCount: room.players.length
        });

        for (const playerId of room.players) {

            this._playerRoomIndex.delete(playerId);

        }

        room.players = [];

        this._clearRoomListeners(roomId);

        this._rooms.delete(roomId);

        return true;

    }

    getRoom(roomId) {

        const room = this._rooms.get(roomId);

        if (!room) {

            return null;

        }

        return room.toSnapshot();

    }

    getRooms() {

        return [...this._rooms.values()].map((room) => room.toSnapshot());

    }

    hasRoom(roomId) {

        return this._rooms.has(roomId);

    }

    /**
     * R17.9T.6-D1 — Recovery identity attach layer.
     *
     * Registers a pre-constructed Room object with an existing roomId into
     * the manager's in-memory _rooms Map. Does NOT generate a new roomId,
     * does NOT call createRoom(), and does NOT alter any room fields.
     *
     * The supplied room's existing roomId is authoritative for this operation.
     *
     * @param {Room} room - Pre-constructed Room with an existing roomId.
     * @returns {Room|null} The attached Room, or null on validation/duplicate failure.
     */
    attachRoom(room) {

        if (!room) {

            this._logger.error("Room attach failed: room is required");

            return null;

        }

        if (!room.roomId) {

            this._logger.error("Room attach failed: roomId is required");

            return null;

        }

        if (this._rooms.has(room.roomId)) {

            this._logger.error(
                `Room attach failed: roomId already exists (${room.roomId})`
            );

            return null;

        }

        this._rooms.set(room.roomId, room);

        for (const playerId of room.players) {

            this._playerRoomIndex.set(playerId, room.roomId);

        }

        this._logger.info(`Room Attached: ${room.roomId}`);

        return room;

    }

    /**
     * R17.9T.6-D3 — Silent recovery rollback detach.
     *
     * Removes exactly one room from the manager's runtime registries WITHOUT
     * emitting ROOM_DESTROYED, without forensics, without Setup Session
     * lifecycle abort, without status mutation, and without touching any
     * other subsystem. Intended exclusively for RecoveryOrchestrator
     * rollback of a partially reconstructed candidate.
     *
     * Cleans only _playerRoomIndex entries that point to THIS room; mappings
     * belonging to other rooms are never removed.
     *
     * @param {string} roomId
     * @returns {boolean} true when the room was detached; false when absent.
     */
    detachRoom(roomId) {

        const room = this._rooms.get(roomId);

        if (!room) {

            return false;

        }

        this._rooms.delete(roomId);

        for (const playerId of room.players) {

            if (this._playerRoomIndex.get(playerId) === roomId) {

                this._playerRoomIndex.delete(playerId);

            }

        }

        // Remove this room's own event subscriptions without triggering any
        // listener callbacks (unsubscribe only — no events are emitted).
        this._clearRoomListeners(roomId);

        return true;

    }

    getActiveRoomCount() {

        return this._rooms.size;

    }

    /**
     * R17.9T.8 — configured global concurrent-room maximum (read-only view of
     * roomConfig for monitoring/observability; no behavior change).
     */
    getMaxConcurrentRooms() {

        return this._resolveMaxConcurrentRooms();

    }

    isAtCapacity() {

        return this.getActiveRoomCount() >= this._resolveMaxConcurrentRooms();

    }

    getDebugSnapshot() {

        return {
            activeRooms: this.getRooms().map((room) => ({
                roomId: room.roomId,
                status: room.status,
                playerCount: room.players.length,
                createdAt: room.createdAt
            }))
        };

    }

    _handleServerShutdown() {

        for (const roomId of [...this._rooms.keys()]) {

            registerRoomDestroyContext(roomId, {
                reason: "server_shutdown",
                caller: "RoomManager.shutdown",
                triggerEvent: EVENT_TYPES.SERVER_SHUTDOWN
            });

            this.destroyRoom(roomId);

        }

    }

    _getRoomOrLog(roomId, operation) {

        if (!roomId) {

            this._logger.error(`Room ${operation} failed: roomId is required`);

            return null;

        }

        const room = this._rooms.get(roomId);

        if (!room) {

            this._logger.error(
                `Room ${operation} failed: room not found (${roomId})`
            );

            return null;

        }

        return room;

    }

    _generateRoomId() {

        const maxAttempts = 1000;

        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {

            const candidate = generateRoomId();

            if (!this._rooms.has(candidate)) {

                return candidate;

            }

        }

        return null;

    }

    _emit(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.ROOM_MANAGER,
            type,
            payload
        });

    }

    _clearRoomListeners(roomId) {

        const subscriptions = this._roomListeners.get(roomId);

        if (!subscriptions) {

            return;

        }

        for (const subscription of subscriptions) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._roomListeners.delete(roomId);

    }

    _resolveMaxConcurrentRooms() {

        const configured = this._roomConfig?.maxConcurrentRooms;

        if (Number.isFinite(configured) && configured > 0) {

            return configured;

        }

        return 64;

    }

}
