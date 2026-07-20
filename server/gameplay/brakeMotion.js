/**
 * P5.7 — Deterministic BRAKE deceleration.
 *
 * Linear curve: ω(t) = ω0 * (1 - t/T) so ω(T) = 0 exactly.
 * Triangle remains 1.5× |wheel| with opposite sign throughout.
 */

import { SPEED_TRIANGLE_VELOCITY_RATIO } from "./speedMotion.js";

export const BRAKE_TRIANGLE_VELOCITY_RATIO = SPEED_TRIANGLE_VELOCITY_RATIO;

/**
 * @param {number} wheelStartOmega rad/s at BRAKE start
 * @param {number} progress 0..1 (0 = start, 1 = complete stop)
 */
export function computeBrakeVelocities(wheelStartOmega, progress) {

    const u = Math.max(0, Math.min(1, Number(progress) || 0));

    const wheelAngularVelocity = wheelStartOmega * (1 - u);

    return {
        wheelAngularVelocity,
        triangleAngularVelocity:
            -BRAKE_TRIANGLE_VELOCITY_RATIO * wheelAngularVelocity
    };

}

/**
 * Exact angle integral of ω(t) = ω0 * (1 - t/T) from t0 to t1 (seconds).
 */
export function integrateLinearBrakeAngle(omega0, t0, t1, durationSec) {

    if (!Number.isFinite(durationSec) || durationSec <= 0) {

        return 0;

    }

    const start = Math.max(0, Math.min(durationSec, t0));

    const end = Math.max(0, Math.min(durationSec, t1));

    if (end <= start) {

        return 0;

    }

    return omega0 * (
        (end - start) - ((end * end) - (start * start)) / (2 * durationSec)
    );

}
