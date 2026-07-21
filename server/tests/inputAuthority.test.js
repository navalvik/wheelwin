import { GameCatalog } from "../catalog/GameCatalog.js";
import { INPUT_RULES } from "../catalog/InputRules.js";
import { EventBus } from "../events/EventBus.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { InputAuthority } from "../input/InputAuthority.js";
import { PLAYER_STATE } from "../models/PlayerState.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { LoggerService } from "../services/LoggerService.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function createFastCatalog() {

    const catalog = new GameCatalog({ logger: new LoggerService() });

    catalog.initialize();

    return {
        getInputRules() {

            return {
                ...INPUT_RULES,
                pressCooldownMs: 0
            };

        },
        getColors: () => catalog.getColors(),
        getIcons: () => catalog.getIcons(),
        getStakes: () => catalog.getStakes(),
        getTimers: () => catalog.getTimers(),
        getWheelRules: () => catalog.getWheelRules()
    };

}

const logger = new LoggerService();

logger.initialize();

const eventBus = new EventBus({
    logger,
    eventBusConfig: { logEvents: false, showDebugPanel: false }
});

eventBus.initialize();

const playerManager = new PlayerManager({ logger, eventBus });

playerManager.initialize();

const physicsEngine = new PhysicsEngine({
    logger,
    eventBus,
    gameClock: null
});

physicsEngine.initialize();

const gameStateEngine = new GameStateEngine({ logger, eventBus });

gameStateEngine.initialize();

const inputAuthority = new InputAuthority({
    logger,
    eventBus,
    gameCatalog: createFastCatalog(),
    playerManager,
    physicsEngine,
    gameStateEngine
});

inputAuthority.initialize();

const gameId = "input-test-game";

const player = playerManager.createPlayer({ nickname: "Tester" });

const playerId = player.identity.playerId;

playerManager.setPlayerState(playerId, PLAYER_STATE.PLAYING);

gameStateEngine.initializeGameState(gameId);

gameStateEngine.transition(gameId, GAME_STATES.READY, { reason: "test" });

gameStateEngine.transition(gameId, GAME_STATES.SELF_TEST, { reason: "test" });

gameStateEngine.transition(gameId, GAME_STATES.SPEED, { reason: "test" });

physicsEngine.createSimulation(gameId);

physicsEngine.startSimulation(gameId);

inputAuthority.registerPlayer(gameId, playerId);

for (let cycle = 0; cycle < 3; cycle += 1) {

    assert(
        inputAuthority.handleButtonPress(gameId, playerId),
        `press ${cycle + 1} should be accepted`
    );

    assert(
        inputAuthority.handleButtonRelease(gameId, playerId),
        `release ${cycle + 1} should be accepted`
    );

}

const lockedState = inputAuthority.getPlayerInputState(gameId, playerId);

assert(lockedState.locked, "player should be locked after 3 cycles");

assert(
    lockedState.pressCount === 3,
    "press count should be 3"
);

assert(
    inputAuthority.handleButtonPress(gameId, playerId) === null,
    "fourth press should be rejected"
);

const commands = inputAuthority.getAcceptedCommands(gameId);

assert(commands.length === 6, "six commands should be recorded for replay");

assert(
    commands[0].sequenceNumber === 1
        && commands[5].sequenceNumber === 6,
    "sequence numbers should be monotonic"
);

assert(
    gameStateEngine.transition(gameId, GAME_STATES.BRAKE, { reason: "test" }),
    "transition out of speed should succeed"
);

assert(
    inputAuthority.handleButtonPress(gameId, playerId) === null,
    "input outside SPEED should be rejected"
);

inputAuthority.shutdown();

playerManager.shutdown();

physicsEngine.shutdown();

gameStateEngine.shutdown();

logger.info("InputAuthority tests passed");
