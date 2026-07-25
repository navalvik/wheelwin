/**
 * R6.0C — Lightweight rooms index (no player objects).
 */
export function buildRoomsIndex({
    roomManager,
    gameManager,
    setupSessionLifecycle,
    gameplayContextResolver = null
}) {

    const rooms = roomManager?.getRooms?.() ?? [];
    const games = gameManager?.getGames?.() ?? [];

    const gameIdByRoom = new Map();

    for (const game of games) {

        if (game?.roomId && game?.gameId) {

            gameIdByRoom.set(game.roomId, game.gameId);

        }

    }

    const roomsDto = rooms.map((room) => {

        const setup = setupSessionLifecycle?.getSession?.(room.roomId) ?? null;

        let gameId = gameIdByRoom.get(room.roomId) ?? null;

        if (!gameId && gameplayContextResolver?.resolveGameIdByRoomId) {

            gameId = gameplayContextResolver.resolveGameIdByRoomId(room.roomId)
                ?? null;

        }

        return Object.freeze({
            roomId: room.roomId,
            state: room.status,
            playerCount: Array.isArray(room.players) ? room.players.length : 0,
            setupState: setup?.state ?? null,
            gameId,
            createdAt: room.createdAt
        });

    });

    return Object.freeze({
        count: roomsDto.length,
        rooms: Object.freeze(roomsDto)
    });

}
