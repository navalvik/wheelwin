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
 * - Owner payout accounting keeps 0.14 Gram for the owner and 0.01 Gram
 *   as the room-wallet retained amount for the current policy.
 * - Residual sweep uses 0.49 Gram as the transfer amount; its gas is paid
 *   separately by the source Room Wallet.
 */

export const GRAM_NANO = 1_000_000_000n;

export const ROOM_WALLET_POLICY = Object.freeze({
    ownerPayoutNano: 140_000_000n,
    ownerRetainedNano: 10_000_000n,
    residualTriggerNano: 500_000_000n,
    residualSweepNano: 490_000_000n,
    initialRoomReserveNano: 10_000_000n
});

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

    if (ownerGrossNano < ROOM_WALLET_POLICY.ownerPayoutNano) {
        throw new RangeError(
            `ownerGrossNano must be at least ${ROOM_WALLET_POLICY.ownerPayoutNano} nanograms`
        );
    }

    return Object.freeze({
        ownerGrossNano,
        ownerPayoutNano: ROOM_WALLET_POLICY.ownerPayoutNano,
        retainedNano: ROOM_WALLET_POLICY.ownerRetainedNano,
        minimumEconomicShareNano:
            ROOM_WALLET_POLICY.ownerPayoutNano
            + ROOM_WALLET_POLICY.ownerRetainedNano
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

export function buildResidualSweep({ balanceNano, gasNano }) {
    assertNonNegativeNano(balanceNano, "balanceNano");
    assertNonNegativeNano(gasNano, "gasNano");

    if (balanceNano < ROOM_WALLET_POLICY.residualTriggerNano) {
        return Object.freeze({
            eligible: false,
            reason: "BELOW_RESIDUAL_TRIGGER",
            transferNano: 0n,
            gasNano,
            sourceDebitNano: 0n,
            remainingNano: balanceNano
        });
    }

    const sourceDebitNano =
        ROOM_WALLET_POLICY.residualSweepNano + gasNano;

    if (balanceNano < sourceDebitNano) {
        return Object.freeze({
            eligible: false,
            reason: "INSUFFICIENT_BALANCE_FOR_SWEEP_AND_GAS",
            transferNano: ROOM_WALLET_POLICY.residualSweepNano,
            gasNano,
            sourceDebitNano,
            remainingNano: balanceNano
        });
    }

    return Object.freeze({
        eligible: true,
        reason: "ELIGIBLE",
        transferNano: ROOM_WALLET_POLICY.residualSweepNano,
        gasNano,
        sourceDebitNano,
        remainingNano: balanceNano - sourceDebitNano
    });
}
