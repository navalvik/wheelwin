export const DEGREES_PER_REVOLUTION = 360;

export const BASE_WHEEL_SPEED_DEG = 360;

export const TRIANGLE_SPEED_MULTIPLIER = 1.5;

export const DEFAULT_WHEEL_DECELERATION = 180;

export const DEFAULT_TRIANGLE_DECELERATION = 270;

export const MAX_DELTA_TIME_SECONDS = 0.05;

export const SPEED_PRESS_SPEED_BOOST = 45;

export const BRAKE_PRESS_DECELERATION_BOOST = 30;

export function normalizeAngleDegrees(angleDegrees) {

    const normalized = angleDegrees % DEGREES_PER_REVOLUTION;

    return normalized < 0
        ? normalized + DEGREES_PER_REVOLUTION
        : normalized;

}

export function degreesToRadians(angleDegrees) {

    return angleDegrees * (Math.PI / 180);

}
