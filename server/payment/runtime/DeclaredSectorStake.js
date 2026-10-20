import { isAllowedBaseStake } from "../../models/PlayerProfileRules.js";
import { NANOTONS_PER_TON } from "../ledger/index.js";

/**
 * Derive the player's required stake from the server-validated Page2 profile.
 *
 * Pricing rule:
 *   - first sector: 1 × base stake
 *   - second sector: an additional 1.5 × base stake
 *
 * The result is returned in atomic native-TON units (nanotons), never as a
 * floating-point display amount. For example, baseStake=1 and sectorCount=2
 * produces 2_500_000_000 nanotons under the canonical 1 Gram = 1 TON mapping.
 *
 * This function does not prepare payment intents, select a wallet, or enable
 * live payment acceptance. Callers must obtain the profile from trusted server
 * state and must still respect the payment lifecycle availability gate.
 */
export function calculateDeclaredSectorStakeAtomic({
    baseStake,
    sectorCount,
    atomicUnitsPerUnit = NANOTONS_PER_TON
} = {}) {
    const stake = typeof baseStake === "number" ? baseStake : Number(baseStake);
    const sectors = typeof sectorCount === "number" ? sectorCount : Number(sectorCount);

    if (!isAllowedBaseStake(stake)) {
        throw new TypeError("baseStake must be one of the server-approved stake tiers");
    }

    if (sectors !== 1 && sectors !== 2) {
        throw new TypeError("sectorCount must be 1 or 2");
    }

    if (!Number.isSafeInteger(atomicUnitsPerUnit) || atomicUnitsPerUnit <= 0) {
        throw new TypeError("atomicUnitsPerUnit must be a positive safe integer");
    }

    // Work in half-units so the 2.5× two-sector stake never uses floating point.
    const halfUnitMultiplier = sectors === 1 ? 2 : 5;
    const numerator = stake * halfUnitMultiplier * atomicUnitsPerUnit;

    if (!Number.isSafeInteger(numerator) || numerator % 2 !== 0) {
        throw new RangeError("declared stake cannot be represented exactly in atomic units");
    }

    const amountAtomic = numerator / 2;
    if (!Number.isSafeInteger(amountAtomic) || amountAtomic <= 0) {
        throw new RangeError("declared stake exceeds the safe atomic-unit range");
    }

    return amountAtomic;
}
