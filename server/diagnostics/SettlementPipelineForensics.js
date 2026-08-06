/**
 * R7.66F — TON settlement diagnostics (no secrets).
 */

/** @type {null | {
 *   timestamp: number,
 *   gameEscrowSettlement: null | {
 *     mode: string|null,
 *     escrowAddress: string|null,
 *     winner: string|null,
 *     owner: string|null,
 *     winnerAmount: number|string|null,
 *     ownerAmount: number|string|null,
 *     snapshotHash: string|null,
 *     transactionHash: string|null
 *   }
 * }} */
let _tonSettlementDebug = null;

/**
 * @param {{
 *   mode?: string|null,
 *   escrowAddress?: string|null,
 *   winner?: string|null,
 *   owner?: string|null,
 *   winnerAmount?: number|string|null,
 *   ownerAmount?: number|string|null,
 *   snapshotHash?: string|null,
 *   transactionHash?: string|null
 * }} [fields]
 */
export function setGameEscrowSettlementDebug(fields = {}) {

    const previous = _tonSettlementDebug?.gameEscrowSettlement ?? null;
    const previousConfirmation = _tonSettlementDebug?.gameEscrowConfirmation ?? null;

    _tonSettlementDebug = {
        timestamp: Date.now(),
        gameEscrowSettlement: Object.freeze({
            mode: fields.mode ?? previous?.mode ?? null,
            escrowAddress: fields.escrowAddress
                ?? previous?.escrowAddress
                ?? null,
            winner: fields.winner ?? previous?.winner ?? null,
            owner: fields.owner ?? previous?.owner ?? null,
            winnerAmount: fields.winnerAmount ?? previous?.winnerAmount ?? null,
            ownerAmount: fields.ownerAmount ?? previous?.ownerAmount ?? null,
            snapshotHash: fields.snapshotHash ?? previous?.snapshotHash ?? null,
            transactionHash: fields.transactionHash
                ?? previous?.transactionHash
                ?? null
        }),
        gameEscrowConfirmation: previousConfirmation
    };

    return getTonSettlementDebug();

}

/**
 * R7.66G — Payout-proof confirmation diagnostics.
 */
export function setGameEscrowConfirmationDebug(fields = {}) {

    const previous = _tonSettlementDebug?.gameEscrowConfirmation ?? null;
    const previousSettlement = _tonSettlementDebug?.gameEscrowSettlement ?? null;

    _tonSettlementDebug = {
        timestamp: Date.now(),
        gameEscrowSettlement: previousSettlement,
        gameEscrowConfirmation: Object.freeze({
            escrowAddress: fields.escrowAddress
                ?? previous?.escrowAddress
                ?? null,
            settleTxHash: fields.settleTxHash ?? previous?.settleTxHash ?? null,
            winnerPayoutTx: fields.winnerPayoutTx
                ?? previous?.winnerPayoutTx
                ?? null,
            ownerPayoutTx: fields.ownerPayoutTx
                ?? previous?.ownerPayoutTx
                ?? null,
            confirmedAt: fields.confirmedAt ?? previous?.confirmedAt ?? null,
            status: fields.status ?? previous?.status ?? null
        })
    };

    return getTonSettlementDebug();

}

/**
 * @returns {object|null}
 */
export function getTonSettlementDebug() {

    if (!_tonSettlementDebug) {

        return null;

    }

    return Object.freeze({
        timestamp: _tonSettlementDebug.timestamp,
        gameEscrowSettlement: _tonSettlementDebug.gameEscrowSettlement,
        gameEscrowConfirmation: _tonSettlementDebug.gameEscrowConfirmation ?? null
    });

}

export function printGameEscrowConfirmationDebug(fields = null) {

    const confirmation = fields
        ?? getTonSettlementDebug()?.gameEscrowConfirmation
        ?? null;

    if (!confirmation) {

        return;

    }

    console.log("======================================================");
    console.log("TON_SETTLEMENT_DEBUG.gameEscrowConfirmation");
    console.log("======================================================");
    console.log("escrowAddress:", confirmation.escrowAddress);
    console.log("settleTxHash:", confirmation.settleTxHash);
    console.log("winnerPayoutTx:", confirmation.winnerPayoutTx);
    console.log("ownerPayoutTx:", confirmation.ownerPayoutTx);
    console.log("confirmedAt:", confirmation.confirmedAt);
    console.log("status:", confirmation.status);
    console.log("======================================================");

}

export function printGameEscrowSettlementDebug(fields = null) {

    const settlement = fields
        ?? getTonSettlementDebug()?.gameEscrowSettlement
        ?? null;

    if (!settlement) {

        return;

    }

    console.log("======================================================");
    console.log("TON_SETTLEMENT_DEBUG.gameEscrowSettlement");
    console.log("======================================================");
    console.log("mode:", settlement.mode);
    console.log("escrowAddress:", settlement.escrowAddress);
    console.log("winner:", settlement.winner);
    console.log("owner:", settlement.owner);
    console.log("winnerAmount:", settlement.winnerAmount);
    console.log("ownerAmount:", settlement.ownerAmount);
    console.log("snapshotHash:", settlement.snapshotHash);
    console.log("transactionHash:", settlement.transactionHash);
    console.log("======================================================");

}

export function resetTonSettlementDebugForTests() {

    _tonSettlementDebug = null;

}
