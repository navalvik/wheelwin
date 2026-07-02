import { ROOM_STATUS } from "./RoomStatus.js";

export class Room {

    constructor({
        roomId = null,
        createdAt = null,
        status = ROOM_STATUS.CREATED,
        maxPlayers = 3,
        players = []
    } = {}) {

        this.roomId = roomId;

        this.createdAt = createdAt;

        this.status = status;

        this.maxPlayers = maxPlayers;

        this.players = players;

    }

    toSnapshot() {

        return {
            roomId: this.roomId,
            createdAt: this.createdAt,
            status: this.status,
            maxPlayers: this.maxPlayers,
            players: [...this.players]
        };

    }

}
