/**
 * New Room Wallet payment architecture — financial policy.
 *
 * This module contains accounting rules only. It does not sign, broadcast,
 * or observe blockchain transactions and it does not alter WheelWin gameplay.
 *
 * Important:
 * - All amounts are integer nanograms (bigint).
 * - Recipient amounts are never reduced by gas.
 * - Gas is charged to the source wallet.
 * - For every game, 0.01 Gram is retained from the Owner economic share in
 *   the Room Wallet, while the Owner receives the remaining share. The Owner
 *   payout must therefore be at least 0.14 Gram.
 * - Residual sweep sends exactly 0.49 Gram to Residues Wallet when the
 *   Room Wallet chain balance reaches 0.50 Gram. The source Room Wallet
 *   retains a 0.01 Gram envelope (0.006 Gram source-paid fee budget +
 *   0.004 Gram safety margin). The 0.49 Gram recipient value is never
 *   reduced to pay fees.
 */

export const GRAM_NANO = 1_000_000_000n;

export const ROOM_WALLET_POLICY = Object.freeze({
    ownerPayoutMinimumNano: 140_000_000n,
    ownerRetainedNano: 10_000_000n,
    residualTriggerNano: 500_000_000n,
    residualSweepNano: 490_000_000n,
    initialRoomReserveNano: 10_000_000n,
    residualRetainedFloorNano: 10_000_000n,
    residualSweepGasNano: 6_000_000n,
    residualSafetyMarginNano: 4_000_000n
});

if (
    ROOM_WALLET_POLICY.residualSweepGasNano
        + ROOM_WALLET_POLICY.residualSafetyMarginNano
    !== ROOM_WALLET_POLICY.residualRetainedFloorNano
) {
    throw new Error(
        "ROOM_WALLET_POLICY residual retained floor must equal sweep gas + safety margin"
    );
}

export function gramsToNano(grams) {
    if (!Number.isFinite(grams) || grams < 0) {
        throw new TypeError("grams must be a non-negative finite number");
    }

    const scaled = Math.round(grams * Number(GRAM_NANO));
    return BigInt(scaled);
}

export function assertNonNegativeNano(value, name = "amount") {
    if (typeof value !== "bigint" || value < 0n) {
        throw new TypeError(`${name} must be a non-negative bigint`);
    }

    return value;
}

export function buildOwnerPayout({ ownerGrossNano }) {
    assertNonNegativeNano(ownerGrossNano, "ownerGrossNano");

    const retainedNano = ROOM_WALLET_POLICY.ownerRetainedNano;
    const ownerPayoutNano = ownerGrossNano - retainedNano;

    if (ownerPayoutNano < ROOM_WALLET_POLICY.ownerPayoutMinimumNano) {
        throw new RangeError(
            `ownerGrossNano must leave at least ${ROOM_WALLET_POLICY.ownerPayoutMinimumNano} nanograms for the Owner after retention`
        );
    }

    return Object.freeze({
        ownerGrossNano,
        ownerPayoutNano,
        retainedNano,
        minimumEconomicShareNano:
            ROOM_WALLET_POLICY.ownerPayoutMinimumNano
            + retainedNano
    });
}

export function buildSourceWalletTransfer({ amountNano, gasNano }) {
    assertNonNegativeNano(amountNano, "amountNano");
    assertNonNegativeNano(gasNano, "gasNano");

    return Object.freeze({
        amountNano,
        gasNano,
        sourceDebitNano: amountNano + gasNano,
        recipientCreditNano: amountNano
    });
}

/**
 * Deterministic residual-sweep eligibility.
 *
 * Recipient transfer value is always residualSweepNano (0.49 Gram) when
 * eligible. Source-paid fee budget and safety margin live inside the
 * retained floor (0.01 Gram). They are not extra deductions on top of
 * 0.49 + 0.01, and they do not reduce the recipient amount.
 */
export function buildResidualSweep({ balanceNano } = {}) {
    assertNonNegativeNano(balanceNano, "balanceNano");

    const transferNano = ROOM_WALLET_POLICY.residualSweepNano;
    const triggerNano = ROOM_WALLET_POLICY.residualTriggerNano;
    const retainedFloorNano = ROOM_WALLET_POLICY.residualRetainedFloorNano;
    const sweepGasNano = ROOM_WALLET_POLICY.residualSweepGasNano;
    const safetyMarginNano = ROOM_WALLET_POLICY.residualSafetyMarginNano;

    const composition = Object.freeze({
        triggerNano,
        retainedFloorNano,
        sweepGasNano,
        safetyMarginNano,
        sourceFeeBudgetNano: sweepGasNano
    });

    if (balanceNano < triggerNano) {
        return Object.freeze({
            eligible: false,
            reason: "BELOW_RESIDUAL_TRIGGER",
            transferNano: 0n,
            recipientCreditNano: 0n,
            remainingAfterTransferNano: balanceNano,
            remainingAfterFeeBudgetNano: balanceNano,
            ...composition
        });
    }

    const remainingAfterTransferNano = balanceNano - transferNano;

    if (remainingAfterTransferNano < retainedFloorNano) {
        return Object.freeze({
            eligible: false,
            reason: "INSUFFICIENT_RETAINED_FLOOR",
            transferNano,
            recipientCreditNano: transferNano,
            remainingAfterTransferNano,
            remainingAfterFeeBudgetNano:
                remainingAfterTransferNano > sweepGasNano
                    ? remainingAfterTransferNano - sweepGasNano
                    : 0n,
            ...composition
        });
    }

    return Object.freeze({
        eligible: true,
        reason: "ELIGIBLE",
        transferNano,
        recipientCreditNano: transferNano,
        remainingAfterTransferNano,
        remainingAfterFeeBudgetNano: remainingAfterTransferNano - sweepGasNano,
        ...composition
    });
}
