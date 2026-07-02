import { GAME_STATUS } from "./GameStatus.js";

export class Game {

    constructor({
        gameId = null,
        roomId = null,
        createdAt = null,
        status = GAME_STATUS.CREATED,
        players = [],
        metadata = {}
    } = {}) {

        this.gameId = gameId;

        this.roomId = roomId;

        this.createdAt = createdAt;

        this.status = status;

        this.players = players;

        this.metadata = metadata;

    }

    toSnapshot() {

        return {
            gameId: this.gameId,
            roomId: this.roomId,
            createdAt: this.createdAt,
            status: this.status,
            players: [...this.players],
            metadata: { ...this.metadata }
        };

    }

}
