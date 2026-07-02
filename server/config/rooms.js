export function loadRoomConfig(env = process.env) {

    const maxPlayers = Number(env.ROOM_MAX_PLAYERS);

    if (!Number.isFinite(maxPlayers) || maxPlayers <= 0) {

        throw new Error("Invalid ROOM_MAX_PLAYERS environment variable");

    }

    return {
        maxPlayers
    };

}
