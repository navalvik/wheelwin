import { CONNECTION_STATE } from "../../models/ConnectionState.js";
import { inferConsolePage } from "./inferConsolePage.js";

/**
 * R6.0C — Lightweight players index (no wallet addresses).
 */
export function buildPlayersIndex({
    playerManager,
    roomManager,
    gameManager,
    setupSessionLifecycle,
    paymentSessionManager,
    gameStartAuthorization,
    gameStateEngine,
    resultSessionLifecycle
}) {

    const list = playerManager?.getDebugSnapshot?.()?.players ?? [];
    const roomsById = new Map(
        (roomManager?.getRooms?.() ?? []).map((room) => [room.roomId, room])
    );
    const gamesById = new Map(
        (gameManager?.getGames?.() ?? []).map((game) => [game.gameId, game])
    );

    const players = list.map((entry) => {

        const identity = playerManager?.getIdentity?.(entry.playerId);
        const room = entry.roomId ? roomsById.get(entry.roomId) : null;
        const game = entry.gameId ? gamesById.get(entry.gameId) : null;
        const setupSession = entry.roomId
            ? setupSessionLifecycle?.getSession?.(entry.roomId)
            : null;
        const paymentSession = entry.roomId
            ? paymentSessionManager?.getSession?.(entry.roomId)
            : null;
        const gameStart = entry.roomId
            ? gameStartAuthorization?.getReconnectSnapshot?.(entry.roomId)
            : null;
        const resultSession = entry.roomId
            ? resultSessionLifecycle?.getSession?.(entry.roomId)
            : null;
        const gameState = entry.gameId
            ? gameStateEngine?.getState?.(entry.gameId)
            : null;

        return Object.freeze({
            playerId: entry.playerId,
            nickname: entry.nickname ?? null,
            online: entry.connectionState === CONNECTION_STATE.CONNECTED,
            connectionState: entry.connectionState ?? null,
            roomId: entry.roomId ?? null,
            gameId: entry.gameId ?? null,
            walletConnected: Boolean(identity?.wallet),
            currentPage: inferConsolePage({
                room,
                setupSession,
                paymentSession,
                gameStart,
                gameState,
                resultSession,
                gameStatus: game?.status ?? null
            })
        });

    });

    return Object.freeze({
        count: players.length,
        players: Object.freeze(players)
    });

}
