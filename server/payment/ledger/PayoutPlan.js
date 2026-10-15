/**
 * Phase 4 — Validated payout plan value object.
 *
 * A payout plan is a pure, deterministic description of how confirmed principal
 * is allocated and how each OUTGOING transfer nets out after its own network
 * fee. It sends, signs, broadcasts and contacts nothing.
 *
 * Approved payout rules enforced here:
 *   - the winner's gross allocation is the explicit authoritative amount, the
 *     owner's gross allocation is the exact residual (principal - winner), and
 *     the Safety Margin is permanently zero (this model has no reserve at all);
 *   - each outgoing payout represents its own network fee separately;
 *   - the winner payout fee is charged ONLY against the winner's gross
 *     allocation, and the owner payout fee is charged ONLY against the owner's
 *     gross allocation;
 *   - net transfer = that recipient's gross - the fee allocated to them;
 *   - a recipient's fee is NEVER charged against another recipient's funds.
 *
 * The final reconciliation invariant
 *
 *   winnerNetPayoutAtomic + ownerNetPayoutAtomic
 *       + winnerNetworkFeeAtomic + ownerNetworkFeeAtomic
 *       === totalSettledPrincipalAtomic
 *
 * proves that no cross-charging and no silent reserve is possible. There is no
 * reserve term.
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
 * A network fee may be ZERO (a genuinely free transfer); it must never be
 * negative, and it must be strictly less than the recipient's own gross
 * allocation whenever a positive transfer is required.
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

            // A transfer must leave a positive net for the recipient; a net of
            // zero (fee == gross) would silently burn the recipient's gross to
            // fees and cannot be sent as a valid native TON transfer.
            throw new PayoutValidationError(
                "reserved network fee must be strictly less than the gross allocation",
                { recipientRole, grossAtomic, reservedFeeAtomic }
            );

        }

        this.recipientRole = recipientRole;

        this.recipientId = recipientId;

        this.address = address;

        this.grossAtomic = grossAtomic;

        this.reservedFeeAtomic = reservedFeeAtomic;

        // net = recipient's gross - the fee allocated to THIS recipient only.
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

        const totalGrossAtomic = input.transfers.reduce(
            (sum, transfer) => sum + transfer.grossAtomic, 0);

        const totalReservedFeeAtomic = input.transfers.reduce(
            (sum, transfer) => sum + transfer.reservedFeeAtomic, 0);

        const totalNetAtomic = input.transfers.reduce(
            (sum, transfer) => sum + transfer.netAtomic, 0);

        // THE core accounting invariant (approved final reconciliation):
        //   every nanotons of net paid out + every nanotons of network fee
        //   === the total settled principal. No reserve, no safety margin.
        const netPlusFees = totalNetAtomic + totalReservedFeeAtomic;

        if (netPlusFees !== input.principalAtomic) {

            throw new PayoutValidationError(
                "payout plan must exactly account for settled principal "
                    + "(winner net + owner net + winner fee + owner fee "
                    + "!== principal)",
                {
                    principalAtomic: input.principalAtomic,
                    totalNetAtomic,
                    totalReservedFeeAtomic,
                    netPlusFees
                }
            );

        }

        this.planId = input.planId ?? `plan_${input.payoutId}`;

        this.payoutId = input.payoutId;

        this.roomId = input.roomId;

        this.asset = input.asset;

        this.network = input.network;

        this.principalAtomic = input.principalAtomic;

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
     * The approved final reconciliation, evaluated exactly in BigInt:
     *
     *   winnerNetPayoutAtomic + ownerNetPayoutAtomic
     *       + winnerNetworkFeeAtomic + ownerNetworkFeeAtomic
     *       === totalSettledPrincipalAtomic
     *
     * @returns {boolean}
     */
    reconcile() {

        const principal = BigInt(this.principalAtomic);

        const total = this.transfers.reduce(
            (sum, transfer) =>
                sum + BigInt(transfer.netAtomic) + BigInt(transfer.reservedFeeAtomic),
            0n);

        return total === principal;

    }

    toJSON() {

        return Object.freeze({
            planId: this.planId,
            payoutId: this.payoutId,
            roomId: this.roomId,
            asset: this.asset,
            network: this.network,
            principalAtomic: this.principalAtomic,
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
            allocation: record.allocation,
            transfers: (record.transfers ?? []).map((t) => PayoutTransfer.fromJSON(t)),
            createdAtMs: record.createdAtMs,
            planId: record.planId
        });

    }

}
