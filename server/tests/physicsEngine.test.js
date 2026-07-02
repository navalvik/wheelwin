import { EventBus } from "../events/EventBus.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { PHYSICS_SIMULATION_STATE } from "../engines/physics/PhysicsSimulationState.js";
import { LoggerService } from "../services/LoggerService.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function runDeterministicSequence(physicsEngine, gameId) {

    physicsEngine.createSimulation(gameId);

    physicsEngine.startSimulation(gameId);

    physicsEngine.applyAcceleration(gameId, Math.PI);

    physicsEngine.updateSimulation(gameId, 35);

    physicsEngine.applyBrake(gameId);

    let snapshot = physicsEngine.getSimulation(gameId);

    while (snapshot?.runtime.state === PHYSICS_SIMULATION_STATE.BRAKING) {

        physicsEngine.updateSimulation(gameId, 25);

        snapshot = physicsEngine.getSimulation(gameId);

    }

    return snapshot.runtime.angle;

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

const angleA = runDeterministicSequence(physicsEngine, "physics-determinism-a");

physicsEngine.removeSimulation("physics-determinism-a");

const angleB = runDeterministicSequence(physicsEngine, "physics-determinism-b");

physicsEngine.removeSimulation("physics-determinism-b");

assert(angleA === angleB, "identical input sequences must produce identical angles");

const gameId = "physics-validation";

physicsEngine.createSimulation(gameId);

physicsEngine.startSimulation(gameId);

assert(
    physicsEngine.updateSimulation(gameId, -1) === null,
    "negative deltaTime should be rejected"
);

assert(
    physicsEngine.createSimulation(gameId) === null,
    "duplicate simulation should be rejected"
);

physicsEngine.applyAcceleration(gameId, Math.PI);

physicsEngine.updateSimulation(gameId, 10);

const angle = physicsEngine.getSimulation(gameId).runtime.angle;

assert(angle >= 0 && angle < Math.PI * 2, "angle should stay normalized");

physicsEngine.stopSimulation(gameId);

assert(
    physicsEngine.applyAcceleration(gameId, Math.PI) === null,
    "acceleration on stopped simulation should be rejected"
);

physicsEngine.removeSimulation(gameId);

physicsEngine.shutdown();

logger.info("PhysicsEngine tests passed");
