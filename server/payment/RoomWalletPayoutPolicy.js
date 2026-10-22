/**
 * Pure accounting for the WheelWin room-wallet settlement policy.
 * No transaction signing, network calls, game-clock changes, or escrow.
 * Amounts are integer units of the SAME asset; never mix GRAM and TON.
 */
function units(value, name) {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new TypeError(`${name} must be an unsigned integer string`);
    }
    return BigInt(value);
}

/**
 * Reserve a fixed 95% prize; owner share is strictly subordinate to
 * outgoing transaction fees and the retained room-wallet balance.
 *
 * IMPORTANT: TON gas cannot be subtracted from a GRAM-denominated pool.
 * Call only with a single-asset accounting balance and same-asset charges;
 * the caller must separately fund and account for TON gas where applicable.
 */
export function calculateRoomPayout({
    totalPoolUnits,
    winnerTransferFeeUnits,
    ownerTransferFeeUnits,
    retainedBalanceUnits = "0"
}) {
    const pool = units(totalPoolUnits, "totalPoolUnits");
    const winnerFee = units(winnerTransferFeeUnits, "winnerTransferFeeUnits");
    const ownerFee = units(ownerTransferFeeUnits, "ownerTransferFeeUnits");
    const retained = units(retainedBalanceUnits, "retainedBalanceUnits");
    const winner = pool * 95n / 100n;
    const remainder = pool - winner;
    const costs = winnerFee + ownerFee + retained;
    if (costs > remainder) {
        throw new RangeError("outgoing fees and retained balance exceed the 5% allowance");
    }
    const owner = remainder - costs;
    return Object.freeze({
        winnerUnits: winner.toString(),
        ownerUnits: owner.toString(),
        winnerTransferFeeUnits: winnerFee.toString(),
        ownerTransferFeeUnits: ownerFee.toString(),
        retainedBalanceUnits: retained.toString()
    });
}

/**
 * Cancelled before Page5: the refund sender's outgoing fee is borne by
 * the paying player, never by Owner Wallet.
 */
export function calculateCancelledRoomRefund({ paidUnits, refundTransferFeeUnits }) {
    const paid = units(paidUnits, "paidUnits");
    const fee = units(refundTransferFeeUnits, "refundTransferFeeUnits");
    if (fee >= paid) {
        throw new RangeError("refund fee must be smaller than the paid amount");
    }
    return Object.freeze({
        refundUnits: (paid - fee).toString(),
        refundTransferFeeUnits: fee.toString()
    });
}
