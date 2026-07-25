/**
 * R7.0B — Drain gates reject new rooms / setup sessions.
 */

import { EventBus } from "../events/EventBus.js";
import { RoomManager } from "../managers/RoomManager.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { ApplicationLifecycleManager } from "../lifecycle/ApplicationLifecycleManager.js";
import { APPLICATION_LIFECYCLE } from "../lifecycle/ApplicationLifecycleStates.js";
import { LoggerService } from "../services/LoggerService.js";
import { loadRoomConfig } from "../config/rooms.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

const logger = new LoggerService({ logLevel: "error" });

logger.initialize();

const eventBus = new EventBus({
    logger,
    eventBusConfig: { logEvents: false, showDebugPanel: false }
});

eventBus.initialize();

const roomConfig = loadRoomConfig({
    ROOM_MAX_PLAYERS: "3",
    ROOM_MAX_CONCURRENT: "10"
});

const lifecycle = new ApplicationLifecycleManager({
    logger,
    gracefulShutdownTimeoutMs: 200,
    pollIntervalMs: 40,
    activityProvider: () => ({
        setupSessions: 0,
        activeGames: 0,
        paymentSessions: 0,
        pendingPayments: 0,
        settlements: 0,
        pendingTeardowns: 0,
        activeSimulations: 0,
        recoverySessions: 0,
        resultSessions: 0
    })
});

lifecycle.markRunning();

const roomManager = new RoomManager({
    logger,
    eventBus,
    roomConfig
});

const setupSessionLifecycle = new SetupSessionLifecycle({
    logger,
    eventBus,
    roomManager,
    roomConfig,
    devMode: false
});

setupSessionLifecycle.initialize();

roomManager.attachSetupSessionLifecycle(setupSessionLifecycle);

roomManager.attachLifecycleGate(lifecycle);

setupSessionLifecycle.attachLifecycleGate(lifecycle);

roomManager.initialize();

const room = roomManager.createRoom();

assert(room != null, "createRoom should succeed while RUNNING");

assert(
    setupSessionLifecycle.getActiveSessionCount() === 1,
    "setup session should exist for created room"
);

await lifecycle.beginDrain({ reason: "gate_test" });

assert(
    lifecycle.getState() === APPLICATION_LIFECYCLE.DRAINING,
    "expected DRAINING"
);

const rejected = roomManager.createRoom();

assert(rejected == null, "createRoom must be rejected during DRAINING");

const fakeRoom = {
    roomId: "ZZZZZZ",
    status: "WAITING_FOR_PLAYERS",
    maxPlayers: 3,
    players: []
};

const rejectedSetup = setupSessionLifecycle.createForRoom(fakeRoom);

assert(
    rejectedSetup == null,
    "createForRoom must be rejected during DRAINING"
);

lifecycle.markStopped();

console.log("drainGate.test.js: OK");
