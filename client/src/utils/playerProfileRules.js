export const MIN_PLAYER_AGE = 18;

export const MAX_PLAYER_AGE = 120;

export const ALLOWED_BASE_STAKES = Object.freeze([1, 10]);

/**
 * Client-side mirror of server PlayerProfileRules age gate.
 * Continue on Page2 stays disabled while this returns false.
 */
export function isValidPlayerAge(age) {

    const value = typeof age === "number" ? age : Number(age);

    return Number.isInteger(value)
        && value >= MIN_PLAYER_AGE
        && value <= MAX_PLAYER_AGE;

}

export function isAllowedBaseStake(stake) {

    const value = typeof stake === "number" ? stake : Number(stake);

    return ALLOWED_BASE_STAKES.includes(value);

}

export function calculatePaymentGram(baseStake, sectorCount = 1) {

    const stake = Number(baseStake);

    if (!Number.isFinite(stake) || stake <= 0) {

        return 0;

    }

    // Authoritative Page2 preview (mirrors server PrizeCalculator):
    // first sector = 1 × BaseStake; second sector = 1.5 × BaseStake.
    if (Number(sectorCount) === 2) {

        return stake + (stake * 1.5);

    }

    return stake;

}
