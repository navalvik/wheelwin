/**
 * New Room Wallet payment architecture — financial policy.
 *
 * This module contains accounting rules only. It does not sign, broadcast,
 * or observe blockchain transactions and it does not alter WheelWin gameplay.
 *
 * Important:
 * - All amounts are integer nanograms (bigint).
 * - PAYOUT GAS POLICY (R18 recipient-pays-gas sprint):
 *   - Game Winner payouts, Owner payouts and player refunds are
 *     RECIPIENT_PAYS_GAS transfers. The Room Wallet stays the technical
 *     on-chain sender (and therefore pays the source-side TON fee), but the
 *     recipient transfer value is reduced by a frozen recipient gas charge
 *     BEFORE broadcast, so the game economics fund that fee. This protects
 *     the Room Wallet reserve against repeated coordinated games.
 *   - Operational/non-player transfers (Residues Wallet sweep) remain
 *     SOURCE_PAYS_GAS: recipient value is never reduced and the source
 *     wallet funds the fee from its own envelope.
 * - For every game, 0.01 Gram is retained from the Owner economic share in
 *   the Room Wallet, while the Owner receives the remaining share minus the
 *   recipient gas charge. The Owner payout (gross share minus retention)
 *   must therefore be at least 0.14 Gram.
 * - Residual sweep sends exactly 0.49 Gram to Residues Wallet when the
 *   Room Wallet chain balance reaches 0.50 Gram. The source Room Wallet
 *   retains a 0.01 Gram envelope (0.006 Gram source-paid fee budget +
 *   0.004 Gram safety margin). The 0.49 Gram recipient value is never
 *   reduced to pay fees.
 */

export const GRAM_NANO = 1_000_000_000n;

/**
 * Explicit payout gas policy boundary.
 *
 * RECIPIENT_PAYS_GAS — player/Owner-facing game transfers. The recipient gas
 * charge is computed from an authoritative fee estimate of the exact outbound
 * message BEFORE broadcast and frozen into the persisted payout/refund plan.
 * Recovery reuses the frozen values and never re-estimates.
 *
 * SOURCE_PAYS_GAS — operational transfers (Residues Wallet sweep). Kept on
 * the legacy economics: source wallet funds the fee from its own envelope.
 */
export const PAYOUT_GAS_MODE = Object.freeze({
    RECIPIENT_PAYS_GAS: "RECIPIENT_PAYS_GAS",
    SOURCE_PAYS_GAS: "SOURCE_PAYS_GAS"
});

export const PAYOUT_GAS_POLICY_VERSION = 1;

export const PAYOUT_GAS_PLAN_CODES = Object.freeze({
    FEE_ESTIMATE_UNAVAILABLE: "PAYOUT_GAS_ESTIMATE_UNAVAILABLE",
    RECIPIENT_GAS_EXCEEDS_PAYOUT: "RECIPIENT_GAS_EXCEEDS_PAYOUT",
    PAYOUT_PLAN_MISMATCH: "PAYOUT_PLAN_MISMATCH",
    PLAN_ENTRY_MISSING: "PAYOUT_PLAN_ENTRY_MISSING"
});

export const ROOM_WALLET_POLICY = Object.freeze({
    ownerPayoutMinimumNano: 140_000_000n,
    ownerRetainedNano: 10_000_000n,
    residualTriggerNano: 500_000_000n,
    residualSweepNano: 490_000_000n,
    initialRoomReserveNano: 10_000_000n,
    residualRetainedFloorNano: 10_000_000n,
    residualSweepGasNano: 6_000_000n,
    residualSafetyMarginNano: 4_000_000n,
    /**
     * Recipient gas safety margin (RECIPIENT_PAYS_GAS only).
     *
     * recipientGasChargeNano =
     *     feeEstimateTotalNano
     *     + max(recipientGasMarginFloorNano, feeEstimateTotalNano * marginBps / 10_000)
     *
     * marginBps = 2000 (20%) covers fee-configuration drift and storage-fee
     * growth between estimation and broadcast; the absolute floor of
     * 0.001 Gram keeps small estimates from under-charging when the
     * percentage component rounds down to nearly nothing.
     */
    recipientGasMarginBps: 2_000n,
    recipientGasMarginFloorNano: 1_000_000n
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

/**
 * Deterministic recipient gas charge for a RECIPIENT_PAYS_GAS transfer.
 *
 * Pure accounting: the fee estimate of the exact outbound message is supplied
 * by the caller (TonService estimateExternalMessageFee source_fees sum) and
 * the configured safety margin is added on top. No blockchain access here.
 */
export function buildRecipientGasCharge({
    feeEstimateTotalNano,
    marginBps = ROOM_WALLET_POLICY.recipientGasMarginBps,
    marginFloorNano = ROOM_WALLET_POLICY.recipientGasMarginFloorNano
} = {}) {
    assertNonNegativeNano(feeEstimateTotalNano, "feeEstimateTotalNano");
    assertNonNegativeNano(marginFloorNano, "marginFloorNano");

    if (typeof marginBps !== "bigint" || marginBps < 0n) {
        throw new TypeError("marginBps must be a non-negative bigint");
    }

    const marginComponentNano = feeEstimateTotalNano * marginBps / 10_000n;
    const marginNano = marginComponentNano > marginFloorNano
        ? marginComponentNano
        : marginFloorNano;

    return Object.freeze({
        feeEstimateTotalNano,
        marginBps,
        marginFloorNano,
        marginNano,
        recipientGasChargeNano: feeEstimateTotalNano + marginNano
    });
}

/**
 * Recipient-pays-gas transfer accounting for one payout.
 *
 * The authoritative gross payout is never changed. The recipient transfer
 * value is the gross payout minus the recipient gas charge and must stay
 * strictly positive; otherwise the entry fails closed.
 */
export function buildRecipientPaysGasTransfer({
    grossPayoutNano,
    feeEstimateTotalNano,
    marginBps,
    marginFloorNano
} = {}) {
    assertNonNegativeNano(grossPayoutNano, "grossPayoutNano");

    const charge = buildRecipientGasCharge({ feeEstimateTotalNano, marginBps, marginFloorNano });
    const recipientTransferAmountNano = grossPayoutNano - charge.recipientGasChargeNano;

    if (recipientTransferAmountNano <= 0n) {
        return Object.freeze({
            ok: false,
            code: PAYOUT_GAS_PLAN_CODES.RECIPIENT_GAS_EXCEEDS_PAYOUT,
            grossPayoutNano,
            feeEstimateTotalNano: charge.feeEstimateTotalNano,
            marginBps: charge.marginBps,
            marginFloorNano: charge.marginFloorNano,
            marginNano: charge.marginNano,
            recipientGasChargeNano: charge.recipientGasChargeNano,
            recipientTransferAmountNano: 0n
        });
    }

    return Object.freeze({
        ok: true,
        code: "RECIPIENT_PAYS_GAS_ENTRY",
        grossPayoutNano,
        feeEstimateTotalNano: charge.feeEstimateTotalNano,
        marginBps: charge.marginBps,
        marginFloorNano: charge.marginFloorNano,
        marginNano: charge.marginNano,
        recipientGasChargeNano: charge.recipientGasChargeNano,
        recipientTransferAmountNano,
        sourceFeeBudgetNano: charge.feeEstimateTotalNano,
        sourceDebitNano: recipientTransferAmountNano + charge.feeEstimateTotalNano
    });
}

/**
 * Strict decimal-string -> bigint parser for persisted plan values.
 * Rejects empty strings, signs, whitespace and non-decimal characters so a
 * corrupted persisted plan can never be silently accepted.
 */
export function parseNanoString(value, name = "nano") {
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
        throw new TypeError(`${name} must be a decimal string`);
    }

    return BigInt(value);
}

export function nanoToPersistedString(value) {
    return assertNonNegativeNano(value).toString(10);
}
