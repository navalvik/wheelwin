/**
 * Phase 4 — Explicit, FIXED payout allocation rule (FAIL CLOSED).
 *
 * APPROVED, AUTHORITATIVE BUSINESS RULE (Phase 4 alignment):
 *
 *   1. the winner receives exactly 95% of settled principal;
 *   2. the owner receives exactly 5% of settled principal;
 *   3. 0% plus integer-rounding remainder is retained in the Room Wallet
 *      for source-paid TON fees and accumulated wallet balance;
 *   4. quoted and actual network fees never reduce either recipient transfer;
 *   5. all arithmetic is exact integer atomic-unit (nanoton) arithmetic using
 *      BigInt; results are converted to Number only after a safe-integer
 *      bounds check.
 *
 * The APPROVED formula, evaluated in whole nanotons:
 *
 *   winnerGrossAllocationAtomic = floor(totalSettledPrincipalAtomic * 95 / 100)
 *   ownerGrossAllocationAtomic  = floor(totalSettledPrincipalAtomic * 5 / 100)
 *   gasReserveAtomic            = principal - winner - owner
 *
 * This rule is a FIXED, IMMUTABLE BUSINESS-RULE CONSTANT. It is NOT an
 * editable owner fee, NOT a runtime-configurable percentage, and NOT derived
 * from any unverified configuration, owner-commission setting, or forensic
 * snapshot. There is nothing for a caller to configure: the payout calculator
 * never requires a percentage, an owner commission, or a reserve input.
 *
 * The caller NEVER supplies `winnerGrossAllocationAtomic` any more; the winner
 * allocation is always computed from the total settled principal by the rule
 * declared here.
 */

/**
 * The FIXED winner share of the approved rule, as an exact integer ratio.
 * `95 / 100` — expressed with BigInt so every calculation stays exact.
 * This constant is immutable and is the single source of truth for the
 * approved winner payout percentage.
 */
export const WINNER_SHARE_NUMERATOR = 95n;

/** The fixed denominator of the approved winner share (percent basis). */
export const WINNER_SHARE_DENOMINATOR = 100n;

/** The fixed owner share: 5% of the settled principal. */
export const OWNER_SHARE_NUMERATOR = 5n;
export const OWNER_SHARE_DENOMINATOR = 100n;

/**
 * Stable identifier for the approved, fixed winner payout rule. Carried on
 * every payout plan as explicit provenance so an auditor can prove which rule
 * produced the allocation.
 */
export const APPROVED_WINNER_RULE_ID =
    "APPROVED_WINNER_95_OWNER_5_RECIPIENT_PAYS_GAS_RULE";

/**
 * Human-readable description of the approved, fixed rule (provenance). It is
 * frozen and never edited at runtime.
 */
export const APPROVED_WINNER_RULE_TEXT = Object.freeze(
    "winner transfer = floor(totalSettledPrincipalAtomic * 95 / 100); "
    + "owner gross = totalSettledPrincipalAtomic - winner gross; "
    + "each recipient pays their own frozen network-fee charge via gross-minus-fee transfer"
);

/**
 * The approved, FIXED winner-allocation rule for a payout.
 *
 * Immutable value object for the fixed 95% / 5% / retained-remainder rule.
 */
export class PayoutAllocationConfig {

    /**
     * @param {{ allocationSource?: string|null }} [config]
     *   Only optional free-text provenance is accepted; percentages are fixed.
     */
    constructor(config = {}) {

        const source = config
            && typeof config.allocationSource === "string"
            && config.allocationSource.trim() !== ""
            ? config.allocationSource
            : null;

        this.numerator = WINNER_SHARE_NUMERATOR;
        this.denominator = WINNER_SHARE_DENOMINATOR;
        this.ownerNumerator = OWNER_SHARE_NUMERATOR;
        this.ownerDenominator = OWNER_SHARE_DENOMINATOR;
        this.ruleId = APPROVED_WINNER_RULE_ID;
        this.rule = APPROVED_WINNER_RULE_TEXT;
        this.allocationSource = source;

        Object.freeze(this);

    }

    /**
     * The winner's gross allocation for a settled principal, EXACTLY:
     *
     *   winnerGrossAllocationAtomic = floor(principalAtomic * 95 / 100)
     *
     * computed in BigInt and rounded DOWN toward zero. Division truncates
     * toward zero, which for the always-positive settled principal is exactly
     * the required floor. Integer-rounding remainder stays in the Room Wallet
     * reserve rather than increasing either recipient share.
     *
     * @param {number|bigint} principalAtomic total settled principal (nanotons)
     * @returns {bigint} the winner gross allocation, in nanotons
     */
    winnerGrossAllocationBigInt(principalAtomic) {

        const principal = BigInt(principalAtomic);

        // (principal * 95) / 100 with BigInt truncation == floor for principal > 0.
        return (principal * WINNER_SHARE_NUMERATOR) / WINNER_SHARE_DENOMINATOR;

    }

    ownerGrossAllocationBigInt(principalAtomic) {
        return BigInt(principalAtomic) - this.winnerGrossAllocationBigInt(principalAtomic);
    }

    /**
     * Serialize the fixed rule with provenance for a payout plan.
     *
     * @returns {Readonly<{
     *   ruleId: string, numerator: number, denominator: number,
     *   rule: string, allocationSource: string|null }>}
     */
    toJSON() {

        return Object.freeze({
            ruleId: this.ruleId,
            numerator: Number(WINNER_SHARE_NUMERATOR),
            denominator: Number(WINNER_SHARE_DENOMINATOR),
            ownerNumerator: Number(OWNER_SHARE_NUMERATOR),
            ownerDenominator: Number(OWNER_SHARE_DENOMINATOR),
            rule: this.rule,
            allocationSource: this.allocationSource
        });

    }

    /**
     * Rebuild the fixed rule from a stored record. The winner share is ALWAYS
     * the fixed `95 / 100` constant; only the provenance text is restored.
     *
     * @param {object} record
     * @returns {PayoutAllocationConfig}
     */
    static fromJSON(record) {

        return new PayoutAllocationConfig({
            allocationSource: record?.allocationSource ?? null
        });

    }

    /** The single, fixed allocation rule. */
    static approved() {

        return new PayoutAllocationConfig({});

    }

}
