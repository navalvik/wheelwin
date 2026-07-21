import { INPUT_RULES } from "../catalog/InputRules.js";
import { EventBus } from "../events/EventBus.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { OfflineInputContinuation } from "../gameplay/OfflineInputContinuation.js";
import { SpeedPhaseController } from "../gameplay/SpeedPhaseController.js";
import { InputAuthority } from "../input/InputAuthority.js";
import { PLAYER_STATE } from "../models/PlayerState.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { LoggerService } from "../services/LoggerService.js";
import { EVENT_TYPES } from "../events/EventTypes.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function createCatalog(cooldownMs = 500) {

    return {
        getInputRules() {

            return {
                ...INPUT_RULES,
                pressCooldownMs: cooldownMs,
                maxPressCycles: 3
            };

        }
    };

}

const logger = new LoggerService();

logger.initialize();

const eventBus = new EventBus({
    logger,
    eventBusConfig: { logEvents: false, showDebugPanel: false }
});

eventBus.initialize();

const gameStateEngine = new GameStateEngine({
    logger,
    eventBus
});

gameStateEngine.initialize();

const physicsEngine = new PhysicsEngine({
    logger,
    eventBus,
    gameClock: null
});

physicsEngine.initialize();

const playerManager = new PlayerManager({
    logger,
    eventBus
});

playerManager.initialize();

const gameId = "game-speed-rules";

const playerId = "player-1";

const player = playerManager.createPlayer({
    playerId,
    nickname: "P1"
});

assert(player, "player must be created");

playerManager.setPlayerState(playerId, PLAYER_STATE.PLAYING);

const inputAuthority = new InputAuthority({
    logger,
    eventBus,
    gameCatalog: createCatalog(500),
    playerManager,
    physicsEngine,
    gameStateEngine,
    devMode: false
});

inputAuthority.initialize();

inputAuthority.registerPlayer(gameId, playerId);

gameStateEngine.initializeGameState(gameId);

gameStateEngine.transition(gameId, GAME_STATES.READY, { reason: "test" });

gameStateEngine.transition(gameId, GAME_STATES.SELF_TEST, { reason: "test" });

gameStateEngine.transition(gameId, GAME_STATES.SPEED, { reason: "test" });

physicsEngine.createSimulation(gameId);

physicsEngine.startSimulation(gameId);

const speedController = new SpeedPhaseController({
    logger,
    eventBus,
    physicsEngine,
    inputAuthority,
    devMode: false
});

speedController.initialize();

speedController._handleSpeedStarted({ gameId, phase: GAME_STATES.SPEED });

// Exactly three PRESS→RELEASE cycles
for (let cycle = 1; cycle <= 3; cycle += 1) {

    assert(
        inputAuthority.handleButtonPress(gameId, playerId),
        `PRESS ${cycle} must be accepted`
    );

    const afterPress = inputAuthority.getPlayerInputState(gameId, playerId);

    assert(afterPress.pressed === true, "pressed must be true after PRESS");

    assert(
        afterPress.completedCycles === cycle - 1,
        "PRESS alone must not consume a cycle"
    );

    assert(
        inputAuthority.handleButtonRelease(gameId, playerId),
        `RELEASE ${cycle} must be accepted`
    );

    const afterRelease = inputAuthority.getPlayerInputState(gameId, playerId);

    assert(
        afterRelease.completedCycles === cycle,
        `RELEASE must increment completedCycles to ${cycle}`
    );

    assert(
        afterRelease.lastReleaseAt != null,
        "lastReleaseAt must be set on RELEASE"
    );

    if (cycle < 3) {

        // Enforce 500ms cooldown
        assert(
            inputAuthority.handleButtonPress(gameId, playerId) === null,
            "PRESS within 500ms must be rejected"
        );

        // Clear authoritative cooldown for next cycle (server-owned clock).
        const live = inputAuthority._registries
            .get(gameId)
            .players
            .get(playerId);

        live.cooldownUntil = Date.now() - 1;

    }

}

const locked = inputAuthority.getPlayerInputState(gameId, playerId);

assert(locked.buttonLocked === true, "buttonLocked after third RELEASE");

assert(locked.remainingPresses === 0, "remainingPresses must be 0");

assert(
    inputAuthority.handleButtonPress(gameId, playerId) === null,
    "fourth PRESS must be rejected"
);

// Offline while holding → authoritative RELEASE
inputAuthority.resetPlayer(gameId, playerId);

inputAuthority.clearSpeedInputClosed(gameId);

const offline = new OfflineInputContinuation({
    logger,
    eventBus,
    inputAuthority,
    gameStateEngine,
    playerManager,
    gameCatalog: createCatalog(0),
    devMode: false
});

offline.initialize();

offline._rosters.set(gameId, new Set([playerId]));

assert(inputAuthority.handleButtonPress(gameId, playerId));

offline._handlePlayerDisconnected({ playerId });

const afterOffline = inputAuthority.getPlayerInputState(gameId, playerId);

assert(afterOffline.pressed === false, "offline RELEASE clears pressed");

assert(
    afterOffline.completedCycles === 1,
    "offline RELEASE increments completedCycles"
);

assert(
    offline.getActiveContinuations().length === 0,
    "no synthetic continuation cursors"
);

// SPEED_COMPLETED preserves motion for BRAKE; input stays closed
speedController._handleSpeedCompleted({
    gameId,
    phase: GAME_STATES.SPEED
});

const preserved = physicsEngine.getSimulation(gameId);

assert(
    preserved.runtime.angularVelocity !== 0
        || preserved.runtime.speedActive === true,
    "SPEED end velocities preserved for BRAKE handoff"
);

assert(
    inputAuthority.handleButtonPress(gameId, playerId) === null,
    "PRESS rejected after SPEED_COMPLETED"
);

assert(
    inputAuthority.handleButtonRelease(gameId, playerId) === null,
    "RELEASE rejected after SPEED_COMPLETED"
);

console.log("speed.rules.test.js passed");
