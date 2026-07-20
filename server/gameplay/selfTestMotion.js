/**
 * P5.5 — Deterministic SELF_TEST motion parameters.
 *
 * Wheel: exactly 60° counter-clockwise over the full phase duration.
 * Triangle: clockwise at 1.5× wheel angular velocity (opposite direction).
 * Constant velocity — no acceleration, no braking.
 */

export const SELF_TEST_WHEEL_ROTATION_DEG = 60;

export const SELF_TEST_WHEEL_ROTATION_RAD = (SELF_TEST_WHEEL_ROTATION_DEG * Math.PI) / 180;

export const SELF_TEST_TRIANGLE_VELOCITY_RATIO = 1.5;

export function computeSelfTestVelocities(durationMs) {

    const durationSec = Number(durationMs) / 1000;

    if (!Number.isFinite(durationSec) || durationSec <= 0) {

        return {
            wheelAngularVelocity: 0,
            triangleAngularVelocity: 0
        };

    }

    const wheelAngularVelocity = SELF_TEST_WHEEL_ROTATION_RAD / durationSec;

    return {
        wheelAngularVelocity,
        triangleAngularVelocity:
            -SELF_TEST_TRIANGLE_VELOCITY_RATIO * wheelAngularVelocity
    };

}
