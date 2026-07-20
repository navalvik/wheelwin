import { GAME_STATES } from "../GameState";

import { BUTTON_STATES } from "../centralButton/ButtonState";

import { isServerAuthoritative } from "../gameAuthority";

import {
    BASE_WHEEL_SPEED_DEG,
    BRAKE_PRESS_DECELERATION_BOOST,
    DEFAULT_TRIANGLE_DECELERATION,
    DEFAULT_WHEEL_DECELERATION,
    MAX_DELTA_TIME_SECONDS,
    SPEED_PRESS_SPEED_BOOST,
    TRIANGLE_SPEED_MULTIPLIER,
    normalizeAngleDegrees
} from "./physicsUtils";

export class PhysicsEngine {

    constructor() {

        this.reset();

        this._loopActive = false;

        this._rafId = null;

        this._lastTimestamp = null;

        this._onFrame = null;

        this._isBraking = false;

        this._remainingBrakeTime = null;

    }

    reset() {

        this.wheelAngle = 0;

        this.triangleAngle = 0;

        this.wheelSpeed = 0;

        this.triangleSpeed = 0;

        this.wheelAcceleration = 0;

        this.wheelDeceleration = DEFAULT_WHEEL_DECELERATION;

        this.triangleAcceleration = 0;

        this.triangleDeceleration = DEFAULT_TRIANGLE_DECELERATION;

        this.elapsedTime = 0;

        this._isBraking = false;

        this._remainingBrakeTime = null;

    }

    prepare() {

        // C5.9B — never invent angles/speeds while the server owns gameplay.
        if (isServerAuthoritative()) {

            return;

        }

        this.wheelAngle = 0;

        this.triangleAngle = 0;

        this.wheelSpeed = BASE_WHEEL_SPEED_DEG;

        this.triangleSpeed = BASE_WHEEL_SPEED_DEG * TRIANGLE_SPEED_MULTIPLIER;

        this.wheelAcceleration = 0;

        this.triangleAcceleration = 0;

        this.elapsedTime = 0;

        this._isBraking = false;

    }

    setWheelSpeed(speed) {

        this.wheelSpeed = Math.max(0, speed);

    }

    setTriangleSpeed(speed) {

        this.triangleSpeed = Math.max(0, speed);

    }

    setWheelAcceleration(value) {

        this.wheelAcceleration = value;

    }

    setWheelDeceleration(value) {

        this.wheelDeceleration = Math.max(0, value);

    }

    setTriangleAcceleration(value) {

        this.triangleAcceleration = value;

    }

    setTriangleDeceleration(value) {

        this.triangleDeceleration = Math.max(0, value);

    }

    setBraking(enabled) {

        this._isBraking = enabled;

    }

    isBraking() {

        return this._isBraking;

    }

    isLoopActive() {

        return this._loopActive;

    }

    getWheelAngle() {

        return this.wheelAngle;

    }

    getTriangleAngle() {

        return this.triangleAngle;

    }

    getSnapshot() {

        return {
            wheelAngle: this.wheelAngle,
            triangleAngle: this.triangleAngle,
            wheelSpeed: this.wheelSpeed,
            triangleSpeed: this.triangleSpeed,
            elapsedTime: this.elapsedTime,
            isBraking: this._isBraking
        };

    }

    writeSnapshot(target) {

        target.wheelAngle = this.wheelAngle;

        target.triangleAngle = this.triangleAngle;

        target.wheelSpeed = this.wheelSpeed;

        target.triangleSpeed = this.triangleSpeed;

        target.elapsedTime = this.elapsedTime;

        target.isBraking = this._isBraking;

        return target;

    }

    applyServerUpdate(payload = {}) {

        if (payload.wheelAngle !== undefined) {

            this.wheelAngle = normalizeAngleDegrees(payload.wheelAngle);

        }

        if (payload.triangleAngle !== undefined) {

            this.triangleAngle = normalizeAngleDegrees(payload.triangleAngle);

        }

        if (payload.wheelSpeed !== undefined) {

            this.wheelSpeed = Math.max(0, payload.wheelSpeed);

        } else if (payload.angularVelocity !== undefined) {

            this.wheelSpeed = Math.abs(
                payload.angularVelocity * (180 / Math.PI)
            );

        }

        if (payload.triangleSpeed !== undefined) {

            this.triangleSpeed = Math.max(0, payload.triangleSpeed);

        } else if (payload.triangleAngularVelocity !== undefined) {

            this.triangleSpeed = Math.abs(
                payload.triangleAngularVelocity * (180 / Math.PI)
            );

        }

        if (payload.elapsedTime !== undefined) {

            this.elapsedTime = Math.max(0, payload.elapsedTime);

        } else if (payload.simulationTime !== undefined) {

            this.elapsedTime = Math.max(0, payload.simulationTime / 1000);

        }

        if (payload.wheelAcceleration !== undefined) {

            this.wheelAcceleration = payload.wheelAcceleration;

        } else if (payload.angularAcceleration !== undefined) {

            this.wheelAcceleration = payload.angularAcceleration * (180 / Math.PI);

        }

        if (payload.isBraking !== undefined) {

            this._isBraking = Boolean(payload.isBraking);

        }

    }

    restoreSessionSnapshot(snapshot = {}) {

        const physics = snapshot.physics || snapshot;

        if (physics.wheelAngle !== undefined) {

            this.wheelAngle = normalizeAngleDegrees(physics.wheelAngle);

        }

        if (physics.triangleAngle !== undefined) {

            this.triangleAngle = normalizeAngleDegrees(physics.triangleAngle);

        }

        if (physics.currentWheelSpeed !== undefined) {

            this.wheelSpeed = Math.max(0, physics.currentWheelSpeed);

        } else if (physics.wheelSpeed !== undefined) {

            this.wheelSpeed = Math.max(0, physics.wheelSpeed);

        }

        if (physics.triangleSpeed !== undefined) {

            this.triangleSpeed = Math.max(0, physics.triangleSpeed);

        }

        if (physics.elapsedTime !== undefined) {

            this.elapsedTime = Math.max(0, physics.elapsedTime);

        }

        if (physics.isBraking !== undefined) {

            this._isBraking = Boolean(physics.isBraking);

        }

        if (physics.remainingBrakeTime !== undefined) {

            this._remainingBrakeTime = Math.max(0, physics.remainingBrakeTime);

        }

    }

    getRemainingBrakeTime() {

        return this._remainingBrakeTime ?? null;

    }

    update(deltaTime) {

        const dt = Math.max(0, Math.min(deltaTime, MAX_DELTA_TIME_SECONDS));

        if (dt <= 0) {

            return;

        }

        this.elapsedTime += dt;

        this._updateWheelSpeed(dt);

        this._updateTriangleSpeed(dt);

        this.wheelAngle = normalizeAngleDegrees(
            this.wheelAngle + (this.wheelSpeed * dt)
        );

        this.triangleAngle = normalizeAngleDegrees(
            this.triangleAngle - (this.triangleSpeed * dt)
        );

    }

    _updateWheelSpeed(deltaTime) {

        if (this._isBraking) {

            this.wheelSpeed = Math.max(
                0,
                this.wheelSpeed - (this.wheelDeceleration * deltaTime)
            );

            return;

        }

        if (this.wheelAcceleration !== 0) {

            this.wheelSpeed = Math.max(
                0,
                this.wheelSpeed + (this.wheelAcceleration * deltaTime)
            );

        }

    }

    _updateTriangleSpeed(deltaTime) {

        if (this._isBraking) {

            this.triangleSpeed = Math.max(
                0,
                this.triangleSpeed - (this.triangleDeceleration * deltaTime)
            );

            return;

        }

        if (this.triangleAcceleration !== 0) {

            this.triangleSpeed = Math.max(
                0,
                this.triangleSpeed + (this.triangleAcceleration * deltaTime)
            );

        }

    }

    start(onFrame) {

        if (this._loopActive) {

            this._onFrame = onFrame;

            return;

        }

        this._loopActive = true;

        this._onFrame = onFrame;

        this._lastTimestamp = null;

        this._tick = (timestamp) => {

            if (!this._loopActive) {

                return;

            }

            if (this._lastTimestamp !== null) {

                const deltaTime = (timestamp - this._lastTimestamp) / 1000;

                this.update(deltaTime);

                if (this._onFrame) {

                    this._onFrame(this.getSnapshot());

                }

            }

            this._lastTimestamp = timestamp;

            this._rafId = requestAnimationFrame(this._tick);

        };

        this._rafId = requestAnimationFrame(this._tick);

    }

    stop() {

        this._loopActive = false;

        this._lastTimestamp = null;

        if (this._rafId !== null) {

            cancelAnimationFrame(this._rafId);

            this._rafId = null;

        }

    }

    handleGameState(gameState) {

        // C5.9B — apply-only under Server Authority. Stop any local loop;
        // do not prepare, brake-init, or invent velocity from GAME_STATE.
        if (isServerAuthoritative()) {

            this.stop();

            return;

        }

        switch (gameState) {

            case GAME_STATES.READY:
            case GAME_STATES.COUNTDOWN:

                this.stop();

                break;

            case GAME_STATES.SELF_TEST:

                this.prepare();

                this.stop();

                break;

            case GAME_STATES.SPEED:

                this.setBraking(false);

                if (this.wheelSpeed <= 0) {

                    this.prepare();

                }

                break;

            case GAME_STATES.BRAKE:

                this.setBraking(true);

                break;

            case GAME_STATES.RESULT:

                this.stop();

                break;

            default:

                break;

        }

    }

    shouldRunLoop(gameState) {

        return gameState === GAME_STATES.SPEED
            || gameState === GAME_STATES.BRAKE;

    }

    handleButtonEvent(event) {

        if (!event || event.type !== "release") {

            return;

        }

        switch (event.buttonState) {

            case BUTTON_STATES.SPEED:

                this.wheelSpeed += SPEED_PRESS_SPEED_BOOST;

                this.triangleSpeed += (
                    SPEED_PRESS_SPEED_BOOST * TRIANGLE_SPEED_MULTIPLIER
                );

                break;

            case BUTTON_STATES.BRAKE:

                this.wheelDeceleration += BRAKE_PRESS_DECELERATION_BOOST;

                this.triangleDeceleration += BRAKE_PRESS_DECELERATION_BOOST;

                break;

            default:

                break;

        }

    }

}
