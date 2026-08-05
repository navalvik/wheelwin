from pathlib import Path

path = Path("server/socket/RoomLobbyBridge.js")
text = path.read_text(encoding="utf-8")

old_runtime = """        const boundSocket = this._playerToSocket.get(claimedPlayerId);

        const connectionState = runtime?.connectionState ?? null;

        if (boundSocket && boundSocket !== socketId) {

            if (connectionState === CONNECTION_STATE.DISCONNECTED) {

                this._logger.info(
                    `[R6.2A Recovery] authorization`
                    + ` | check=runtime_seat_fallback`
                    + ` | result=pass`
                    + ` | action=clear_stale_binding`
                    + ` | boundSocket.id=${boundSocket}`
                    + ` | playerId=${claimedPlayerId}`
                    + ` | socket.id=${socketId}`
                );

                this._unregisterSocket(boundSocket);

            } else {

                this._logger.info(
                    `[R6.2A Recovery] authorization`
                    + ` | check=runtime_seat_fallback`
                    + ` | result=fail`
                    + ` | reason=player_bound_elsewhere`
                    + ` | boundSocket.id=${boundSocket}`
                    + ` | playerId=${claimedPlayerId}`
                    + ` | socket.id=${socketId}`
                );

                this._denyRecoveryIdentity(
                    "Recovery identity is not authorized for this socket",
                    {
                        playerId: claimedPlayerId,
                        socketId,
                        boundSocketId: boundSocket,
                        cause: "player_bound_elsewhere"
                    }
                );

                return null;

            }

        }

        const seatAvailable = connectionState === CONNECTION_STATE.DISCONNECTED
            || !boundSocket;

        if (!seatAvailable) {

            this._logger.info(
                `[R6.2A Recovery] authorization`
                + ` | check=runtime_seat_fallback`
                + ` | result=fail`
                + ` | reason=player_still_connected`
                + ` | connectionState=${connectionState ?? "null"}`
                + ` | playerId=${claimedPlayerId}`
                + ` | socket.id=${socketId}`
            );

            this._denyRecoveryIdentity(
                "Recovery identity is not authorized for this socket",
                {
                    playerId: claimedPlayerId,
                    socketId,
                    connectionState,
                    cause: "player_still_connected"
                }
            );

            return null;

        }

        if (!this._isRecoverableIdentity(claimedPlayerId, roomId)) {
"""

new_runtime = """        const boundSocket = this._playerToSocket.get(claimedPlayerId);

        const connectionState = runtime?.connectionState ?? null;

        if (boundSocket && boundSocket !== socketId) {

            // R7.5A — allow atomic transfer; do not unregister (avoids zero-owner gap).
            this._logger.info(
                `[R6.2A Recovery] authorization`
                + ` | check=runtime_seat_fallback`
                + ` | result=pass`
                + ` | action=transfer_allowed`
                + ` | boundSocket.id=${boundSocket}`
                + ` | connectionState=${connectionState ?? "null"}`
                + ` | playerId=${claimedPlayerId}`
                + ` | socket.id=${socketId}`
            );

            this._markPendingSocket(socketId, claimedPlayerId, roomId);

        }

        if (!this._isRecoverableIdentity(claimedPlayerId, roomId)) {
"""

if old_runtime not in text:
    raise SystemExit("runtime block not found")
text = text.replace(old_runtime, new_runtime, 1)

old_reg = """    _getSocketContext(socketId) {

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

    _registerSocketPlayer(socketId, playerId) {

        if (!socketId || !playerId) {

            return;

        }

        const existingSocketForPlayer = this._playerToSocket.get(playerId);

        if (existingSocketForPlayer && existingSocketForPlayer !== socketId) {

            this._unregisterSocket(existingSocketForPlayer);

        }

        const existingPlayerForSocket = this._socketToPlayer.get(socketId);

        if (existingPlayerForSocket && existingPlayerForSocket !== playerId) {

            this._unregisterSocket(socketId);

        }

        this._socketToPlayer.set(socketId, playerId);

        this._playerToSocket.set(playerId, socketId);

    }
"""

new_reg = Path("_audit_tmp/r75a_helpers.js").read_text(encoding="utf-8")

if old_reg not in text:
    raise SystemExit("register block not found")
text = text.replace(old_reg, new_reg, 1)

path.write_text(text, encoding="utf-8")
print("OK")
print("commit defs", text.count("    _commitSocketAuthority({"))
print("assert defs", text.count("    _assertAuthoritativeMutation("))
print("player_bound_elsewhere", text.count("player_bound_elsewhere"))
