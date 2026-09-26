/**
 * R7.66F — TON settlement diagnostics (no secrets).
 */

/** @type {null | {
 *   timestamp: number,
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
export function getTonSettlementDebug() {

    if (!_tonSettlementDebug) {

        return null;

    }

    return Object.freeze({
        timestamp: _tonSettlementDebug.timestamp,
    });

}


    const confirmation = fields
        ?? null;

    if (!confirmation) {

        return;

    }

    console.log("======================================================");
    console.log("======================================================");
    console.log("escrowAddress:", confirmation.escrowAddress);
    console.log("settleTxHash:", confirmation.settleTxHash);
    console.log("winnerPayoutTx:", confirmation.winnerPayoutTx);
    console.log("ownerPayoutTx:", confirmation.ownerPayoutTx);
    console.log("confirmedAt:", confirmation.confirmedAt);
    console.log("status:", confirmation.status);
    console.log("======================================================");

}

