/** Fixed Mainnet allocation copied from the Testnet payout rule. */
export const MAINNET_WINNER_SHARE = Object.freeze({ numerator: 95n, denominator: 100n });
export const MAINNET_OWNER_SHARE = Object.freeze({ numerator: 49n, denominator: 1_000n });
export const MAINNET_RESERVE_SHARE = Object.freeze({ numerator: 1n, denominator: 1_000n });
export const MAINNET_PAYOUT_RULE_ID = "MAINNET_WINNER_95_OWNER_4_9_RESERVE_0_1";

function safeInteger(value, field) {
    const result = Number(value);
    if (!Number.isSafeInteger(result)) throw new RangeError(`${field} exceeds safe integer range`);
    return result;
}

export function calculateMainnetPayout(principalAtomic) {
    if (!Number.isSafeInteger(principalAtomic) || principalAtomic <= 0) {
        throw new TypeError("MAINNET_PAYOUT_PRINCIPAL_INVALID");
    }
    const principal = BigInt(principalAtomic);
    const winnerAtomic = principal * MAINNET_WINNER_SHARE.numerator / MAINNET_WINNER_SHARE.denominator;
    const ownerAtomic = principal * MAINNET_OWNER_SHARE.numerator / MAINNET_OWNER_SHARE.denominator;
    const reserveAtomic = principal - winnerAtomic - ownerAtomic;
    return Object.freeze({
        principalAtomic,
        winnerAtomic: safeInteger(winnerAtomic, "winnerAtomic"),
        ownerAtomic: safeInteger(ownerAtomic, "ownerAtomic"),
        reserveAtomic: safeInteger(reserveAtomic, "reserveAtomic"),
        ruleId: MAINNET_PAYOUT_RULE_ID
    });
}
