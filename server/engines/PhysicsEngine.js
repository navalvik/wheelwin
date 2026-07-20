import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { computeSelfTestVelocities } from "../gameplay/selfTestMotion.js";
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
            simulationState: simulation.runtime.state
        };

    }

    _integrateStep(simulation, stepDurationMs) {

        const dt = stepDurationMs / 1000;

        const { parameters, runtime } = simulation;

        if (runtime.selfTestActive) {

            runtime.angle = normalizeAngleRadians(
                runtime.angle + (runtime.angularVelocity * dt)
            );

            runtime.triangleAngle = normalizeAngleRadians(
                runtime.triangleAngle + (runtime.triangleAngularVelocity * dt)
            );

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

    _finalizeStop(simulation) {

        if (simulation.runtime.state === PHYSICS_SIMULATION_STATE.STOPPED) {

            return;

        }

        simulation.runtime.braking = false;

        simulation.runtime.selfTestActive = false;

        simulation.runtime.angularVelocity = 0;

        simulation.runtime.triangleAngularVelocity = 0;

        simulation.runtime.angularAcceleration = 0;

        simulation.runtime.state = PHYSICS_SIMULATION_STATE.STOPPED;

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
