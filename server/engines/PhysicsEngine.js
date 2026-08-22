import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { computeSelfTestVelocities } from "../gameplay/selfTestMotion.js";
import { computeSpeedVelocities } from "../gameplay/speedMotion.js";
import {
    computeBrakeVelocities,
    integrateLinearBrakeAngle
} from "../gameplay/brakeMotion.js";
import { DEFAULT_PHYSICS_PARAMETERS } from "./physics/PhysicsParameters.js";
import {
    canTransitionPhysicsState,
    PHYSICS_SIMULATION_STATE
} from "./physics/PhysicsSimulationState.js";
import { normalizeAngleRadians } from "./physics/physicsMath.js";

const DEGREES_TO_RADIANS = Math.PI / 180;

export class PhysicsEngine {

    constructor({ logger, eventBus, gameClock, metricsService = null }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._gameClock = gameClock;

        this._metricsService = metricsService;

        this._simulations = new Map();

        this._infrastructureHandlers = [];

        this._initialized = false;

    }

    initialize() {

        const shutdownHandler = () => {

            this._handleServerShutdown();

        };

        this._eventBus.subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            shutdownHandler
        );

        this._infrastructureHandlers.push({
            event: EVENT_TYPES.SERVER_SHUTDOWN,
            handler: shutdownHandler
        });

        this._initialized = true;

    }

    shutdown() {

        for (const gameId of this._simulations.keys()) {

            this.removeSimulation(gameId);

        }

        for (const subscription of this._infrastructureHandlers) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._infrastructureHandlers = [];

        this._initialized = false;

    }

    createSimulation(gameId, parameters = {}) {

        this._assertInitialized();

        if (!gameId) {

            this._logger.error("Simulation creation failed: gameId is required");

            return null;

        }

        if (this._simulations.has(gameId)) {

            this._logger.error(
                `Simulation creation failed: simulation already exists (${gameId})`
            );

            return null;

        }

        const physicsParameters = {
            ...DEFAULT_PHYSICS_PARAMETERS,
            ...parameters
        };

        const simulation = {
            gameId,
            parameters: physicsParameters,
            runtime: {
                angle: 0,
                triangleAngle: 0,
                angularVelocity: 0,
                triangleAngularVelocity: 0,
                angularAcceleration: 0,
                state: PHYSICS_SIMULATION_STATE.CREATED,
                braking: false,
                selfTestActive: false,
                speedActive: false,
                brakeActive: false,
                brakeDurationMs: 0,
                brakeElapsedMs: 0,
                brakeStartWheelOmega: 0,
                physicsStoppedEmitted: false,
                simulationTimeMs: 0
            },
            commandLog: []
        };

        this._simulations.set(gameId, simulation);

        this._logger.info("Simulation Created");

        return this.getSimulation(gameId);

    }

    startSimulation(gameId) {

        this._assertInitialized();

        const simulation = this._getSimulationOrLog(gameId, "start");

        if (!simulation) {

            return null;

        }

        if (!this._transitionState(
            simulation,
            PHYSICS_SIMULATION_STATE.RUNNING
        )) {

            this._logger.error(
                `Simulation start failed: invalid state (${simulation.runtime.state})`
            );

            return null;

        }

        simulation.runtime.braking = false;

        simulation.runtime.angularAcceleration = 0;

        this._logger.info("Simulation Started");

        this._emit(EVENT_TYPES.PHYSICS_STARTED, this._createPhysicsPayload(simulation));

        return this.getSimulation(gameId);

    }

    updateSimulation(gameId, deltaTime) {

        this._assertInitialized();

        const simulation = this._getSimulationOrLog(gameId, "update");

        if (!simulation) {

            return null;

        }

        if (deltaTime < 0) {

            this._logger.error(
                `Simulation update failed: negative deltaTime (${deltaTime})`
            );

            return null;

        }

        if (simulation.runtime.state !== PHYSICS_SIMULATION_STATE.RUNNING
            && simulation.runtime.state !== PHYSICS_SIMULATION_STATE.BRAKING) {

            this._logger.error(
                `Simulation update failed: simulation is not active (${simulation.runtime.state})`
            );

            return null;

        }

        const stepMs = simulation.parameters.fixedSimulationStepMs;

        let remainingMs = deltaTime;

        const tickStartedAt = this._metricsService?.isEnabled()
            ? performance.now()
            : 0;

        while (remainingMs > 0) {

            const stepDurationMs = remainingMs >= stepMs
                ? stepMs
                : remainingMs;

            this._integrateStep(simulation, stepDurationMs);

            remainingMs -= stepDurationMs;

            if (simulation.runtime.state === PHYSICS_SIMULATION_STATE.STOPPED) {

                break;

            }

        }

        simulation.runtime.simulationTimeMs += deltaTime;

        if (this._metricsService?.isEnabled()) {

            this._metricsService.record(
                "physics.tick",
                performance.now() - tickStartedAt
            );

        }

        if (simulation.runtime.state === PHYSICS_SIMULATION_STATE.RUNNING
            || simulation.runtime.state === PHYSICS_SIMULATION_STATE.BRAKING) {

            this._emit(
                EVENT_TYPES.PHYSICS_UPDATED,
                this._createPhysicsPayload(simulation)
            );

        }

        return this.getSimulation(gameId);

    }

    /**
     * Seed authoritative wheel/triangle pose in degrees (READY / recovery).
     * Does not start motion.
     */
    setPoseDegrees(gameId, wheelAngleDeg, triangleAngleDeg) {

        this._assertInitialized();

        const simulation = this._getSimulationOrLog(gameId, "set pose");

        if (!simulation) {

            return null;

        }

        if (Number.isFinite(wheelAngleDeg)) {

            simulation.runtime.angle = normalizeAngleRadians(
                wheelAngleDeg * DEGREES_TO_RADIANS
            );

        }

        if (Number.isFinite(triangleAngleDeg)) {

            simulation.runtime.triangleAngle = normalizeAngleRadians(
                triangleAngleDeg * DEGREES_TO_RADIANS
            );

        }

        if (simulation.runtime.state === PHYSICS_SIMULATION_STATE.RUNNING
            || simulation.runtime.state === PHYSICS_SIMULATION_STATE.BRAKING) {

            this._emit(
                EVENT_TYPES.PHYSICS_UPDATED,
                this._createPhysicsPayload(simulation)
            );

        }

        return this.getSimulation(gameId);

    }

    /**
     * P5.5 — Begin deterministic SELF_TEST constant-velocity motion.
     * Wheel +60° CCW over durationMs; triangle CW at 1.5× wheel ω.
     */
    beginSelfTest(gameId, {
        durationMs,
        wheelStartAngleDeg,
        triangleStartAngleDeg
    } = {}) {

        this._assertInitialized();

        const simulation = this._getSimulationOrLog(gameId, "begin self-test");

        if (!simulation) {

            return null;

        }

        if (simulation.runtime.selfTestActive) {

            return this.getSimulation(gameId);

        }

        if (simulation.runtime.state !== PHYSICS_SIMULATION_STATE.RUNNING) {

            this._logger.error(
                `Self-test failed: simulation is not running (${simulation.runtime.state})`
            );

            return null;

        }

        if (Number.isFinite(wheelStartAngleDeg)) {

            simulation.runtime.angle = normalizeAngleRadians(
                wheelStartAngleDeg * DEGREES_TO_RADIANS
            );

        }

        if (Number.isFinite(triangleStartAngleDeg)) {

            simulation.runtime.triangleAngle = normalizeAngleRadians(
                triangleStartAngleDeg * DEGREES_TO_RADIANS
            );

        }

        const velocities = computeSelfTestVelocities(durationMs);

        simulation.runtime.angularVelocity = velocities.wheelAngularVelocity;

        simulation.runtime.triangleAngularVelocity
            = velocities.triangleAngularVelocity;

        simulation.runtime.angularAcceleration = 0;

        simulation.runtime.braking = false;

        simulation.runtime.selfTestActive = true;

        simulation.commandLog.push({
            type: "self_test_begin",
            durationMs,
            wheelAngularVelocity: velocities.wheelAngularVelocity,
            triangleAngularVelocity: velocities.triangleAngularVelocity,
            simulationTimeMs: simulation.runtime.simulationTimeMs
        });

        this._emit(
            EVENT_TYPES.PHYSICS_UPDATED,
            this._createPhysicsPayload(simulation)
        );

        return this.getSimulation(gameId);

    }

    /**
     * P5.5 — Freeze SELF_TEST pose immediately. Final angles become SPEED starts.
     */
    endSelfTest(gameId) {

        this._assertInitialized();

        const simulation = this._getSimulationOrLog(gameId, "end self-test");

        if (!simulation) {

            return null;

        }

        if (!simulation.runtime.selfTestActive) {

            return this.getSimulation(gameId);

        }

        simulation.runtime.selfTestActive = false;

        simulation.runtime.angularVelocity = 0;

        simulation.runtime.triangleAngularVelocity = 0;

        simulation.runtime.angularAcceleration = 0;

        simulation.runtime.braking = false;

        simulation.commandLog.push({
            type: "self_test_end",
            angle: simulation.runtime.angle,
            triangleAngle: simulation.runtime.triangleAngle,
            simulationTimeMs: simulation.runtime.simulationTimeMs
        });

        this._emit(
            EVENT_TYPES.PHYSICS_UPDATED,
            this._createPhysicsPayload(simulation)
        );

        return this.getSimulation(gameId);

    }

    /**
     * P5.6A — Begin SPEED constant-velocity motion from current pose.
     * Baseline 1 rps CW + 1 rps per held button; triangle 1.5× opposite.
     */
    beginSpeed(gameId, { heldButtonCount = 0 } = {}) {

        this._assertInitialized();

        const simulation = this._getSimulationOrLog(gameId, "begin speed");

        if (!simulation) {

            return null;

        }

        if (simulation.runtime.speedActive) {

            return this.getSimulation(gameId);

        }

        if (simulation.runtime.state !== PHYSICS_SIMULATION_STATE.RUNNING) {

            this._logger.error(
                `Speed failed: simulation is not running (${simulation.runtime.state})`
            );

            return null;

        }

        simulation.runtime.selfTestActive = false;

        simulation.runtime.braking = false;

        simulation.runtime.angularAcceleration = 0;

        simulation.runtime.speedActive = true;

        this._applySpeedVelocities(simulation, heldButtonCount);

        simulation.commandLog.push({
            type: "speed_begin",
            heldButtonCount,
            wheelAngularVelocity: simulation.runtime.angularVelocity,
            triangleAngularVelocity: simulation.runtime.triangleAngularVelocity,
            simulationTimeMs: simulation.runtime.simulationTimeMs
        });

        this._emit(
            EVENT_TYPES.PHYSICS_UPDATED,
            this._createPhysicsPayload(simulation)
        );

        return this.getSimulation(gameId);

    }

    /**
     * P5.6A — Immediately recompute SPEED velocities from held-button count.
     */
    setSpeedHoldCount(gameId, heldButtonCount) {

        this._assertInitialized();

        const simulation = this._getSimulationOrLog(gameId, "set speed holds");

        if (!simulation) {

            return null;

        }

        if (!simulation.runtime.speedActive) {

            return null;

        }

        this._applySpeedVelocities(simulation, heldButtonCount);

        simulation.commandLog.push({
            type: "speed_hold_update",
            heldButtonCount,
            wheelAngularVelocity: simulation.runtime.angularVelocity,
            triangleAngularVelocity: simulation.runtime.triangleAngularVelocity,
            simulationTimeMs: simulation.runtime.simulationTimeMs
        });

        this._emit(
            EVENT_TYPES.PHYSICS_UPDATED,
            this._createPhysicsPayload(simulation)
        );

        return this.getSimulation(gameId);

    }

    /**
     * P5.6A — End hold-driven SPEED control.
     * keepMotion: continue kinematic integration at last velocities (for BRAKE).
     */
    endSpeed(gameId, { keepMotion = true } = {}) {

        this._assertInitialized();

        const simulation = this._getSimulationOrLog(gameId, "end speed");

        if (!simulation) {

            return null;

        }

        if (!simulation.runtime.speedActive) {

            return this.getSimulation(gameId);

        }

        if (!keepMotion) {

            simulation.runtime.angularVelocity = 0;

            simulation.runtime.triangleAngularVelocity = 0;

            simulation.runtime.speedActive = false;

        }

        // keepMotion: leave speedActive + velocities so signed dual integration
        // continues until a future BRAKE stage takes ownership.

        simulation.runtime.angularAcceleration = 0;

        simulation.runtime.braking = false;

        simulation.commandLog.push({
            type: "speed_end",
            keepMotion,
            angle: simulation.runtime.angle,
            triangleAngle: simulation.runtime.triangleAngle,
            angularVelocity: simulation.runtime.angularVelocity,
            triangleAngularVelocity: simulation.runtime.triangleAngularVelocity,
            simulationTimeMs: simulation.runtime.simulationTimeMs
        });

        this._emit(
            EVENT_TYPES.PHYSICS_UPDATED,
            this._createPhysicsPayload(simulation)
        );

        return this.getSimulation(gameId);

    }

    isSpeedActive(gameId) {

        const simulation = this._simulations.get(gameId);

        return simulation?.runtime?.speedActive === true;

    }

    /**
     * P5.7 — Begin deterministic linear BRAKE from current SPEED pose/ω.
     * Duration is fixed; ω(t) = ω0 * (1 - t/T); triangle stays 1.5× opposite.
     */
    beginBrake(gameId, { durationMs } = {}) {

        this._assertInitialized();

        const simulation = this._getSimulationOrLog(gameId, "begin brake");

        if (!simulation) {

            return null;

        }

        if (simulation.runtime.brakeActive) {

            return this.getSimulation(gameId);

        }

        if (simulation.runtime.state !== PHYSICS_SIMULATION_STATE.RUNNING
            && simulation.runtime.state !== PHYSICS_SIMULATION_STATE.BRAKING) {

            this._logger.error(
                `Brake failed: simulation is not active (${simulation.runtime.state})`
            );

            return null;

        }

        const resolvedDurationMs = Number.isFinite(durationMs) && durationMs > 0
            ? durationMs
            : 6000;

        if (simulation.runtime.state === PHYSICS_SIMULATION_STATE.RUNNING) {

            if (!this._transitionState(
                simulation,
                PHYSICS_SIMULATION_STATE.BRAKING
            )) {

                return null;

            }

        }

        simulation.runtime.speedActive = false;

        simulation.runtime.selfTestActive = false;

        simulation.runtime.angularAcceleration = 0;

        simulation.runtime.braking = true;

        simulation.runtime.brakeActive = true;

        simulation.runtime.brakeDurationMs = resolvedDurationMs;

        simulation.runtime.brakeElapsedMs = 0;

        simulation.runtime.brakeStartWheelOmega
            = simulation.runtime.angularVelocity;

        simulation.runtime.physicsStoppedEmitted = false;

        // Re-assert triangle ratio at BRAKE entry (same as SPEED model).
        const startVelocities = computeBrakeVelocities(
            simulation.runtime.brakeStartWheelOmega,
            0
        );

        simulation.runtime.angularVelocity = startVelocities.wheelAngularVelocity;

        simulation.runtime.triangleAngularVelocity
            = startVelocities.triangleAngularVelocity;

        simulation.commandLog.push({
            type: "brake_begin",
            durationMs: resolvedDurationMs,
            wheelAngularVelocity: simulation.runtime.angularVelocity,
            triangleAngularVelocity: simulation.runtime.triangleAngularVelocity,
            simulationTimeMs: simulation.runtime.simulationTimeMs
        });

        this._emit(
            EVENT_TYPES.PHYSICS_BRAKING,
            this._createPhysicsPayload(simulation)
        );

        this._emit(
            EVENT_TYPES.PHYSICS_UPDATED,
            this._createPhysicsPayload(simulation)
        );

        return this.getSimulation(gameId);

    }

    /**
     * P5.7 — Force BRAKE completion: ω = 0 and emit PHYSICS_STOPPED once.
     */
    completeBrake(gameId) {

        this._assertInitialized();

        const simulation = this._getSimulationOrLog(gameId, "complete brake");

        if (!simulation) {

            return null;

        }

        if (!simulation.runtime.brakeActive
            && simulation.runtime.state !== PHYSICS_SIMULATION_STATE.BRAKING) {

            return this.getSimulation(gameId);

        }

        this._finalizeBrakeStop(simulation);

        return this.getSimulation(gameId);

    }

    isBrakeActive(gameId) {

        const simulation = this._simulations.get(gameId);

        return simulation?.runtime?.brakeActive === true;

    }

    applyAcceleration(gameId, angularAcceleration) {

        this._assertInitialized();

        const simulation = this._getSimulationOrLog(gameId, "accelerate");

        if (!simulation) {

            return null;

        }

        if (simulation.runtime.selfTestActive) {

            this._logger.error(
                "Acceleration failed: self-test motion is active"
            );

            return null;

        }

        if (simulation.runtime.speedActive) {

            // P5.6A — SPEED velocities are hold-count driven, not acceleration.
            return this.getSimulation(gameId);

        }

        if (simulation.runtime.brakeActive) {

            return this.getSimulation(gameId);

        }

        if (simulation.runtime.state !== PHYSICS_SIMULATION_STATE.RUNNING) {

            this._logger.error(
                `Acceleration failed: simulation is not running (${simulation.runtime.state})`
            );

            return null;

        }

        const clampedAcceleration = Math.min(
            Math.max(0, angularAcceleration),
            simulation.parameters.maxAcceleration
        );

        simulation.runtime.angularAcceleration = clampedAcceleration;

        simulation.runtime.braking = false;

        simulation.commandLog.push({
            type: "acceleration",
            value: clampedAcceleration,
            simulationTimeMs: simulation.runtime.simulationTimeMs
        });

        return this.getSimulation(gameId);

    }

    applyBrake(gameId) {

        this._assertInitialized();

        const simulation = this._getSimulationOrLog(gameId, "brake");

        if (!simulation) {

            return null;

        }

        if (simulation.runtime.selfTestActive) {

            this._logger.error(
                "Brake failed: self-test motion is active"
            );

            return null;

        }

        if (simulation.runtime.brakeActive) {

            return this.getSimulation(gameId);

        }

        if (simulation.runtime.speedActive) {

            // P5.7 — Page5 BRAKE is owned by beginBrake / BrakePhaseController.
            return this.beginBrake(gameId, { durationMs: 6000 });

        }

        if (simulation.runtime.state !== PHYSICS_SIMULATION_STATE.RUNNING) {

            this._logger.error(
                `Brake failed: simulation is not running (${simulation.runtime.state})`
            );

            return null;

        }

        if (!this._transitionState(
            simulation,
            PHYSICS_SIMULATION_STATE.BRAKING
        )) {

            return null;

        }

        simulation.runtime.braking = true;

        simulation.runtime.angularAcceleration = 0;

        simulation.commandLog.push({
            type: "brake",
            simulationTimeMs: simulation.runtime.simulationTimeMs
        });

        this._logger.info("Brake Applied");

        this._emit(EVENT_TYPES.PHYSICS_BRAKING, this._createPhysicsPayload(simulation));

        return this.getSimulation(gameId);

    }

    stopSimulation(gameId) {

        this._assertInitialized();

        const simulation = this._getSimulationOrLog(gameId, "stop");

        if (!simulation) {

            return null;

        }

        if (simulation.runtime.state === PHYSICS_SIMULATION_STATE.STOPPED
            || simulation.runtime.state === PHYSICS_SIMULATION_STATE.REMOVED) {

            this._logger.error(
                `Simulation stop failed: simulation is not active (${simulation.runtime.state})`
            );

            return null;

        }

        this._finalizeStop(simulation);

        return this.getSimulation(gameId);

    }

    /**
     * R17.9T.6-D2 — Silent simulation attachment for recovery.
     *
     * Attaches an already-authoritative simulation state WITHOUT emitting
     * PHYSICS_STARTED / PHYSICS_UPDATED / PHYSICS_STOPPED and WITHOUT
     * registering the game in SimulationLoop.
     *
     * Allowed D2 restoration shapes:
     *   A. Proven pre-motion state: CREATED
     *   B. Terminal RESULT state: STOPPED with authoritative final angles
     *
     * RUNNING / BRAKING restoration is rejected under the current contract.
     *
     * @param {{ gameId: string, parameters?: object, runtime: object, commandLog?: Array<object> }} input
     * @param {{ emitEvents?: boolean }} options
     * @returns {object|null} The attached simulation snapshot, or null on failure.
     */
    attachSimulation({ gameId, parameters = {}, runtime, commandLog = [] }, { emitEvents = false } = {}) {

        this._assertInitialized();

        if (!gameId) {

            this._logger.error("Simulation attach failed: gameId is required");

            return null;

        }

        if (!runtime || typeof runtime !== "object") {

            this._logger.error("Simulation attach failed: runtime is required");

            return null;

        }

        if (!Array.isArray(commandLog)) {

            this._logger.error("Simulation attach failed: commandLog must be an array");

            return null;

        }

        const state = runtime.state;

        if (state !== PHYSICS_SIMULATION_STATE.CREATED
            && state !== PHYSICS_SIMULATION_STATE.STOPPED) {

            this._logger.error(
                `Simulation attach failed: state ${state} is not recoverable under D2`
            );

            return null;

        }

        // Validate finite numeric values.
        const numericFields = [
            "angle",
            "triangleAngle",
            "angularVelocity",
            "triangleAngularVelocity",
            "angularAcceleration",
            "brakeDurationMs",
            "brakeElapsedMs",
            "brakeStartWheelOmega",
            "simulationTimeMs"
        ];

        for (const field of numericFields) {

            const value = runtime[field];

            if (value !== undefined && value !== null && !Number.isFinite(value)) {

                this._logger.error(
                    `Simulation attach failed: ${field} must be finite (${gameId})`
                );

                return null;

            }

        }

        if (state === PHYSICS_SIMULATION_STATE.CREATED) {

            // Pre-motion state: angles/velocities must be zero/default.
            if (runtime.angle !== 0
                || runtime.triangleAngle !== 0
                || runtime.angularVelocity !== 0
                || runtime.triangleAngularVelocity !== 0
                || runtime.angularAcceleration !== 0) {

                this._logger.error(
                    `Simulation attach failed: CREATED state must have zero motion (${gameId})`
                );

                return null;

            }

        }

        if (state === PHYSICS_SIMULATION_STATE.STOPPED) {

            // Terminal state: final angles must be finite radians; motion must be zero.
            if (!Number.isFinite(runtime.angle) || !Number.isFinite(runtime.triangleAngle)) {

                this._logger.error(
                    `Simulation attach failed: STOPPED state requires finite final angles (${gameId})`
                );

                return null;

            }

            if (runtime.angularVelocity !== 0
                || runtime.triangleAngularVelocity !== 0
                || runtime.angularAcceleration !== 0) {

                this._logger.error(
                    `Simulation attach failed: STOPPED state requires zero terminal motion (${gameId})`
                );

                return null;

            }

        }

        // Duplicate handling.
        if (this._simulations.has(gameId)) {

            const existing = this._simulations.get(gameId);

            if (existing.runtime.state === state
                && existing.runtime.angle === (runtime.angle ?? 0)
                && existing.runtime.triangleAngle === (runtime.triangleAngle ?? 0)) {

                this._logger.info(
                    `Simulation attach: equivalent simulation already attached (${gameId})`
                );

                return this.getSimulation(gameId);

            }

            this._logger.error(
                `Simulation attach failed: conflicting simulation already exists (${gameId})`
            );

            return null;

        }

        const physicsParameters = {
            ...DEFAULT_PHYSICS_PARAMETERS,
            ...parameters
        };

        const simulation = {
            gameId,
            parameters: physicsParameters,
            runtime: {
                angle: runtime.angle ?? 0,
                triangleAngle: runtime.triangleAngle ?? 0,
                angularVelocity: runtime.angularVelocity ?? 0,
                triangleAngularVelocity: runtime.triangleAngularVelocity ?? 0,
                angularAcceleration: runtime.angularAcceleration ?? 0,
                state,
                braking: runtime.braking ?? false,
                selfTestActive: runtime.selfTestActive ?? false,
                speedActive: runtime.speedActive ?? false,
                brakeActive: runtime.brakeActive ?? false,
                brakeDurationMs: runtime.brakeDurationMs ?? 0,
                brakeElapsedMs: runtime.brakeElapsedMs ?? 0,
                brakeStartWheelOmega: runtime.brakeStartWheelOmega ?? 0,
                // Preserve the internal guard so a later cleanup path cannot
                // emit a false PHYSICS_STOPPED event.
                physicsStoppedEmitted: state === PHYSICS_SIMULATION_STATE.STOPPED
                    ? true
                    : (runtime.physicsStoppedEmitted ?? false),
                simulationTimeMs: runtime.simulationTimeMs ?? 0
            },
            commandLog: commandLog.map((entry) => ({ ...entry }))
        };

        this._simulations.set(gameId, simulation);

        this._logger.info("Simulation Attached");

        return this.getSimulation(gameId);

    }

    removeSimulation(gameId) {

        const simulation = this._simulations.get(gameId);

        if (!simulation) {

            this._logger.error(
                `Simulation removal failed: simulation not found (${gameId})`
            );

            return false;

        }

        if (simulation.runtime.state === PHYSICS_SIMULATION_STATE.RUNNING
            || simulation.runtime.state === PHYSICS_SIMULATION_STATE.BRAKING) {

            this.stopSimulation(gameId);

        }

        this._simulations.delete(gameId);

        this._logger.info("Simulation Removed");

        return true;

    }

    // C4.5 — read-only operational accessor (no behavior change).
    getActiveSimulationCount() {

        return this._simulations.size;

    }

    getSimulation(gameId) {

        const simulation = this._simulations.get(gameId);

        if (!simulation) {

            return null;

        }

        return {
            gameId: simulation.gameId,
            parameters: { ...simulation.parameters },
            runtime: {
                angle: simulation.runtime.angle,
                triangleAngle: simulation.runtime.triangleAngle,
                angularVelocity: simulation.runtime.angularVelocity,
                triangleAngularVelocity: simulation.runtime.triangleAngularVelocity,
                angularAcceleration: simulation.runtime.angularAcceleration,
                state: simulation.runtime.state,
                selfTestActive: simulation.runtime.selfTestActive,
                speedActive: simulation.runtime.speedActive,
                brakeActive: simulation.runtime.brakeActive,
                brakeDurationMs: simulation.runtime.brakeDurationMs,
                brakeElapsedMs: simulation.runtime.brakeElapsedMs,
                brakeStartWheelOmega: simulation.runtime.brakeStartWheelOmega,
                simulationTimeMs: simulation.runtime.simulationTimeMs
            },
            commandLog: simulation.commandLog.map((entry) => ({ ...entry }))
        };

    }

    getDebugSnapshot(gameId) {

        const simulation = this._simulations.get(gameId);

        if (!simulation) {

            return null;

        }

        return {
            gameId,
            angle: simulation.runtime.angle,
            triangleAngle: simulation.runtime.triangleAngle,
            angularVelocity: simulation.runtime.angularVelocity,
            triangleAngularVelocity: simulation.runtime.triangleAngularVelocity,
            angularAcceleration: simulation.runtime.angularAcceleration,
            selfTestActive: simulation.runtime.selfTestActive,
            speedActive: simulation.runtime.speedActive,
            brakeActive: simulation.runtime.brakeActive,
            brakeDurationMs: simulation.runtime.brakeDurationMs,
            brakeElapsedMs: simulation.runtime.brakeElapsedMs,
            brakeStartWheelOmega: simulation.runtime.brakeStartWheelOmega,
            simulationState: simulation.runtime.state
        };

    }

    _applySpeedVelocities(simulation, heldButtonCount) {

        const velocities = computeSpeedVelocities(heldButtonCount);

        simulation.runtime.angularVelocity = velocities.wheelAngularVelocity;

        simulation.runtime.triangleAngularVelocity
            = velocities.triangleAngularVelocity;

        simulation.runtime.angularAcceleration = 0;

    }

    _integrateStep(simulation, stepDurationMs) {

        const dt = stepDurationMs / 1000;

        const { parameters, runtime } = simulation;

        if (runtime.selfTestActive || runtime.speedActive) {

            runtime.angle = normalizeAngleRadians(
                runtime.angle + (runtime.angularVelocity * dt)
            );

            runtime.triangleAngle = normalizeAngleRadians(
                runtime.triangleAngle + (runtime.triangleAngularVelocity * dt)
            );

            return;

        }

        if (runtime.brakeActive) {

            this._integrateBrakeStep(simulation, stepDurationMs);

            return;

        }

        if (runtime.braking) {

            runtime.angularAcceleration = -parameters.brakeCoefficient;

        } else if (runtime.angularAcceleration === 0
            && parameters.inertiaCoefficient > 0) {

            runtime.angularAcceleration = -parameters.inertiaCoefficient
                * runtime.angularVelocity;

        }

        runtime.angularVelocity += runtime.angularAcceleration * dt;

        if (runtime.angularVelocity < 0) {

            runtime.angularVelocity = 0;

        }

        if (runtime.angularVelocity > parameters.maxAngularVelocity) {

            runtime.angularVelocity = parameters.maxAngularVelocity;

        }

        runtime.angle = normalizeAngleRadians(
            runtime.angle + (runtime.angularVelocity * dt)
        );

        if (runtime.braking
            && runtime.angularVelocity <= parameters.velocityStopThreshold) {

            runtime.angularVelocity = 0;

            runtime.angularAcceleration = 0;

            this._finalizeStop(simulation);

        }

    }

    _integrateBrakeStep(simulation, stepDurationMs) {

        const { runtime } = simulation;

        const durationMs = runtime.brakeDurationMs;

        if (!Number.isFinite(durationMs) || durationMs <= 0) {

            this._finalizeBrakeStop(simulation);

            return;

        }

        const durationSec = durationMs / 1000;

        const t0 = runtime.brakeElapsedMs / 1000;

        runtime.brakeElapsedMs = Math.min(
            durationMs,
            runtime.brakeElapsedMs + stepDurationMs
        );

        const t1 = runtime.brakeElapsedMs / 1000;

        const omega0 = runtime.brakeStartWheelOmega;

        const wheelDelta = integrateLinearBrakeAngle(
            omega0,
            t0,
            t1,
            durationSec
        );

        const startPair = computeBrakeVelocities(omega0, 0);

        const triangleDelta = integrateLinearBrakeAngle(
            startPair.triangleAngularVelocity,
            t0,
            t1,
            durationSec
        );

        runtime.angle = normalizeAngleRadians(runtime.angle + wheelDelta);

        runtime.triangleAngle = normalizeAngleRadians(
            runtime.triangleAngle + triangleDelta
        );

        const progress = runtime.brakeElapsedMs / durationMs;

        const velocities = computeBrakeVelocities(omega0, progress);

        runtime.angularVelocity = velocities.wheelAngularVelocity;

        runtime.triangleAngularVelocity = velocities.triangleAngularVelocity;

        runtime.angularAcceleration = 0;

        if (runtime.brakeElapsedMs >= durationMs) {

            this._finalizeBrakeStop(simulation);

        }

    }

    _finalizeBrakeStop(simulation) {

        if (simulation.runtime.physicsStoppedEmitted) {

            return;

        }

        simulation.runtime.brakeActive = false;

        simulation.runtime.braking = false;

        simulation.runtime.speedActive = false;

        simulation.runtime.selfTestActive = false;

        simulation.runtime.angularVelocity = 0;

        simulation.runtime.triangleAngularVelocity = 0;

        simulation.runtime.angularAcceleration = 0;

        simulation.runtime.brakeElapsedMs = simulation.runtime.brakeDurationMs;

        if (simulation.runtime.state !== PHYSICS_SIMULATION_STATE.STOPPED) {

            simulation.runtime.state = PHYSICS_SIMULATION_STATE.STOPPED;

        }

        simulation.runtime.physicsStoppedEmitted = true;

        this._logger.info("Simulation Stopped");

        this._emit(
            EVENT_TYPES.PHYSICS_STOPPED,
            this._createPhysicsPayload(simulation)
        );

    }

    _finalizeStop(simulation) {

        if (simulation.runtime.state === PHYSICS_SIMULATION_STATE.STOPPED) {

            return;

        }

        simulation.runtime.braking = false;

        simulation.runtime.selfTestActive = false;

        simulation.runtime.speedActive = false;

        simulation.runtime.brakeActive = false;

        simulation.runtime.angularVelocity = 0;

        simulation.runtime.triangleAngularVelocity = 0;

        simulation.runtime.angularAcceleration = 0;

        simulation.runtime.state = PHYSICS_SIMULATION_STATE.STOPPED;

        simulation.runtime.physicsStoppedEmitted = true;

        this._logger.info("Simulation Stopped");

        this._emit(
            EVENT_TYPES.PHYSICS_STOPPED,
            this._createPhysicsPayload(simulation)
        );

    }

    _transitionState(simulation, nextState) {

        const currentState = simulation.runtime.state;

        if (!canTransitionPhysicsState(currentState, nextState)) {

            return false;

        }

        simulation.runtime.state = nextState;

        return true;

    }

    _createPhysicsPayload(simulation) {

        return {
            gameId: simulation.gameId,
            angle: simulation.runtime.angle,
            triangleAngle: simulation.runtime.triangleAngle,
            angularVelocity: simulation.runtime.angularVelocity,
            triangleAngularVelocity: simulation.runtime.triangleAngularVelocity,
            angularAcceleration: simulation.runtime.angularAcceleration,
            selfTestActive: simulation.runtime.selfTestActive === true,
            speedActive: simulation.runtime.speedActive === true,
            brakeActive: simulation.runtime.brakeActive === true,
            brakeDurationMs: simulation.runtime.brakeDurationMs ?? 0,
            brakeElapsedMs: simulation.runtime.brakeElapsedMs ?? 0,
            brakeStartWheelOmega: simulation.runtime.brakeStartWheelOmega ?? 0,
            timestamp: simulation.runtime.simulationTimeMs
        };

    }

    _getSimulationOrLog(gameId, operation) {

        if (!gameId) {

            this._logger.error(`Simulation ${operation} failed: gameId is required`);

            return null;

        }

        const simulation = this._simulations.get(gameId);

        if (!simulation) {

            this._logger.error(
                `Simulation ${operation} failed: simulation not found (${gameId})`
            );

            return null;

        }

        return simulation;

    }

    _emit(type, payload) {

        if (!this._eventBus.hasSubscribers(type)) {

            return;

        }

        this._eventBus.emit({
            source: EVENT_SOURCES.PHYSICS_ENGINE,
            type,
            payload
        });

    }

    _handleServerShutdown() {

        for (const gameId of this._simulations.keys()) {

            this.removeSimulation(gameId);

        }

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new Error("PhysicsEngine is not initialized");

        }

    }

}
