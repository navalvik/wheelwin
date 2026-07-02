import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { CONNECTION_STATE } from "../models/ConnectionState.js";
import { PLAYER_STATE } from "../models/PlayerState.js";
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

const emitted = [];

for (const type of [
    EVENT_TYPES.PLAYER_CREATED,
    EVENT_TYPES.PLAYER_CONNECTED,
    EVENT_TYPES.PLAYER_RUNTIME_UPDATED,
    EVENT_TYPES.PLAYER_DISCONNECTED,
    EVENT_TYPES.PLAYER_REMOVED
]) {

    eventBus.subscribe(type, (envelope) => {

        emitted.push(envelope.type);

    });

}

const playerManager = new PlayerManager({ logger, eventBus });

playerManager.initialize();

const player = playerManager.createPlayer({
    nickname: "Tester",
    icon: "icon-a"
});

assert(player, "createPlayer should return a player");

const { playerId } = player.identity;

assert(
    playerManager.createPlayer({ playerId }) === null,
    "duplicate playerId should be rejected"
);

assert(playerManager.hasPlayer(playerId), "player should be registered");

const identityBefore = playerManager.getIdentity(playerId);

playerManager.setConnectionState(playerId, CONNECTION_STATE.CONNECTED);

playerManager.setPlayerState(playerId, PLAYER_STATE.PLAYING);

playerManager.setConnectionState(playerId, CONNECTION_STATE.DISCONNECTED);

const runtime = playerManager.getRuntime(playerId);

assert(
    runtime.connectionState === CONNECTION_STATE.DISCONNECTED,
    "connection state should be disconnected"
);

assert(
    runtime.playerState === PLAYER_STATE.PLAYING,
    "player state should remain independent from connection state"
);

assert(
    playerManager.getIdentity(playerId).nickname === identityBefore.nickname,
    "identity should remain unchanged"
);

playerManager.removePlayer(playerId);

assert(!playerManager.hasPlayer(playerId), "removed player should not exist");

assert(
    emitted.join(",") === [
        EVENT_TYPES.PLAYER_CREATED,
        EVENT_TYPES.PLAYER_CONNECTED,
        EVENT_TYPES.PLAYER_RUNTIME_UPDATED,
        EVENT_TYPES.PLAYER_DISCONNECTED,
        EVENT_TYPES.PLAYER_REMOVED
    ].join(","),
    "lifecycle should emit events in order"
);

assert(
    playerManager.setConnectionState("missing", CONNECTION_STATE.CONNECTED) === null,
    "missing player should fail gracefully"
);

assert(
    playerManager.setConnectionState(playerId, "INVALID") === null,
    "invalid connection state should be rejected"
);

const runtimePlayer = playerManager.createPlayer({ nickname: "Runtime" });

playerManager.updateRuntime(runtimePlayer.identity.playerId, { ping: 42 });

assert(
    playerManager.getRuntime(runtimePlayer.identity.playerId).ping === 42,
    "runtime update should apply ping"
);

playerManager.shutdown();

logger.info("PlayerManager tests passed");
