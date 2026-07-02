export class Session {

    constructor({
        id = null,
        playerId = null,
        roomId = null,
        gameId = null,
        connectedAt = null,
        lastSeenAt = null
    } = {}) {

        this.id = id;

        this.playerId = playerId;

        this.roomId = roomId;

        this.gameId = gameId;

        this.connectedAt = connectedAt;

        this.lastSeenAt = lastSeenAt;

    }

}
