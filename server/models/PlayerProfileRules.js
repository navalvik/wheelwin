export const MIN_PLAYER_AGE = 18;

export const MAX_PLAYER_AGE = 120;

export const ALLOWED_BASE_STAKES = Object.freeze([1, 10]);

/**
 * Authoritative age gate for Page2 Player Setup.
 * Age must be an integer in [MIN_PLAYER_AGE, MAX_PLAYER_AGE].
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
