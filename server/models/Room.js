import { ROOM_STATUS } from "./RoomStatus.js";

export class Room {

    constructor({
        roomId = null,
        roomNumber = null,
        createdAt = null,
        status = ROOM_STATUS.CREATED,
        maxPlayers = 3,
        players = [],
        gameMode = "FRIENDS"
    } = {}) {

        this.roomId = roomId;

        this.roomNumber = Number.isInteger(Number(roomNumber)) && Number(roomNumber) >= 1
            ? Number(roomNumber)
            : null;

        this.createdAt = createdAt;

        this.status = status;

        this.maxPlayers = maxPlayers;

        this.players = players;

        this.gameMode = gameMode === "NO_FRIENDS" ? "NO_FRIENDS" : "FRIENDS";

    }

    toSnapshot() {

        return {
            roomId: this.roomId,
            roomNumber: this.roomNumber,
            createdAt: this.createdAt,
            status: this.status,
            maxPlayers: this.maxPlayers,
            players: [...this.players],
            gameMode: this.gameMode
        };

    }

}
