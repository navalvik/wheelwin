import { EventBus } from "../events/EventBus.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import {
    SPEED_BASE_WHEEL_RPS,
    SPEED_RADIANS_PER_REVOLUTION,
    SPEED_RPS_PER_HELD_BUTTON,
    SPEED_TRIANGLE_VELOCITY_RATIO,
    computeSpeedVelocities
} from "../gameplay/speedMotion.js";
import { SpeedPhaseController } from "../gameplay/SpeedPhaseController.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
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

const heldByGame = new Map();

const inputAuthority = {
    countHeldButtons(gameId) {

        return heldByGame.get(gameId) ?? 0;

    }
};

const controller = new SpeedPhaseController({
    logger,
    eventBus,
    physicsEngine,
    inputAuthority,
    devMode: false
});

controller.initialize();

const gameId = "game-speed";

physicsEngine.createSimulation(gameId);

physicsEngine.startSimulation(gameId);

physicsEngine.setPoseDegrees(gameId, 40, 50);

// Baseline 0 holds → 1 rps CW
const baseline = computeSpeedVelocities(0);

assert(
    baseline.wheelAngularVelocity
        === -SPEED_BASE_WHEEL_RPS * SPEED_RADIANS_PER_REVOLUTION,
    "baseline wheel must be 1 rps clockwise (negative ω)"
);

assert(
    baseline.triangleAngularVelocity
        === -SPEED_TRIANGLE_VELOCITY_RATIO * baseline.wheelAngularVelocity,
    "triangle must be 1.5× opposite wheel"
);

controller._handleSpeedStarted({
    gameId,
    phase: "SPEED"
});

let snap = physicsEngine.getSimulation(gameId);

assert(snap.runtime.speedActive === true, "speed must be active");

assert(
    snap.runtime.angularVelocity === baseline.wheelAngularVelocity,
    "SPEED starts at exactly 1 rps"
);

assert(
    snap.runtime.triangleAngularVelocity === baseline.triangleAngularVelocity,
    "triangle starts at 1.5 rps opposite"
);

assert(
    Math.abs((snap.runtime.angle * 180) / Math.PI - 40) < 1e-9,
    "SPEED must keep SELF_TEST final wheel pose"
);

assert(
    Math.abs((snap.runtime.triangleAngle * 180) / Math.PI - 50) < 1e-9,
    "SPEED must keep SELF_TEST final triangle pose"
);

// 1 held → 2 rps
heldByGame.set(gameId, 1);

controller._handleInputAccepted({ gameId });

snap = physicsEngine.getSimulation(gameId);

const oneHold = computeSpeedVelocities(1);

assert(
    snap.runtime.angularVelocity === oneHold.wheelAngularVelocity,
    "1 held button → 2 rps"
);

assert(
    Math.abs(snap.runtime.angularVelocity)
        === (SPEED_BASE_WHEEL_RPS + SPEED_RPS_PER_HELD_BUTTON)
            * SPEED_RADIANS_PER_REVOLUTION,
    "each held button adds exactly +1 rps"
);

// 3 held → 4 rps
heldByGame.set(gameId, 3);

controller._handleInputAccepted({ gameId });

snap = physicsEngine.getSimulation(gameId);

const threeHold = computeSpeedVelocities(3);

assert(
    snap.runtime.angularVelocity === threeHold.wheelAngularVelocity,
    "3 held buttons → 4 rps"
);

assert(
    snap.runtime.triangleAngularVelocity
        === -SPEED_TRIANGLE_VELOCITY_RATIO * snap.runtime.angularVelocity,
    "triangle always equals 1.5× wheel speed"
);

// applyAcceleration must not override SPEED
physicsEngine.applyAcceleration(gameId, Math.PI * 2);

snap = physicsEngine.getSimulation(gameId);

assert(
    snap.runtime.angularVelocity === threeHold.wheelAngularVelocity,
    "acceleration path must not change SPEED velocities"
);

controller._handleSpeedCompleted({
    gameId,
    phase: "SPEED"
});

snap = physicsEngine.getSimulation(gameId);

assert(
    snap.runtime.speedActive === true,
    "SPEED completion keeps kinematic motion for BRAKE handoff"
);

assert(
    snap.runtime.angularVelocity === threeHold.wheelAngularVelocity,
    "final SPEED velocities preserved"
);

console.log("speed.phase.test.js passed");
