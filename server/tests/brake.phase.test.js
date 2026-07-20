import { EventBus } from "../events/EventBus.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    computeBrakeVelocities,
    integrateLinearBrakeAngle
} from "../gameplay/brakeMotion.js";
import { BrakePhaseController } from "../gameplay/BrakePhaseController.js";
import { computeSpeedVelocities } from "../gameplay/speedMotion.js";
import { LoggerService } from "../services/LoggerService.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

const logger = new LoggerService();

logger.initialize();

const eventBus = new EventBus({
    logger,
    eventBusConfig: { logEvents: false, showDebugPanel: false }
});

eventBus.initialize();

const physicsEngine = new PhysicsEngine({
    logger,
    eventBus,
    gameClock: null
});

physicsEngine.initialize();

const controller = new BrakePhaseController({
    logger,
    eventBus,
    physicsEngine,
    gameClockEngine: null,
    devMode: false
});

controller.initialize();

const gameId = "game-brake";

const durationMs = 6000;

physicsEngine.createSimulation(gameId);

physicsEngine.startSimulation(gameId);

physicsEngine.setPoseDegrees(gameId, 30, 45);

physicsEngine.beginSpeed(gameId, { heldButtonCount: 1 });

const speedΩ = computeSpeedVelocities(1);

let snap = physicsEngine.getSimulation(gameId);

assert(
    snap.runtime.angularVelocity === speedΩ.wheelAngularVelocity,
    "SPEED ω must be established before BRAKE"
);

physicsEngine.endSpeed(gameId, { keepMotion: true });

snap = physicsEngine.getSimulation(gameId);

assert(
    snap.runtime.angularVelocity === speedΩ.wheelAngularVelocity,
    "SPEED_COMPLETED must preserve wheel ω for BRAKE"
);

assert(
    snap.runtime.triangleAngularVelocity === speedΩ.triangleAngularVelocity,
    "SPEED_COMPLETED must preserve triangle ω for BRAKE"
);

const stopped = [];

eventBus.subscribe(EVENT_TYPES.PHYSICS_STOPPED, (envelope) => {

    stopped.push(envelope.payload);

});

const winners = [];

eventBus.subscribe(EVENT_TYPES.WINNER_DETERMINED, (envelope) => {

    winners.push(envelope.payload);

});

controller._handleBrakeStarted({
    gameId,
    phase: "BRAKE",
    durationMs,
    startedAt: 1000,
    endsAt: 1000 + durationMs
});

snap = physicsEngine.getSimulation(gameId);

assert(snap.runtime.brakeActive === true, "brake must be active");

assert(
    snap.runtime.angularVelocity === speedΩ.wheelAngularVelocity,
    "BRAKE initial wheel ω equals final SPEED ω"
);

assert(
    snap.runtime.triangleAngularVelocity === speedΩ.triangleAngularVelocity,
    "BRAKE initial triangle ω equals final SPEED ω ratio"
);

const midMs = durationMs / 2;

physicsEngine.updateSimulation(gameId, midMs);

snap = physicsEngine.getSimulation(gameId);

const mid = computeBrakeVelocities(speedΩ.wheelAngularVelocity, 0.5);

assert(
    Math.abs(snap.runtime.angularVelocity - mid.wheelAngularVelocity) < 1e-9,
    "wheel slows continuously (linear) at mid BRAKE"
);

assert(
    Math.abs(
        snap.runtime.triangleAngularVelocity - mid.triangleAngularVelocity
    ) < 1e-9,
    "triangle remains 1.5× opposite during BRAKE"
);

assert(
    snap.runtime.angularVelocity * speedΩ.wheelAngularVelocity > 0
        || snap.runtime.angularVelocity === 0,
    "no direction change during BRAKE"
);

physicsEngine.updateSimulation(gameId, midMs);

snap = physicsEngine.getSimulation(gameId);

assert(snap.runtime.angularVelocity === 0, "wheel stops at BRAKE end");

assert(snap.runtime.triangleAngularVelocity === 0, "triangle stops with wheel");

assert(snap.runtime.brakeActive === false, "brake inactive after completion");

assert(stopped.length === 1, "PHYSICS_STOPPED emitted exactly once");

assert(winners.length === 0, "no winner calculation during BRAKE");

// Idempotent complete
controller._handleBrakeCompleted({ gameId, phase: "BRAKE" });

assert(stopped.length === 1, "PHYSICS_STOPPED must not double-emit");

// Analytic integral sanity
const delta = integrateLinearBrakeAngle(-2 * Math.PI, 0, 6, 6);

assert(
    Math.abs(delta - (-2 * Math.PI * 3)) < 1e-9,
    "linear brake angle integral must be ω0 * T/2"
);

console.log("brake.phase.test.js passed");
