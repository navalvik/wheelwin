import { normalizeAngleRadians } from "../physics/physicsMath.js";

const WHEEL_ORIGIN_RADIANS = -Math.PI / 2;

const TWO_PI = Math.PI * 2;

export class GeometryAdapter {

    constructor({ angleToleranceRadians }) {

        this._angleToleranceRadians = angleToleranceRadians;

    }

    resolveSectorIndex({
        finalWheelAngleRadians,
        triangleAngleDegrees,
        sectorCount
    }) {

        if (!Number.isFinite(finalWheelAngleRadians)) {

            throw new Error("Final wheel angle is invalid");

        }

        if (!Number.isInteger(sectorCount) || sectorCount <= 0) {

            throw new Error("Sector count is invalid");

        }

        const sectorAngle = TWO_PI / sectorCount;

        const pointerRadians = this._degreesToRadians(triangleAngleDegrees)
            + WHEEL_ORIGIN_RADIANS;

        const wheelStartRadians = WHEEL_ORIGIN_RADIANS + finalWheelAngleRadians;

        let localAngle = normalizeAngleRadians(pointerRadians - wheelStartRadians);

        if (this._isNearBoundary(localAngle, sectorAngle)) {

            localAngle = normalizeAngleRadians(
                localAngle + this._angleToleranceRadians
            );

        }

        const sectorIndex = Math.floor(localAngle / sectorAngle);

        return Math.min(Math.max(sectorIndex, 0), sectorCount - 1);

    }

    _degreesToRadians(degrees) {

        return degrees * (Math.PI / 180);

    }

    _isNearBoundary(localAngle, sectorAngle) {

        const remainder = localAngle % sectorAngle;

        const distanceToBoundary = Math.min(
            remainder,
            sectorAngle - remainder
        );

        return distanceToBoundary <= this._angleToleranceRadians;

    }

}
