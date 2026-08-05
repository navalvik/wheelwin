    _getSocketContext(socketId) {

        const playerId = this._socketToPlayer.get(socketId);

        if (!playerId) {

            return null;

        }

        const runtime = this._playerManager.getRuntime(playerId);

        if (!runtime?.roomId) {

            return null;

        }

        return {
            socketId,
            playerId,
            roomId: runtime.roomId
        };

    }

    /**
     * R7.5A — Gate mutating lobby commands to the single authoritative socket.
     * @returns {object|null} socket context when allowed; null when rejected.
     */
    _assertAuthoritativeMutation(socketId, eventName) {

        if (this._obsoleteSockets.has(socketId)) {

            const meta = this._obsoleteSockets.get(socketId);

            this._logger.info(
                `SOCKET_OBSOLETE_PACKET`
                + ` | socketId=${socketId}`
                + ` | playerId=${meta?.playerId ?? "null"}`
                + ` | roomId=${meta?.roomId ?? "null"}`
                + ` | event=${eventName}`
                + ` | reason=obsolete_socket`
            );

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.UNKNOWN_ERROR);

            return null;

        }

        if (this._pendingSockets.has(socketId)) {

            const meta = this._pendingSockets.get(socketId);

            this._logger.info(
                `SOCKET_PENDING_PACKET`
                + ` | socketId=${socketId}`
                + ` | playerId=${meta?.playerId ?? "null"}`
                + ` | roomId=${meta?.roomId ?? "null"}`
                + ` | event=${eventName}`
                + ` | reason=pending_not_authoritative`
            );

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.UNKNOWN_ERROR);

            return null;

        }

        const context = this._getSocketContext(socketId);

        if (!context) {

            this._emitRoomError(socketId, LOBBY_ERROR_CODES.UNKNOWN_ERROR);

            return null;

        }

        return context;

    }

    _markPendingSocket(socketId, playerId, roomId) {

        if (!socketId) {

            return;

        }

        this._pendingSockets.set(socketId, {
            playerId: playerId ?? null,
            roomId: roomId ?? null
        });

        this._obsoleteSockets.delete(socketId);

    }

    _clearPendingSocket(socketId) {

        if (!socketId) {

            return;

        }

        this._pendingSockets.delete(socketId);

    }

    /**
     * R7.5A — Atomic authoritative socket ownership transfer.
     * Synchronous only: no await, emit side-effects beyond map ops before return
     * except force-disconnect delivery after maps are committed.
     */
    _commitSocketAuthority({
        playerId,
        roomId,
        oldSocketId = null,
        newSocketId
    }) {

        this._logger.info(
            `SOCKET_COMMIT_BEGIN`
            + ` | roomId=${roomId ?? "null"}`
            + ` | playerId=${playerId ?? "null"}`
            + ` | oldSocketId=${oldSocketId ?? "null"}`
            + ` | newSocketId=${newSocketId ?? "null"}`
        );

        if (!playerId || !newSocketId) {

            this._logger.info(
                `SOCKET_COMMIT_VALIDATE`
                + ` | success=false`
                + ` | reason=missing_player_or_socket`
            );

            this._logger.info(
                `SOCKET_COMMIT_ROLLBACK`
                + ` | reason=missing_player_or_socket`
                + ` | currentOwner=${this._playerToSocket.get(playerId) ?? "null"}`
            );

            return {
                ok: false,
                reason: "Socket ownership commit requires playerId and newSocketId"
            };

        }

        if (!this._playerManager.hasPlayer(playerId)) {

            this._logger.info(
                `SOCKET_COMMIT_VALIDATE`
                + ` | success=false`
                + ` | reason=player_missing`
            );

            this._logger.info(
                `SOCKET_COMMIT_ROLLBACK`
                + ` | reason=player_missing`
                + ` | currentOwner=${this._playerToSocket.get(playerId) ?? "null"}`
            );

            return { ok: false, reason: "Player does not exist" };

        }

        if (roomId && !this._roomManager.getRoom(roomId)) {

            this._logger.info(
                `SOCKET_COMMIT_VALIDATE`
                + ` | success=false`
                + ` | reason=room_missing`
            );

            this._logger.info(
                `SOCKET_COMMIT_ROLLBACK`
                + ` | reason=room_missing`
                + ` | currentOwner=${this._playerToSocket.get(playerId) ?? "null"}`
            );

            return { ok: false, reason: "Room session is not active" };

        }

        this._logger.info(
            `SOCKET_COMMIT_VALIDATE`
            + ` | success=true`
            + ` | reason=ok`
        );

        const previousOwner = this._playerToSocket.get(playerId) ?? null;

        const resolvedOld = oldSocketId
            ?? (
                previousOwner && previousOwner !== newSocketId
                    ? previousOwner
                    : null
            );

        // Retire old socket mapping without clearing player ownership first.
        if (resolvedOld && resolvedOld !== newSocketId) {

            if (this._socketToPlayer.get(resolvedOld) === playerId) {

                this._socketToPlayer.delete(resolvedOld);

            }

            this._gameplayContextResolver?.unbindSocket(resolvedOld);

            this._deliverSocketLeaveRoom(resolvedOld);

            this._obsoleteSockets.set(resolvedOld, {
                playerId,
                roomId: roomId ?? null
            });

            this._pendingSockets.delete(resolvedOld);

        }

        const existingPlayerForSocket = this._socketToPlayer.get(newSocketId);

        if (existingPlayerForSocket && existingPlayerForSocket !== playerId) {

            this._socketToPlayer.delete(newSocketId);

            if (this._playerToSocket.get(existingPlayerForSocket) === newSocketId) {

                this._playerToSocket.delete(existingPlayerForSocket);

            }

            this._gameplayContextResolver?.unbindSocket(newSocketId);

        }

        this._socketToPlayer.set(newSocketId, playerId);

        this._playerToSocket.set(playerId, newSocketId);

        this._pendingSockets.delete(newSocketId);

        this._obsoleteSockets.delete(newSocketId);

        this._clearRecoveryOwnershipForPlayer(playerId);

        this._logger.info(
            `SOCKET_COMMIT_SUCCESS`
            + ` | roomId=${roomId ?? "null"}`
            + ` | playerId=${playerId}`
            + ` | oldSocketId=${resolvedOld ?? "null"}`
            + ` | newSocketId=${newSocketId}`
        );

        return {
            ok: true,
            oldSocketId: resolvedOld,
            newSocketId
        };

    }

    _requestForceDisconnect(socketId) {

        if (!socketId) {

            return;

        }

        this._eventBus.emit({
            source: EVENT_SOURCES.ROOM_LOBBY_BRIDGE,
            type: EVENT_TYPES.LOBBY_SOCKET_DELIVERY,
            payload: {
                target: "disconnect",
                socketId
            }
        });

    }

    /**
     * Initial bind (create/join) or transfer via commit when replacing.
     * Must never leave a recoverable player with zero owners mid-call.
     */
    _registerSocketPlayer(socketId, playerId) {

        if (!socketId || !playerId) {

            return;

        }

        const existingSocketForPlayer = this._playerToSocket.get(playerId);

        if (existingSocketForPlayer && existingSocketForPlayer !== socketId) {

            const roomId = this._playerManager.getRuntime(playerId)?.roomId
                ?? null;

            this._commitSocketAuthority({
                playerId,
                roomId,
                oldSocketId: existingSocketForPlayer,
                newSocketId: socketId
            });

            return;

        }

        const existingPlayerForSocket = this._socketToPlayer.get(socketId);

        if (existingPlayerForSocket && existingPlayerForSocket !== playerId) {

            if (this._playerToSocket.get(existingPlayerForSocket) === socketId) {

                this._playerToSocket.delete(existingPlayerForSocket);

            }

            this._socketToPlayer.delete(socketId);

            this._gameplayContextResolver?.unbindSocket(socketId);

        }

        this._socketToPlayer.set(socketId, playerId);

        this._playerToSocket.set(playerId, socketId);

    }
