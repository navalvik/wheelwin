/**
 * R6.0C — Infer client page index from authoritative lifecycle signals.
 * Server does not store currentPage; this is a read-only projection heuristic.
 *
 * 1 Welcome | 2 Lobby | 3 PlayerSetup | 4 Matrix | 5 Verify |
 * 6 (retired payment page) | 7 Game | 8 Result
 */
export function inferConsolePage({
    room = null,
    setupSession = null,
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

    if (setupSession?.verificationState === "READY") {

        return 5;

    }

    if (setupSession
        && setupSession.state !== "EXPIRED"
        && setupSession.state !== "ABORTED"
        && setupSession.state !== "COMPLETED"
        && setupSession.state !== "ARCHIVED") {

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
