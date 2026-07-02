import { CONNECTION_STATE } from "./ConnectionState.js";
import { PLAYER_STATE } from "./PlayerState.js";

export class PlayerRuntime {

    constructor({
        connectionState = CONNECTION_STATE.DISCONNECTED,
        playerState = PLAYER_STATE.IDLE,
        roomId = null,
        gameId = null,
        pressCount = 0,
        ping = null,
        connectedAt = null,
        lastSeen = null
    } = {}) {

        this.connectionState = connectionState;

        this.playerState = playerState;

        this.roomId = roomId;

        this.gameId = gameId;

        this.pressCount = pressCount;

        this.ping = ping;

        this.connectedAt = connectedAt;

        this.lastSeen = lastSeen;

    }

    toSnapshot() {

        return {
            connectionState: this.connectionState,
            playerState: this.playerState,
            roomId: this.roomId,
            gameId: this.gameId,
            pressCount: this.pressCount,
            ping: this.ping,
            connectedAt: this.connectedAt,
            lastSeen: this.lastSeen
        };

    }

}
