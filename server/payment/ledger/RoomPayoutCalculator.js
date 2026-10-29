/**
 * Phase 4 — Pure, deterministic payout calculator.
 *
 * The calculator is PURE: it accepts explicit inputs and returns a validated
 * `PayoutPlan`. It NEVER sends, broadcasts, signs, deploys, queries a provider,
 * or executes anything, and it stores nothing. Optional fee quotes are
 * diagnostic metadata only and are not required to make a payout plan.
 *
 * APPROVED payout rule (Phase 4 alignment) — the FIXED 95% winner rule:
 *
 *   1. winnerGrossAllocationAtomic = floor(principalAtomic * 95 / 100)
 *      — the winner receives exactly 95% of the total settled principal,
 *      rounded DOWN to a whole nanoton; the rule is a fixed, immutable
 *      business-rule constant (see PayoutAllocationConfig) and is NEVER
 *      supplied or overridden by the caller;
 *   2. ownerGrossAllocationAtomic  = floor(principalAtomic * 5 / 100);
 *   3. gasReserveAtomic            = principalAtomic - winner - owner;
 *   4. fee quotes are diagnostic only; source-side TON fees do not reduce
 *      either recipient transfer;
 *   5. every financial calculation is exact integer atomic-unit arithmetic
 *      (BigInt); a Number is produced only after a safe-integer bounds check;
 *   final allocation invariant (exact, in nanotons):
 *   winnerTransfer + ownerTransfer + retainedGasReserve === principal.
 */

import { randomBytes } from "node:crypto";

import {
    PayoutAllocationConfig
} from "./PayoutAllocationConfig.js";

import { PayoutPlan, PayoutTransfer } from "./PayoutPlan.js";

import { PayoutValidationError } from "./LedgerErrors.js";

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
function validateNetworkFee(role, grossAtomic, feeQuote) {
    // Like refunds, recipient gas is frozen into the durable payout plan
    // before any broadcast. Never silently substitute source-paid gas.
    const feeAtomic = feeQuote?.feeAtomic;
    const quotedAtMs = feeQuote?.quotedAtMs;
    if (!Number.isSafeInteger(feeAtomic) || feeAtomic <= 0 || feeAtomic >= grossAtomic) {
        throw new PayoutValidationError("PAYOUT_RECIPIENT_GAS_QUOTE_REQUIRED", {
            role, grossAtomic, feeAtomic: feeAtomic ?? null
        });
    }
    return {
        feeAtomic,
        quotedAtMs: Number.isSafeInteger(quotedAtMs) && quotedAtMs > 0
            ? quotedAtMs : null,
        recipientRole: role,
        diagnosticGrossAtomic: grossAtomic
    };

}

export class RoomPayoutCalculator {

    /**
     * Allocate settled principal into winner / owner gross allocations using
     * the FIXED, approved 95% rule.
     *
     * Pure, deterministic and exact. The winner's gross allocation is computed
     * directly from the total settled principal; the owner receives a fixed
     * 5% share; the remainder is retained by the Room Wallet. BigInt keeps
     * every calculation exact:
     *
     *   winnerGrossAllocationAtomic = floor(principalAtomic * 95 / 100)
     *   ownerGrossAllocationAtomic  = floor(principalAtomic * 5 / 100)
     *   gasReserveAtomic            = principalAtomic - winner - owner
     *
     * Both percentage amounts are rounded DOWN; integer-rounding remainder is
     * included in the retained Room Wallet reserve.
     *
     * @param {number} principalAtomic total settled principal (nanotons)
     * @param {PayoutAllocationConfig|object} [allocation] optional provenance
     * @returns {{ principalAtomic: number, winnerGrossAllocationAtomic: number,
     *   ownerGrossAllocationAtomic: number, gasReserveAtomic: number,
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
        const gasReserve = 0n;

        if (owner < 0n || gasReserve < 0n) {

            // Defensive only: the fixed shares total less than 100%.
            throw new PayoutValidationError(
                "fixed recipient allocations exceed the total settled principal",
                {
                    principalAtomic,
                    winnerGrossAllocationAtomic:
                        toSafeInteger(winner, "winnerGrossAllocationAtomic"),
                    ownerGrossAllocationAtomic: toSafeInteger(owner, "ownerGrossAllocationAtomic"),
                    gasReserveAtomic: toSafeInteger(gasReserve, "gasReserveAtomic")
                }
            );

        }

        return Object.freeze({
            principalAtomic,
            winnerGrossAllocationAtomic: toSafeInteger(winner, "winnerGrossAllocationAtomic"),
            ownerGrossAllocationAtomic: toSafeInteger(owner, "ownerGrossAllocationAtomic"),
            gasReserveAtomic: toSafeInteger(gasReserve, "gasReserveAtomic"),
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
            ownerGrossAllocationAtomic,
            gasReserveAtomic
        } = RoomPayoutCalculator.allocatePrincipal(input.principalAtomic, allocation);

        const transfers = [];

        // Winner gross is 95%; the frozen recipient gas charge is deducted
        // from the transfer, following the existing refund fee policy.
        if (winnerGrossAllocationAtomic > 0) {

            const winnerFee = validateNetworkFee(
                "WINNER",
                winnerGrossAllocationAtomic,
                input.networkFees?.winner);

            transfers.push(new PayoutTransfer({
                recipientRole: "WINNER",
                recipientId: input.winner.recipientId,
                address: input.winner.address,
                grossAtomic: winnerGrossAllocationAtomic,
                reservedFeeAtomic: winnerFee.feeAtomic,
                feeQuote: winnerFee
            }));

        }

        // Owner gross is the remaining 5%; the owner also pays its own gas.
        if (ownerGrossAllocationAtomic > 0) {

            const ownerFee = validateNetworkFee(
                "OWNER",
                ownerGrossAllocationAtomic,
                input.networkFees?.owner);

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
            gasReserveAtomic,
            allocation: allocation.toJSON(),
            transfers,
            createdAtMs: input.createdAtMs ?? input.nowMs
        });

    }

}
