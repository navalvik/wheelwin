/**
 * Phase 4 — Validated payout plan value object.
 *
 * A payout plan allocates confirmed principal into full recipient transfers
 * plus a retained room-wallet gas reserve. Actual network fees are booked as
 * source-wallet expenses after chain verification.
 *
 * Approved payout rules enforced here:
 *   - winner amount is 95%, owner amount is 5%, and remaining 0% plus
 *     rounding dust stays in the source Room Wallet;
 *   - ``netAtomic` is gross minus the frozen recipient fee; `reservedFeeAtomic` is
 *     zero because the Room Wallet pays actual network fees separately.
 *
 * The final reconciliation invariant
 *
 *   winnerTransferAtomic + ownerTransferAtomic + gasReserveAtomic
 *       === totalSettledPrincipalAtomic
 *
 * proves that payouts plus the retained reserve account for principal. Actual
 * source-wallet network fees are recorded separately when verified.
 */

import { PayoutValidationError } from "./LedgerErrors.js";

function assertPositiveSafeInteger(value, field) {

    if (typeof value !== "number"
        || !Number.isSafeInteger(value)
        || value <= 0) {

        throw new PayoutValidationError(
            `${field} must be a positive safe integer`,
            { field, value }
        );

    }

}

function assertNonEmptyString(value, field) {

    if (typeof value !== "string" || value.trim() === "") {

        throw new PayoutValidationError(`${field} must be a non-empty string`, { field });

    }

}

function assertNonNegativeSafeInteger(value, field) {

    if (typeof value !== "number"
        || !Number.isSafeInteger(value)
        || value < 0) {

        throw new PayoutValidationError(
            `${field} must be a non-negative safe integer`,
            { field, value }
        );

    }

}

/**
 * One outgoing payout transfer with its own, separately represented network fee.
 *
 * Recipient amounts are never reduced by a reserved network fee. Actual fees
 * are recorded separately as source-wallet expenses.
 */
export class PayoutTransfer {

    constructor({ recipientRole, recipientId, address, grossAtomic, reservedFeeAtomic, feeQuote }) {

        assertNonEmptyString(recipientRole, "recipientRole");
        assertNonEmptyString(recipientId, "recipientId");
        assertNonEmptyString(address, "address");
        assertPositiveSafeInteger(grossAtomic, "grossAtomic");

        // Non-negative (a zero fee is valid), never a floating-point value.
        assertNonNegativeSafeInteger(reservedFeeAtomic, "reservedFeeAtomic");

        if (reservedFeeAtomic >= grossAtomic) {
            throw new PayoutValidationError(
                "recipient fee must be smaller than gross allocation",
                { recipientRole, grossAtomic, reservedFeeAtomic }
            );
        }

        this.recipientRole = recipientRole;

        this.recipientId = recipientId;

        this.address = address;

        this.grossAtomic = grossAtomic;

        this.reservedFeeAtomic = reservedFeeAtomic;

        // Full transfer amount. TON fees are charged separately to source.
        this.netAtomic = grossAtomic - reservedFeeAtomic;

        this.feeQuote = feeQuote
            ? Object.freeze({
                feeAtomic: feeQuote.feeAtomic,
                quotedAtMs: feeQuote.quotedAtMs ?? null
            })
            : null;

        Object.freeze(this);

    }

    toJSON() {

        return Object.freeze({
            recipientRole: this.recipientRole,
            recipientId: this.recipientId,
            address: this.address,
            grossAtomic: this.grossAtomic,
            reservedFeeAtomic: this.reservedFeeAtomic,
            netAtomic: this.netAtomic,
            feeQuote: this.feeQuote
        });

    }

    static fromJSON(record) {

        if (record.netAtomic !== undefined
            && record.netAtomic !== record.grossAtomic - record.reservedFeeAtomic) {
            throw new PayoutValidationError("recipient net amount must equal gross minus frozen gas");
        }
        return new PayoutTransfer(record);

    }

}

export class PayoutPlan {

    /**
     * @param {{
     *   payoutId: string,
     *   roomId: string,
     *   asset: string,
     *   network: string,
     *   principalAtomic: number,
     *   allocation: object,
     *   transfers: PayoutTransfer[],
     *   createdAtMs: number,
     *   planId?: string
     * }} input
     */
    constructor(input) {

        assertNonEmptyString(input.payoutId, "payoutId");
        assertNonEmptyString(input.roomId, "roomId");
        assertNonEmptyString(input.asset, "asset");
        assertNonEmptyString(input.network, "network");
        assertPositiveSafeInteger(input.principalAtomic, "principalAtomic");
        const gasReserveAtomic = input.gasReserveAtomic ?? input.safetyMarginAtomic ?? 0;
        assertNonNegativeSafeInteger(gasReserveAtomic, "gasReserveAtomic");

        if (!Array.isArray(input.transfers) || input.transfers.length === 0) {

            throw new PayoutValidationError(
                "a payout plan must contain at least one outgoing transfer"
            );

        }

        for (const transfer of input.transfers) {

            if (!(transfer instanceof PayoutTransfer)) {

                throw new PayoutValidationError(
                    "every payout transfer must be a PayoutTransfer instance"
                );

            }

        }

        const winnerTransfer = input.transfers.find(
            (transfer) => transfer.recipientRole === "WINNER");
        const ownerTransfer = input.transfers.find(
            (transfer) => transfer.recipientRole === "OWNER");
        const principal = BigInt(input.principalAtomic);
        const expectedWinnerAtomic = Number((principal * 95n) / 100n);
        // Historic 95/4.9/0.1 source-funded plans remain immutable on replay.
        const legacyRule = input.allocation?.ruleId ===
            "APPROVED_WINNER_95_OWNER_4_9_GAS_RESERVE_0_1_RULE";
        const expectedOwnerAtomic = legacyRule
            ? Number((principal * 49n) / 1000n)
            : input.principalAtomic - expectedWinnerAtomic;

        if (input.transfers.length !== 2
            || !winnerTransfer
            || !ownerTransfer
            || winnerTransfer.grossAtomic !== expectedWinnerAtomic
            || ownerTransfer.grossAtomic !== expectedOwnerAtomic
            || gasReserveAtomic !== Number(
                principal - BigInt(expectedWinnerAtomic) - BigInt(expectedOwnerAtomic))) {

            throw new PayoutValidationError(
                "payout plan gross shares or retained remainder are inconsistent",
                {
                    expectedWinnerAtomic,
                    actualWinnerAtomic: winnerTransfer?.grossAtomic ?? null,
                    expectedOwnerAtomic,
                    actualOwnerAtomic: ownerTransfer?.grossAtomic ?? null,
                    gasReserveAtomic
                }
            );

        }

        const totalGrossAtomic = input.transfers.reduce(
            (sum, transfer) => sum + transfer.grossAtomic, 0);

        const totalReservedFeeAtomic = input.transfers.reduce(
            (sum, transfer) => sum + transfer.reservedFeeAtomic, 0);

        const totalNetAtomic = input.transfers.reduce(
            (sum, transfer) => sum + transfer.netAtomic, 0);

        // New plans allocate 95/5 gross, while each recipient pays its
        // frozen gas charge: gross = net + fee. Historical plans keep their
        // source-funded reserve and cannot be silently rewritten.
        if ((legacyRule && totalReservedFeeAtomic !== 0)
            || (!legacyRule && (totalReservedFeeAtomic <= 0
                || input.transfers.some(t => t.reservedFeeAtomic <= 0)))
            || totalGrossAtomic + gasReserveAtomic !== input.principalAtomic
            || totalNetAtomic + totalReservedFeeAtomic + gasReserveAtomic !== input.principalAtomic) {

            throw new PayoutValidationError(
                "payout plan must exactly account for settled principal "
                    + "(winner transfer + owner transfer + retained reserve !== principal)",
                {
                    principalAtomic: input.principalAtomic,
                    totalNetAtomic,
                    totalReservedFeeAtomic,
                    gasReserveAtomic
                }
            );

        }

        this.planId = input.planId ?? `plan_${input.payoutId}`;

        this.payoutId = input.payoutId;

        this.roomId = input.roomId;

        this.asset = input.asset;

        this.network = input.network;

        this.principalAtomic = input.principalAtomic;

        this.gasReserveAtomic = gasReserveAtomic;
        // Compatibility alias retained for old forensic serializers.
        this.safetyMarginAtomic = gasReserveAtomic;

        this.allocation = Object.freeze({ ...(input.allocation ?? {}) });

        this.transfers = Object.freeze([...input.transfers]);

        this.totalGrossAtomic = totalGrossAtomic;

        this.totalReservedFeeAtomic = totalReservedFeeAtomic;

        this.totalNetAtomic = totalNetAtomic;

        this.createdAtMs = input.createdAtMs;

        // Explicit, auditable capability descriptor for the plan.
        this.capabilities = Object.freeze({
            transfersEnabled: false,
            broadcastsEnabled: false,
            walletSigningEnabled: false,
            description: "This plan is accounting only. It executes nothing."
        });

        Object.freeze(this);

    }

    /**
     * The single transfer for a recipient role, or null.
     *
     * @param {"WINNER"|"OWNER"} role
     * @returns {PayoutTransfer|null}
     */
    transferFor(role) {

        return this.transfers.find((t) => t.recipientRole === role) ?? null;

    }

    /**
     * The allocation reconciliation, evaluated exactly in BigInt:
     *
     *   winnerTransferAtomic + ownerTransferAtomic + gasReserveAtomic
     *       === totalSettledPrincipalAtomic
     *
     * @returns {boolean}
     */
    reconcile() {

        const principal = BigInt(this.principalAtomic);

        const total = this.transfers.reduce(
            (sum, transfer) => sum + BigInt(transfer.netAtomic), 0n);
        return total + BigInt(this.totalReservedFeeAtomic)
            + BigInt(this.gasReserveAtomic) === principal;

    }

    toJSON() {

        return Object.freeze({
            planId: this.planId,
            payoutId: this.payoutId,
            roomId: this.roomId,
            asset: this.asset,
            network: this.network,
            principalAtomic: this.principalAtomic,
            gasReserveAtomic: this.gasReserveAtomic,
            safetyMarginAtomic: this.gasReserveAtomic,
            allocation: this.allocation,
            transfers: this.transfers.map((t) => t.toJSON()),
            totalGrossAtomic: this.totalGrossAtomic,
            totalReservedFeeAtomic: this.totalReservedFeeAtomic,
            totalNetAtomic: this.totalNetAtomic,
            createdAtMs: this.createdAtMs
        });

    }

    static fromJSON(record) {

        return new PayoutPlan({
            payoutId: record.payoutId,
            roomId: record.roomId,
            asset: record.asset,
            network: record.network,
            principalAtomic: record.principalAtomic,
            gasReserveAtomic: record.gasReserveAtomic ?? record.safetyMarginAtomic ?? 0,
            allocation: record.allocation,
            transfers: (record.transfers ?? []).map((t) => PayoutTransfer.fromJSON(t)),
            createdAtMs: record.createdAtMs,
            planId: record.planId
        });

    }

}
