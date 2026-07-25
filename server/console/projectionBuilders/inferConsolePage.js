/**
 * R6.0C — Infer client page index from authoritative lifecycle signals.
 * Server does not store currentPage; this is a read-only projection heuristic.
 *
 * 1 Welcome | 2 Lobby | 3 PlayerSetup | 4 Matrix | 5 Verify |
 * 6 Payment | 7 Game | 8 Result
 */
export function inferConsolePage({
    room = null,
    setupSession = null,
    paymentSession = null,
    gameStart = null,
    gameState = null,
    resultSession = null,
    gameStatus = null
} = {}) {

    if (resultSession) {

        return 8;

    }

    if (gameState != null) {

        return 7;

    }

    if (gameStart?.phase === "OPEN_PAGE5"
        || gameStatus === "RUNNING"
        || gameStatus === "FINISHED") {

        return 7;

    }

    if (paymentSession
        && paymentSession.status !== "COMPLETED"
        && paymentSession.status !== "FAILED") {

        return 6;

    }

    if (paymentSession?.status === "COMPLETED"
        && (gameStart?.phase === "GAME_START_AUTHORIZED"
            || gameStart?.phase === "GAME_INITIALIZING")) {

        return 6;

    }

    if (setupSession?.verificationState === "READY"
        && setupSession?.paymentPrepState !== "READY") {

        return 5;

    }

    if (setupSession
        && setupSession.state !== "EXPIRED"
        && setupSession.state !== "ABORTED"
        && setupSession.state !== "COMPLETED") {

        if (setupSession.roomFull === true) {

            return 4;

        }

        return 3;

    }

    if (room) {

        return 2;

    }

    return 1;

}
