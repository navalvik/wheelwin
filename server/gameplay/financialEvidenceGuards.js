import { isSettlementSessionTerminal } from "../payment/SettlementSessionStates.js";

/**
 * R8.8 — Shared fail-safe for financial evidence retention.
 *
 * After GAME_INITIALIZED / entry-payment activation, missing live references
 * are treated as UNKNOWN (keep alive), never as proof the game was unpaid.
 *
 * SESSION_FINISHED / ROOM_DESTROYED may clean up only when settlement is
 * already terminal (or no financially activated lifecycle exists).
 *
 * @param {{
 *   roomId?: string|null,
 *   gameManager?: object|null,
 *   contractSettlementManager?: object|null,
 *   paymentSessionManager?: object|null
 * }} deps
 * @returns {boolean} true → do not destroy financial objects
 */
export function shouldPreserveFinancialEvidence({
    roomId = null,
    gameManager = null,
    contractSettlementManager = null,
    paymentSessionManager = null
} = {}) {

    if (!roomId) {

        return false;

    }

    const gameId = gameManager?.getGameIdByRoomId?.(roomId)
        ?? paymentSessionManager?.getSession?.(roomId)?.gameId
        ?? null;

    const session = gameId
        ? contractSettlementManager?.getSettlementSession?.(gameId) ?? null
        : null;

    if (session && isSettlementSessionTerminal(session.status)) {

        return false;

    }

    if (session?.isInProgress?.() === true) {

        return true;

    }

    const initialized = gameManager?.hasInitializedGameplay?.(roomId) === true;

    const entryPaid = Boolean(
        gameId && gameManager?.wasEntryPaymentActivated?.(gameId)
    );

    const hasPayment = Boolean(paymentSessionManager?.getSession?.(roomId));

    // Post-init financially relevant OR entry-paid with missing settlement =
    // UNKNOWN / incomplete → keep evidence.
    if (initialized && (entryPaid || hasPayment)) {

        return true;

    }

    if (entryPaid && !session) {

        return true;

    }

    return false;

}
