/**
 * Phase 4 — Pure, deterministic payout calculator.
 *
 * The calculator is PURE: it accepts explicit inputs and returns a validated
 * `PayoutPlan`. It NEVER sends, broadcasts, signs, deploys, queries a provider,
 * or executes anything, and it stores nothing. A future fee-estimation /
 * execution layer supplies the per-transfer network-fee quotes; this phase
 * never hardcodes a fixed fee and never contacts a provider.
 *
 * APPROVED payout rule (Phase 4 alignment) — the FIXED 95% winner rule:
 *
 *   1. winnerGrossAllocationAtomic = floor(principalAtomic * 95 / 100)
 *      — the winner receives exactly 95% of the total settled principal,
 *      rounded DOWN to a whole nanoton; the rule is a fixed, immutable
 *      business-rule constant (see PayoutAllocationConfig) and is NEVER
 *      supplied or overridden by the caller;
 *   2. ownerGrossAllocationAtomic  = principalAtomic - winnerGrossAllocationAtomic
 *      — the owner receives the exact remainder, including any rounding
 *      remainder produced by step 1;
 *   3. the Safety Margin is PERMANENTLY ZERO — this calculator creates,
 *      reserves, deducts or transfers no reserve of any kind;
 *   4. every financial calculation is exact integer atomic-unit arithmetic
 *      (BigInt); a Number is produced only after a safe-integer bounds check;
 *   5. each outgoing payout represents its own network fee separately, and
 *      that fee is charged ONLY to its own recipient's gross allocation —
 *      never to the other recipient and never to any residue;
 *   6. a fee must be known (quoted), a non-negative integer, and strictly
 *      less than its own recipient's gross allocation when a positive
 *      transfer is required.
 *
 * final reconciliation invariant (exact, in nanotons):
 *   winnerNetPayoutAtomic + ownerNetPayoutAtomic
 *       + winnerNetworkFeeAtomic + ownerNetworkFeeAtomic
 *       === totalSettledPrincipalAtomic
 */

import { randomBytes } from "node:crypto";

import {
    PayoutAllocationConfig
} from "./PayoutAllocationConfig.js";

import { PayoutPlan, PayoutTransfer } from "./PayoutPlan.js";

import {
    PayoutFeeError,
    PayoutValidationError
} from "./LedgerErrors.js";

/**
 * @param {unknown} value
 * @returns {asserts value is number}
 */
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

/**
 * Convert an exact BigInt result back to a safe JavaScript integer, failing
 * closed when the value cannot be represented exactly.
 *
 * @param {bigint} value
 * @param {string} field
 * @returns {number}
 */
function toSafeInteger(value, field) {

    const result = Number(value);

    if (!Number.isSafeInteger(result)) {

        throw new PayoutValidationError(
            `${field} cannot be represented exactly as an integer atomic amount`,
            { field }
        );

    }

    return result;

}

/**
 * Validate a single recipient's network-fee quote and return the quoted fee.
 *
 * The fee is validated INDEPENDENTLY of the other recipient: a missing,
 * unknown, non-integer, negative or stale quote for one party never borrows
 * from, nor is charged to, the other party.
 *
 * @param {"WINNER"|"OWNER"} role
 * @param {number} grossAtomic
 * @param {object} feeQuote
 * @param {{ nowMs: number, maxQuoteAgeMs: number|null }} freshness
 * @returns {{ feeAtomic: number, quotedAtMs: number|null }}
 */
function validateNetworkFee(role, grossAtomic, feeQuote, { nowMs, maxQuoteAgeMs }) {

    if (!feeQuote || typeof feeQuote !== "object") {

        throw new PayoutFeeError(
            "MISSING",
            `network fee for ${role} is required and must be supplied by a `
                + "validated fee-estimation layer",
            { recipientRole: role, grossAtomic }
        );

    }

    const feeAtomic = feeQuote.feeAtomic;

    // A fee must be a known, non-negative integer atomic amount. Zero is a
    // valid, genuinely free transfer; a negative or fractional fee is not.
    if (typeof feeAtomic !== "number"
        || !Number.isSafeInteger(feeAtomic)
        || feeAtomic < 0) {

        throw new PayoutFeeError(
            "INVALID",
            `network fee for ${role} must be a non-negative integer (atomic units)`,
            { recipientRole: role, feeAtomic }
        );

    }

    let quotedAtMs = feeQuote.quotedAtMs ?? null;

    if (quotedAtMs !== null) {

        if (typeof quotedAtMs !== "number"
            || !Number.isInteger(quotedAtMs)
            || quotedAtMs <= 0) {

            throw new PayoutFeeError(
                "INVALID",
                `network fee quote for ${role} must carry a valid quote time`,
                { recipientRole: role, quotedAtMs }
            );

        }

    }

    if (maxQuoteAgeMs !== null && maxQuoteAgeMs !== undefined) {

        if (!Number.isInteger(maxQuoteAgeMs) || maxQuoteAgeMs <= 0) {

            throw new PayoutFeeError(
                "INVALID",
                "maxQuoteAgeMs must be a positive integer when supplied",
                { maxQuoteAgeMs }
            );

        }

        if (quotedAtMs === null || nowMs - quotedAtMs > maxQuoteAgeMs) {

            throw new PayoutFeeError(
                "STALE",
                `network fee quote for ${role} is stale`,
                { recipientRole: role, quotedAtMs, nowMs, maxQuoteAgeMs }
            );

        }

    }

    if (feeAtomic >= grossAtomic) {

        // Reject when the fee is greater than OR equal to the gross allocation.
        // The fee is strictly less than ITS OWN recipient's gross allocation.
        throw new PayoutFeeError(
            "EXCEEDS_GROSS",
            `network fee for ${role} (${feeAtomic}) must be less than the `
                + `recipient's gross allocation (${grossAtomic})`,
            { recipientRole: role, feeAtomic, grossAtomic }
        );

    }

    return { feeAtomic, quotedAtMs };

}

export class RoomPayoutCalculator {

    /**
     * Allocate settled principal into winner / owner gross allocations using
     * the FIXED, approved 95% rule.
     *
     * Pure, deterministic and exact. The winner's gross allocation is computed
     * directly from the total settled principal and the owner's gross
     * allocation is the exact RESIDUAL, both in BigInt so the arithmetic is
     * exact for any room principal:
     *
     *   winnerGrossAllocationAtomic = floor(principalAtomic * 95 / 100)
     *   ownerGrossAllocationAtomic  = principalAtomic - winnerGrossAllocationAtomic
     *   safetyMarginAtomic          = 0 (permanently)
     *
     * The winner is rounded DOWN; the truncation remainder is left for the
     * owner. Because the fixed share is strictly below 100%, the owner residual
     * is always non-negative.
     *
     * @param {number} principalAtomic total settled principal (nanotons)
     * @param {PayoutAllocationConfig|object} [allocation] optional provenance
     * @returns {{ principalAtomic: number, winnerGrossAllocationAtomic: number,
     *   ownerGrossAllocationAtomic: number, safetyMarginAtomic: 0,
     *   allocationRuleId: string }}
     */
    static allocatePrincipal(principalAtomic, allocation) {

        assertPositiveSafeInteger(principalAtomic, "principalAtomic");

        const config = allocation instanceof PayoutAllocationConfig
            ? allocation
            : new PayoutAllocationConfig(allocation ?? {});

        const principal = BigInt(principalAtomic);

        // The winner's gross allocation comes from the FIXED 95% rule, never
        // from a caller input: floor(principalAtomic * 95 / 100), in BigInt.
        const winner = config.winnerGrossAllocationBigInt(principal);

        const owner = principal - winner;

        if (owner < 0n) {

            // Defensive only: the fixed share is below 100%, so the owner
            // residual can never be negative.
            throw new PayoutValidationError(
                "winner gross allocation exceeds the total settled principal "
                    + "(negative owner residual)",
                {
                    principalAtomic,
                    winnerGrossAllocationAtomic:
                        toSafeInteger(winner, "winnerGrossAllocationAtomic"),
                    ownerResidualAtomic: toSafeInteger(owner, "ownerResidualAtomic")
                }
            );

        }

        return Object.freeze({
            principalAtomic,
            winnerGrossAllocationAtomic: toSafeInteger(winner, "winnerGrossAllocationAtomic"),
            ownerGrossAllocationAtomic: toSafeInteger(owner, "ownerGrossAllocationAtomic"),
            // Safety Margin is permanently zero.
            safetyMarginAtomic: 0,
            allocationRuleId: config.ruleId
        });

    }

    /**
     * Compute a validated payout plan from explicit inputs. Sends nothing.
     *
     * The winner's gross allocation is derived from `principalAtomic` by the
     * FIXED, approved 95% rule. No percentage, owner-commission or reserve
     * input is required, and no caller winner amount is accepted.
     *
     * @param {{
     *   payoutId?: string,
     *   roomId: string,
     *   asset: string,
     *   network: string,
     *   principalAtomic: number,
     *   allocation?: PayoutAllocationConfig|object,
     *   winner: { recipientId: string, address: string },
     *   owner: { recipientId: string, address: string },
     *   networkFees: {
     *     winner: { feeAtomic: number, quotedAtMs?: number },
     *     owner?: { feeAtomic: number, quotedAtMs?: number }
     *   },
     *   maxQuoteAgeMs?: number|null,
     *   nowMs: number,
     *   createdAtMs?: number
     * }} input
     * @returns {PayoutPlan}
     */
    static computePlan(input) {

        if (!input || typeof input !== "object") {

            throw new PayoutValidationError("computePlan requires an input object");

        }

        const payoutId = input.payoutId ?? `payout_${randomBytes(9).toString("hex")}`;

        if (typeof payoutId !== "string" || payoutId.trim() === "") {

            throw new PayoutValidationError("payoutId must be a non-empty string");

        }

        if (!input.winner || typeof input.winner !== "object") {

            throw new PayoutValidationError("a winner recipient is required");

        }

        if (!input.owner || typeof input.owner !== "object") {

            throw new PayoutValidationError("an owner recipient is required");

        }

        assertPositiveSafeInteger(input.nowMs, "nowMs");

        // The FIXED, approved 95% winner rule. Nothing is configurable here:
        // no percentage, owner commission or reserve input is required, and no
        // caller may override the rule. `input.allocation`, when present, only
        // carries optional provenance text.
        const allocation = input.allocation instanceof PayoutAllocationConfig
            ? input.allocation
            : new PayoutAllocationConfig(input.allocation ?? {});

        const {
            principalAtomic,
            winnerGrossAllocationAtomic,
            ownerGrossAllocationAtomic
        } = RoomPayoutCalculator.allocatePrincipal(
            input.principalAtomic, allocation);

        const freshness = {
            nowMs: input.nowMs,
            maxQuoteAgeMs: input.maxQuoteAgeMs ?? null
        };

        const transfers = [];

        // Winner payout: its fee is charged to the winner's gross allocation
        // ONLY. A zero-gross allocation produces no transfer at all.
        if (winnerGrossAllocationAtomic > 0) {

            const winnerFee = validateNetworkFee(
                "WINNER",
                winnerGrossAllocationAtomic,
                input.networkFees?.winner,
                freshness);

            transfers.push(new PayoutTransfer({
                recipientRole: "WINNER",
                recipientId: input.winner.recipientId,
                address: input.winner.address,
                grossAtomic: winnerGrossAllocationAtomic,
                reservedFeeAtomic: winnerFee.feeAtomic,
                feeQuote: winnerFee
            }));

        }

        // Owner residual payout: its fee is charged to the owner's gross
        // allocation ONLY — never to the winner and never to any residue.
        // A zero residual produces no transfer at all.
        if (ownerGrossAllocationAtomic > 0) {

            const ownerFee = validateNetworkFee(
                "OWNER",
                ownerGrossAllocationAtomic,
                input.networkFees?.owner,
                freshness);

            transfers.push(new PayoutTransfer({
                recipientRole: "OWNER",
                recipientId: input.owner.recipientId,
                address: input.owner.address,
                grossAtomic: ownerGrossAllocationAtomic,
                reservedFeeAtomic: ownerFee.feeAtomic,
                feeQuote: ownerFee
            }));

        }

        return new PayoutPlan({
            planId: `plan_${payoutId}`,
            payoutId,
            roomId: input.roomId,
            asset: input.asset,
            network: input.network,
            principalAtomic,
            allocation: allocation.toJSON(),
            transfers,
            createdAtMs: input.createdAtMs ?? input.nowMs
        });

    }

}
