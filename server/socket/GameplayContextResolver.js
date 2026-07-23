export class GameplayContextResolver {

    constructor({
        logger,
        playerManager,
        roomManager
    }) {

        this._logger = logger;

        this._playerManager = playerManager;

        this._roomManager = roomManager;

        this._socketBindings = new Map();

        this._roomGames = new Map();

    }

    bindSocket(socketId, { playerId, roomId }) {

        if (!socketId || !playerId || !roomId) {

            return;

        }

        for (const [boundSocketId, binding] of this._socketBindings.entries()) {

            if (binding.playerId === playerId && boundSocketId !== socketId) {

                this._socketBindings.delete(boundSocketId);

                this._logger?.info?.(
                    `Evicted duplicate gameplay binding | playerId=${playerId} | socketId=${boundSocketId}`
                );

            }

        }

        this._socketBindings.set(socketId, {
            playerId,
            roomId
        });

    }

    unbindSocket(socketId) {

        this._socketBindings.delete(socketId);

    }

    activateRoomGame(roomId, gameId) {

        if (!roomId || !gameId) {

            return;

        }

        this._roomGames.set(roomId, gameId);

    }

    deactivateRoomGame(roomId) {

        if (!roomId) {

            return;

        }

        this._roomGames.delete(roomId);

    }

    resolveRoomByGameId(gameId) {

        if (!gameId) {

            return null;

        }

        for (const [roomId, activeGameId] of this._roomGames.entries()) {

            if (activeGameId === gameId) {

                return roomId;

            }

        }

        return null;

    }

    resolveGameIdByRoomId(roomId) {

        if (!roomId) {

            return null;

        }

        return this._roomGames.get(roomId) ?? null;

    }

    resolve(socketId) {

        const binding = this._socketBindings.get(socketId);

        if (!binding) {

            return {
                ok: false,
                reason: "Socket is not bound to a player session"
            };

        }

        const { playerId, roomId } = binding;

        if (!this._playerManager.hasPlayer(playerId)) {

            return {
                ok: false,
                reason: "Player does not exist"
            };

        }

        const runtime = this._playerManager.getRuntime(playerId);

        if (!runtime?.roomId) {

            return {
                ok: false,
                reason: "Player is not assigned to a room"
            };

        }

        if (runtime.roomId !== roomId) {

            return {
                ok: false,
                reason: "Player does not belong to the bound room session"
            };

        }

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            return {
                ok: false,
                reason: "Room session is not active"
            };

        }

        if (!room.players.includes(playerId)) {

            return {
                ok: false,
                reason: "Player is not in the active room"
            };

        }

        const gameId = this._roomGames.get(roomId) ?? runtime.gameId ?? null;

        if (!gameId) {

            return {
                ok: false,
                reason: "No active gameplay session for this room"
            };

        }

        if (runtime.gameId && runtime.gameId !== gameId) {

            return {
                ok: false,
                reason: "Player does not belong to the active gameplay session"
            };

        }

        return {
            ok: true,
            playerId,
            roomId,
            gameId
        };

    }

}
