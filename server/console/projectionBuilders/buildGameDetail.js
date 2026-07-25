import { inferConsolePage } from "./inferConsolePage.js";

/**
 * R6.0C — Game detail DTO (no wheel positions).
 */
export function buildGameDetail(gameId, {
    gameManager,
    roomManager,
    gameStateEngine,
    winnerEngine,
    physicsEngine,
    simulationLoop,
    paymentSessionManager,
    gameContractManager,
    contractSettlementManager,
    gameStartAuthorization,
    resultSessionLifecycle,
    gameplayContextResolver = null
}) {

    const game = gameManager?.getGame?.(gameId);

    if (!game) {

        return null;

    }

    const roomId = game.roomId
        ?? gameplayContextResolver?.resolveRoomByGameId?.(gameId)
        ?? null;

    const room = roomId ? roomManager?.getRoom?.(roomId) : null;
    const gameStateRecord = gameStateEngine?.getDebugSnapshot?.(gameId) ?? null;
    const currentState = gameStateRecord?.currentState
        ?? gameStateEngine?.getState?.(gameId)
        ?? null;
    const winner = winnerEngine?.getDebugSnapshot?.(gameId) ?? null;
    const physics = physicsEngine?.getSimulation?.(gameId) ?? null;
    const paymentSession = roomId
        ? paymentSessionManager?.getSession?.(roomId)
        : paymentSessionManager?.getSessionByGameId?.(gameId);
    const contract = roomId
        ? gameContractManager?.getContract?.(roomId)
        : gameContractManager?.getContractByGameId?.(gameId);
    const settlement = contractSettlementManager
        ?.getReconnectSnapshot?.(gameId) ?? null;
    const gameStart = roomId
        ? gameStartAuthorization?.getReconnectSnapshot?.(roomId)
        : null;
    const resultSession = roomId
        ? resultSessionLifecycle?.getSession?.(roomId)
        : null;

    const simulationRunning = simulationLoop?.isRunning?.() === true
        && (simulationLoop?.getActiveGameCount?.() ?? 0) > 0
        && physics != null;

    const currentPage = inferConsolePage({
        room,
        paymentSession,
        gameStart,
        gameState: currentState,
        resultSession,
        gameStatus: game.status
    });

    return Object.freeze({
        game: Object.freeze({
            gameId: game.gameId,
            roomId: game.roomId,
            status: game.status,
            createdAt: game.createdAt,
            playerCount: Array.isArray(game.players) ? game.players.length : 0
        }),
        currentGameState: currentState,
        gameStateHistoryCount: Array.isArray(gameStateRecord?.history)
            ? gameStateRecord.history.length
            : 0,
        winner: winner
            ? Object.freeze({
                winningSector: winner.winningSector ?? null,
                winnerPlayerId: winner.winningPlayer?.playerId
                    ?? winner.winnerPlayerId
                    ?? null,
                resolvedAt: winner.resolvedAt ?? null
                // finalAngle omitted — no wheel positions in this stage
            })
            : null,
        currentPage,
        simulation: Object.freeze({
            status: physics?.runtime?.state ?? null,
            activeInLoop: simulationRunning,
            selfTestActive: physics?.runtime?.selfTestActive === true,
            speedActive: physics?.runtime?.speedActive === true,
            brakeActive: physics?.runtime?.brakeActive === true
        }),
        contractStatus: contract?.status ?? null,
        settlementStatus: settlement?.status ?? null,
        paymentSessionStatus: paymentSession?.status ?? null
    });

}
