export const TWO_PI = Math.PI * 2;

export function normalizeAngleRadians(angle) {

    const normalized = angle % TWO_PI;

    return normalized < 0 ? normalized + TWO_PI : normalized;

}
