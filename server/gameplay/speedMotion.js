/**
 * P5.6A — Authoritative SPEED baseline velocities.
 *
 * Wheel: clockwise, baseline 1 rps + 1 rps per held button.
 * Triangle: counter-clockwise at 1.5× |wheel| (opposite sign).
 *
 * Server sign convention: positive ω = CCW (same as SELF_TEST).
 * Therefore clockwise wheel velocity is negative.
 */

export const SPEED_BASE_WHEEL_RPS = 1;

export const SPEED_RPS_PER_HELD_BUTTON = 1;

export const SPEED_TRIANGLE_VELOCITY_RATIO = 1.5;

export const SPEED_RADIANS_PER_REVOLUTION = Math.PI * 2;

/**
 * @param {number} heldButtonCount currently pressed buttons (0..N)
 * @returns {{ wheelAngularVelocity: number, triangleAngularVelocity: number }}
 */
export function computeSpeedVelocities(heldButtonCount) {

    const holds = Math.max(0, Math.floor(Number(heldButtonCount) || 0));

    const wheelRps = SPEED_BASE_WHEEL_RPS
        + (holds * SPEED_RPS_PER_HELD_BUTTON);

    // Clockwise = negative under CCW-positive convention.
    const wheelAngularVelocity = -wheelRps * SPEED_RADIANS_PER_REVOLUTION;

    return {
        wheelAngularVelocity,
        triangleAngularVelocity:
            -SPEED_TRIANGLE_VELOCITY_RATIO * wheelAngularVelocity
    };

}
