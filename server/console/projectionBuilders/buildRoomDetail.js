import { inferConsolePage } from "./inferConsolePage.js";

/**
 * Sanitize payment session for console — never include wallets / tx hashes.
 */
function projectPaymentSession(session) {

    if (!session) {

        return null;

    }

    const snapshot = typeof session.toSnapshot === "function"
        ? session.toSnapshot()
        : session;

    return Object.freeze({
        paymentSessionId: snapshot.paymentSessionId,
        roomId: snapshot.roomId,
        gameId: snapshot.gameId ?? null,
        status: snapshot.status,
        createdAt: snapshot.createdAt,
        expiresAt: snapshot.expiresAt ?? null,
        completedAt: snapshot.completedAt ?? null,
        participantCount: Array.isArray(snapshot.participants)
            ? snapshot.participants.length
            : 0,
        participants: Object.freeze(
            (snapshot.participants ?? []).map((participant) => Object.freeze({
                playerId: participant.playerId,
                status: participant.status,
                requiredGram: participant.requiredGram
                // wallet, paymentReference, contractAddress, txHash omitted
            }))
        )
    });

}

function projectSetupSession(session) {

    if (!session) {

        return null;

    }

    const snapshot = typeof session.toSnapshot === "function"
        ? session.toSnapshot()
        : session;

    return Object.freeze({
        setupSessionId: snapshot.setupSessionId,
        roomId: snapshot.roomId,
        state: snapshot.state,
        startedAt: snapshot.startedAt,
        expiresAt: snapshot.expiresAt,
        remainingTime: typeof session.remainingTime === "function"
            ? session.remainingTime()
            : (snapshot.remainingTime ?? null),
        verificationState: snapshot.verificationState ?? null,
        paymentPrepState: snapshot.paymentPrepState ?? null,
        roomFull: snapshot.roomFull === true
    });

}

function projectContract(contract) {

    if (!contract) {

        return null;

    }

    const snapshot = typeof contract.toSnapshot === "function"
        ? contract.toSnapshot()
        : contract;

    return Object.freeze({
        contractId: snapshot.contractId,
        gameId: snapshot.gameId,
        roomId: snapshot.roomId,
        status: snapshot.status,
        createdAt: snapshot.createdAt,
        deploymentStatus: snapshot.deploymentStatus ?? null,
        deployedAt: snapshot.deployedAt ?? null
        // contractAddress / economic snapshot omitted from room detail
    });

}

/**
 * R6.0C — Room detail DTO (no physics snapshots).
 */
export function buildRoomDetail(roomId, {
    roomManager,
    playerManager,
    gameManager,
    setupSessionLifecycle,
    paymentSessionManager,
    gameContractManager,
    gameStartAuthorization,
    gameStateEngine,
    gameClockEngine,
    resultSessionLifecycle,
    gameplayContextResolver = null,
    roomLobbyBridge = null
}) {

    const room = roomManager?.getRoom?.(roomId);

    if (!room) {

        return null;

    }

    const playerIds = Array.isArray(room.players) ? room.players : [];

    const players = playerIds.map((playerId) => {

        const player = playerManager?.getPlayer?.(playerId);

        if (!player) {

            return Object.freeze({
                playerId,
                nickname: null,
                online: false,
                playerState: null
            });

        }

        return Object.freeze({
            playerId,
            nickname: player.identity?.nickname ?? null,
            online: player.runtime?.connectionState === "CONNECTED",
            connectionState: player.runtime?.connectionState ?? null,
            playerState: player.runtime?.playerState ?? null,
            walletConnected: Boolean(player.identity?.wallet)
        });

    });

    const setupSession = setupSessionLifecycle?.getSession?.(roomId) ?? null;
    const paymentSession = paymentSessionManager?.getSession?.(roomId) ?? null;
    const contract = gameContractManager?.getContract?.(roomId) ?? null;
    const gameStart = gameStartAuthorization?.getReconnectSnapshot?.(roomId)
        ?? null;
    const resultSession = resultSessionLifecycle?.getSession?.(roomId) ?? null;

    let gameId = gameStart?.gameId
        ?? paymentSession?.gameId
        ?? contract?.gameId
        ?? null;

    if (!gameId && gameplayContextResolver?.resolveGameIdByRoomId) {

        gameId = gameplayContextResolver.resolveGameIdByRoomId(roomId) ?? null;

    }

    const game = gameId ? gameManager?.getGame?.(gameId) : null;
    const gameState = gameId
        ? (gameStateEngine?.getState?.(gameId) ?? null)
        : null;
    const clock = gameId ? gameClockEngine?.getClock?.(gameId) : null;

    const currentPage = inferConsolePage({
        room,
        setupSession,
        paymentSession,
        gameStart,
        gameState,
        resultSession,
        gameStatus: game?.status ?? null
    });

    const tonConnect = typeof roomLobbyBridge?.getTonConnectDiagnostics === "function"
        ? roomLobbyBridge.getTonConnectDiagnostics(roomId)
        : null;

    return Object.freeze({
        room: Object.freeze({
            roomId: room.roomId,
            status: room.status,
            maxPlayers: room.maxPlayers,
            createdAt: room.createdAt,
            playerCount: playerIds.length
        }),
        players: Object.freeze(players),
        setupSession: projectSetupSession(setupSession),
        linkedGame: game
            ? Object.freeze({
                gameId: game.gameId,
                status: game.status,
                createdAt: game.createdAt
            })
            : null,
        paymentSession: projectPaymentSession(paymentSession),
        contract: projectContract(contract),
        gameStart,
        currentState: gameState,
        currentPage,
        tonConnect,
        timers: Object.freeze({
            setupRemainingMs: typeof setupSession?.remainingTime === "function"
                ? setupSession.remainingTime()
                : null,
            gameClock: clock
                ? Object.freeze({
                    phase: clock.phase ?? clock.currentPhase ?? null,
                    elapsedMs: gameClockEngine?.getElapsed?.(gameId) ?? null,
                    remainingMs: gameClockEngine?.getRemaining?.(gameId) ?? null,
                    running: gameClockEngine?.isRunning?.(gameId) === true
                })
                : null,
            resultSessionActive: resultSession != null
        })
    });

}
