/**
 * Phase 4 — Explicit currency / denomination mapping (native TON).
 *
 * D1 — integer atomic-unit amounts only. Conversions are integer multiplies /
 * divisions (never floating-point). Percent allocation in the payout layer uses
 * BigInt so even large room principals stay exact.
 *
 * D2 — the display denomination (`Gram`) is kept strictly separate from the
 * canonical asset identifier (`TON`). Per the Phase 4 brief the mapping is
 * explicit:
 *     1 Gram = 1 TON  = 1_000_000_000 nanotons
 *     10 Gram = 10 TON = 10_000_000_000 nanotons
 * The atomic value always comes from a configured `atomicUnitsPerUnit`; it is
 * never assumed, and a missing/invalid mapping fails closed.
 *
 * No wallet secret, provider endpoint, or credential is ever referenced here.
 */

import {
    CANONICAL_TON_ASSET,
    GRAM_DISPLAY_SYMBOL,
    NANOTONS_PER_TON,
    BASE_STAKE_TIERS
} from "./LedgerConstants.js";

import {
    LedgerEntryError
} from "./LedgerErrors.js";

/**
 * @param {unknown} value
 * @returns {asserts value is number}
 */
function assertPositiveSafeInteger(value, field) {

    if (typeof value !== "number"
        || !Number.isSafeInteger(value)
        || value <= 0) {

        throw new LedgerEntryError(
            `${field} must be a positive safe integer`,
            { field, value }
        );

    }

}

export class CurrencyMapping {

    constructor({
        asset = CANONICAL_TON_ASSET,
        symbol = GRAM_DISPLAY_SYMBOL,
        network,
        atomicUnitsPerUnit = NANOTONS_PER_TON
    }) {

        if (typeof asset !== "string" || asset.trim() === "") {

            throw new LedgerEntryError("asset must be a non-empty string");

        }

        if (typeof symbol !== "string" || symbol.trim() === "") {

            throw new LedgerEntryError("symbol must be a non-empty string");

        }

        if (typeof network !== "string" || network.trim() === "") {

            throw new LedgerEntryError("network must be a non-empty string");

        }

        assertPositiveSafeInteger(atomicUnitsPerUnit, "atomicUnitsPerUnit");

        this.asset = asset;

        this.symbol = symbol;

        this.network = network;

        this.atomicUnitsPerUnit = atomicUnitsPerUnit;

        Object.freeze(this);

    }

    /**
     * The canonical native-TON mapping for a network. Explicit by construction:
     * 1 Gram display unit == 1 TON == `NANOTONS_PER_TON` nanotons.
     *
     * @param {{ network: string, symbol?: string, atomicUnitsPerUnit?: number }} options
     * @returns {CurrencyMapping}
     */
    static nativeTon(options = {}) {

        const { network, symbol, atomicUnitsPerUnit } = options;

        if (typeof network !== "string" || network.trim() === "") {

            throw new LedgerEntryError(
                "nativeTon requires an explicit network"
            );

        }

        return new CurrencyMapping({
            asset: CANONICAL_TON_ASSET,
            symbol: symbol ?? GRAM_DISPLAY_SYMBOL,
            network,
            atomicUnitsPerUnit: atomicUnitsPerUnit ?? NANOTONS_PER_TON
        });

    }

    /**
     * Integer conversion: display units (e.g. Grams) -> atomic units (nanotons).
     *
     * @param {number} displayUnits
     * @returns {number}
     */
    toAtomicUnits(displayUnits) {

        assertPositiveSafeInteger(displayUnits, "displayUnits");

        const atomic = displayUnits * this.atomicUnitsPerUnit;

        if (!Number.isSafeInteger(atomic)) {

            throw new LedgerEntryError(
                "converted atomic amount exceeds safe integer range",
                { displayUnits, atomicUnitsPerUnit: this.atomicUnitsPerUnit }
            );

        }

        return atomic;

    }

    /**
     * Integer conversion: atomic units (nanotons) -> display units (Grams),
     * accepted only for exact multiples.
     *
     * @param {number} atomicUnits
     * @returns {number}
     */
    toDisplayUnits(atomicUnits) {

        assertPositiveSafeInteger(atomicUnits, "atomicUnits");

        const units = atomicUnits / this.atomicUnitsPerUnit;

        if (!Number.isInteger(units)) {

            throw new LedgerEntryError(
                "atomic amount is not an exact multiple of the denomination",
                { atomicUnits, atomicUnitsPerUnit: this.atomicUnitsPerUnit }
            );

        }

        return units;

    }

    /**
     * Resolve a player-facing base-stake label to its exact atomic amount.
     *
     * Returns `null` for an unknown label — the ledger never invents a stake
     * amount. A missing/contradictory stake value must reject the plan.
     *
     * @param {string} label
     * @returns {{ label: string, displayUnits: number, atomicUnits: number }|null}
     */
    resolveStakeTier(label) {

        if (typeof label !== "string") {

            return null;

        }

        const tier = BASE_STAKE_TIERS.find((entry) => entry.label === label);

        if (!tier) {

            return null;

        }

        return Object.freeze({
            label: tier.label,
            displayUnits: tier.displayUnits,
            atomicUnits: this.toAtomicUnits(tier.displayUnits)
        });

    }

    /**
     * Atomic amount for a base-stake label. Fails closed when the label is not
     * one of the configured player-facing stakes.
     *
     * @param {string} label
     * @returns {number}
     */
    requireStakeTierAtomic(label) {

        const resolved = this.resolveStakeTier(label);

        if (!resolved) {

            throw new LedgerEntryError(
                "unknown base stake label: refusing to invent an amount",
                { label, knownLabels: BASE_STAKE_TIERS.map((t) => t.label) }
            );

        }

        return resolved.atomicUnits;

    }

    toJSON() {

        return Object.freeze({
            asset: this.asset,
            symbol: this.symbol,
            network: this.network,
            atomicUnitsPerUnit: this.atomicUnitsPerUnit
        });

    }

}
