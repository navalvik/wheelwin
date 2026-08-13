/**
 * R5.18 — Personalized end-game presentation helpers (client-only).
 * Compares authoritative winner id to the local seat; never decides the winner.
 */

/**
 * @param {{
 *   result?: { winner?: { id?: string | null, playerId?: string | null } | null } | null,
 *   payment?: { winnerId?: string | null } | null,
 *   gameReport?: { winningPlayer?: { playerId?: string | null } | null } | null
 * }} sources
 * @returns {string | null}
 */
export function resolveAuthoritativeWinnerPlayerId({
    result = null,
    payment = null,
    gameReport = null
} = {}) {

    const winner = result?.winner ?? null;

    return payment?.winnerId
        ?? gameReport?.winningPlayer?.playerId
        ?? winner?.playerId
        ?? winner?.id
        ?? null;

}

/**
 * @param {string | null | undefined} localPlayerId
 * @param {string | null | undefined} winnerPlayerId
 * @returns {boolean | null} null when comparison is not possible yet
 */
export function isLocalPlayerWinner(localPlayerId, winnerPlayerId) {

    if (
        localPlayerId == null
        || localPlayerId === ""
        || winnerPlayerId == null
        || winnerPlayerId === ""
    ) {

        return null;

    }

    return String(localPlayerId) === String(winnerPlayerId);

}

/**
 * @param {boolean | null} isWinner
 * @returns {{ headline: string, trophy: string | null, variant: "win" | "lost" | "pending" }}
 */
export function resolvePersonalizedResultPresentation(isWinner) {

    if (isWinner === true) {

        return {
            headline: "YOU WIN",
            headlineKey: "game.youWin",
            trophy: "🏆",
            variant: "win"
        };

    }

    if (isWinner === false) {

        return {
            headline: "YOU LOST",
            headlineKey: "game.youLost",
            trophy: null,
            variant: "lost"
        };

    }

    return {
        headline: "Waiting for result…",
        headlineKey: "game.waitingResult",
        trophy: null,
        variant: "pending"
    };

}
