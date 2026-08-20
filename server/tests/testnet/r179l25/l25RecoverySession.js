/**
 * R17.9L.25.K — TEST-ONLY recovery DepositSession factory.
 *
 * Uses the same lifecycle as production orchestration:
 *   CREATED → bindPlayers() → bindingHash → setDepositAddress → AWAITING_FUNDS
 *
 * Do not assign session.bindingHash manually.
 */

import { DepositSession } from "../../../deposit/DepositSession.js";
import { DEPOSIT_SESSION_STATUS } from "../../../deposit/DepositSessionStates.js";
import { computeDepositBindingHash } from "../../../deposit/deploymentAuthorizationHash.js";
import { L25_ERROR_CODES, L25TestError } from "./l25Errors.js";

/**
 * Build a recovery DepositSession with production-compatible bindingHash.
 *
 * @param {{
 *   depositId: string,
 *   roomId: string,
 *   gameId: string,
 *   players: Array<{ playerId: string, wallet: string, expectedAmount: number|string|bigint }>,
 *   depositAddress: string,
 *   metadata?: object|null,
 *   depositPackage?: object|null,
 *   reservedWallets?: object|null
 * }} params
 */
export function createL25RecoveryDepositSession({
    depositId,
    roomId,
    gameId,
    players,
    depositAddress,
    metadata = null,
    depositPackage = null,
    reservedWallets = null
} = {}) {

    if (!depositId || !roomId || !gameId) {

        throw new L25TestError(
            "Recovery session requires depositId, roomId, and gameId",
            L25_ERROR_CODES.PHASE_FAILED
        );

    }

    if (!Array.isArray(players) || players.length !== 3) {

        throw new L25TestError(
            "Recovery session requires exactly 3 players",
            L25_ERROR_CODES.SEAT_MISMATCH,
            { playerCount: players?.length ?? 0 }
        );

    }

    if (!depositAddress) {

        throw new L25TestError(
            "Recovery session requires depositAddress",
            L25_ERROR_CODES.PHASE_FAILED
        );

    }

    const session = new DepositSession({
        depositId,
        roomId,
        gameId,
        state: DEPOSIT_SESSION_STATUS.CREATED,
        metadata: {
            ...(metadata && typeof metadata === "object" ? metadata : {}),
            ...(depositPackage
                ? { depositPackage: Object.freeze({ ...depositPackage }) }
                : {})
        }
    });

    // Production-compatible path — sole place bindingHash is generated.
    session.bindPlayers(players, { reservedWallets });

    if (!session.bindingHash || typeof session.bindingHash !== "string") {

        throw new L25TestError(
            "bindPlayers did not produce bindingHash",
            L25_ERROR_CODES.PHASE_FAILED
        );

    }

    const expectedHash = computeDepositBindingHash({
        roomId: session.roomId,
        gameId: session.gameId,
        depositId: session.depositId,
        bindings: session.bindings
    });

    if (session.bindingHash !== expectedHash) {

        throw new L25TestError(
            "Recovery bindingHash does not match computeDepositBindingHash",
            L25_ERROR_CODES.PHASE_FAILED,
            {
                stored: session.bindingHash,
                expected: expectedHash
            }
        );

    }

    session.setDepositAddress(depositAddress);
    session.markAwaitingFunds();

    if (session.state !== DEPOSIT_SESSION_STATUS.AWAITING_FUNDS) {

        throw new L25TestError(
            "Recovery session did not reach AWAITING_FUNDS",
            L25_ERROR_CODES.PHASE_FAILED,
            { state: session.state }
        );

    }

    return session;

}

/**
 * Persist recovery session into an L25 DepositSessionCoordinator (TEST-ONLY).
 */
export function commitL25RecoverySession(depositSessionCoordinator, session) {

    if (!depositSessionCoordinator || typeof depositSessionCoordinator._commitNew !== "function") {

        throw new L25TestError(
            "depositSessionCoordinator._commitNew is required for recovery commit",
            L25_ERROR_CODES.PHASE_FAILED
        );

    }

    if (!session?.bindingHash) {

        throw new L25TestError(
            "Refusing to commit recovery session without bindingHash",
            L25_ERROR_CODES.PHASE_FAILED
        );

    }

    depositSessionCoordinator._commitNew(session);

    return depositSessionCoordinator.getSession(session.depositId) ?? session;

}

/**
 * Apply three seat funding events so a recovery session reaches DEPOSIT_FULL.
 * TEST-ONLY domain transition helper (no TON).
 */
export function fundL25RecoverySessionToFull(depositSessionCoordinator, session) {

    const current = depositSessionCoordinator.getSession(session.depositId) ?? session;

    if (!current?.bindingHash) {

        throw new L25TestError(
            "Cannot fund recovery session without bindingHash",
            L25_ERROR_CODES.PHASE_FAILED
        );

    }

    for (const [index, binding] of (current.bindings ?? []).entries()) {

        depositSessionCoordinator.applyFunding(current.depositId, {
            wallet: binding.wallet,
            amount: binding.expectedAmount,
            fundingEventId: `l25-recovery-fund-${index}`
        });

    }

    const refreshed = depositSessionCoordinator.getSession(current.depositId);

    if (!refreshed || refreshed.state !== DEPOSIT_SESSION_STATUS.DEPOSIT_FULL) {

        throw new L25TestError(
            "Recovery session did not reach DEPOSIT_FULL after funding",
            L25_ERROR_CODES.PHASE_FAILED,
            { state: refreshed?.state ?? null }
        );

    }

    if (!refreshed.bindingHash) {

        throw new L25TestError(
            "bindingHash missing after DEPOSIT_FULL",
            L25_ERROR_CODES.PHASE_FAILED
        );

    }

    return refreshed;

}
