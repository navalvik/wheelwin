import { EventBus } from "../events/EventBus.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import {
    SELF_TEST_TRIANGLE_VELOCITY_RATIO,
    SELF_TEST_WHEEL_ROTATION_DEG,
    computeSelfTestVelocities
} from "../gameplay/selfTestMotion.js";
import { SelfTestPhaseController } from "../gameplay/SelfTestPhaseController.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { LoggerService } from "../services/LoggerService.js";
import { normalizeAngleRadians } from "../engines/physics/physicsMath.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

const DEG = 180 / Math.PI;

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

const configurationEngine = {
    getConfiguration(gameId) {

        if (gameId !== "game-self-test") {

            return null;

        }

        return {
            sectors: [],
            wheel: { startAngle: 10 },
            triangle: { startAngle: 20 }
        };

    }
};

const gameClockEngine = {
    getPhaseSchedule() {

        return null;

    }
};

const controller = new SelfTestPhaseController({
    logger,
    eventBus,
    configurationEngine,
    physicsEngine,
    gameClockEngine,
    devMode: false
});

controller.initialize();

const gameId = "game-self-test";

const durationMs = 1500;

physicsEngine.createSimulation(gameId);

physicsEngine.startSimulation(gameId);

const velocities = computeSelfTestVelocities(durationMs);

assert(
    velocities.triangleAngularVelocity
        === -SELF_TEST_TRIANGLE_VELOCITY_RATIO * velocities.wheelAngularVelocity,
    "triangle ω must be -1.5× wheel ω"
);

assert(
    velocities.wheelAngularVelocity > 0,
    "wheel ω must be positive (CCW)"
);

assert(
    velocities.triangleAngularVelocity < 0,
    "triangle ω must be negative (CW)"
);

controller._handleSelfTestStarted({
    gameId,
    phase: "SELF_TEST",
    durationMs,
    startedAt: 1000,
    endsAt: 1000 + durationMs
});

let snap = physicsEngine.getSimulation(gameId);

assert(snap.runtime.selfTestActive === true, "self-test must be active");

assert(
    Math.abs((snap.runtime.angle * DEG) - 10) < 1e-9,
    "wheel must seed from configuration start angle"
);

assert(
    Math.abs((snap.runtime.triangleAngle * DEG) - 20) < 1e-9,
    "triangle must seed from configuration start angle"
);

assert(
    physicsEngine.applyAcceleration(gameId, Math.PI) === null,
    "player acceleration must be rejected during SELF_TEST"
);

physicsEngine.updateSimulation(gameId, durationMs);

snap = physicsEngine.getSimulation(gameId);

const expectedWheel = normalizeAngleRadians(
    (10 * Math.PI) / 180 + (SELF_TEST_WHEEL_ROTATION_DEG * Math.PI) / 180
);

const expectedTriangle = normalizeAngleRadians(
    (20 * Math.PI) / 180
    + velocities.triangleAngularVelocity * (durationMs / 1000)
);

assert(
    Math.abs(snap.runtime.angle - expectedWheel) < 1e-9,
    `wheel must rotate exactly 60° CCW (got ${snap.runtime.angle}, expected ${expectedWheel})`
);

assert(
    Math.abs(snap.runtime.triangleAngle - expectedTriangle) < 1e-9,
    "triangle must rotate CW at 1.5× wheel speed over the phase"
);

const wheelDeltaDeg = ((snap.runtime.angle - ((10 * Math.PI) / 180)) * DEG + 360) % 360;

assert(
    Math.abs(wheelDeltaDeg - SELF_TEST_WHEEL_ROTATION_DEG) < 1e-6,
    `wheel delta must be 60° (got ${wheelDeltaDeg})`
);

controller._handleSelfTestCompleted({
    gameId,
    phase: "SELF_TEST"
});

snap = physicsEngine.getSimulation(gameId);

assert(snap.runtime.selfTestActive === false, "self-test must end");

assert(snap.runtime.angularVelocity === 0, "wheel must stop immediately");

assert(
    snap.runtime.triangleAngularVelocity === 0,
    "triangle must stop immediately"
);

const frozenWheel = snap.runtime.angle;

const frozenTriangle = snap.runtime.triangleAngle;

physicsEngine.updateSimulation(gameId, 100);

snap = physicsEngine.getSimulation(gameId);

assert(snap.runtime.angle === frozenWheel, "final wheel angle preserved for SPEED");

assert(
    snap.runtime.triangleAngle === frozenTriangle,
    "final triangle angle preserved for SPEED"
);

// Idempotent: do not restart while already active
physicsEngine.beginSelfTest(gameId, {
    durationMs,
    wheelStartAngleDeg: 10,
    triangleStartAngleDeg: 20
});

controller._activeGames.add(gameId);

const before = physicsEngine.getSimulation(gameId).runtime.angularVelocity;

controller._handleSelfTestStarted({
    gameId,
    phase: "SELF_TEST",
    durationMs
});

assert(
    physicsEngine.getSimulation(gameId).runtime.angularVelocity === before,
    "active SELF_TEST must not restart"
);

console.log("selfTest.phase.test.js passed");
