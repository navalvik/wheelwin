import assert from "node:assert/strict";

import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameClockBroadcaster } from "../gameplay/GameClockBroadcaster.js";
import { GAME_CLOCK_MESSAGE_TYPE } from "../socket/gameplayClockProtocol.js";
import { SocketGateway } from "../socket/SocketGateway.js";
import { PhysicsEngine as ClientPhysicsEngine } from "../../client/src/game/physics/PhysicsEngine.js";

class TestEventBus {

    constructor() {

        this.handlers = new Map();

    }

    subscribe(type, handler) {

        const handlers = this.handlers.get(type) ?? new Set();

        handlers.add(handler);

        this.handlers.set(type, handlers);

    }

    unsubscribe(type, handler) {

        this.handlers.get(type)?.delete(handler);

    }

    emit(envelope) {

        for (const handler of this.handlers.get(envelope.type) ?? []) {

            handler(envelope);

        }

    }

}

const eventBus = new TestEventBus();
const gameId = "game-second-snapshot";
const roomId = "room-three-players";
const recipients = Array.from({ length: 3 }, () => []);
const emissions = [];
const intervalCallbacks = [];
let intervalMs = null;
let serverNow = 1000;
let phase = "SELF_TEST";
let remainingMs = 2000;
const runtime = {
    angle: 0.25,
    triangleAngle: 5.8,
    angularVelocity: 0.2,
    triangleAngularVelocity: -0.3,
    simulationTimeMs: 500
};

const gateway = Object.create(SocketGateway.prototype);
gateway._io = {
    to(targetRoomId) {

        assert.equal(targetRoomId, roomId);

        return {
            emit(channel, message) {

                emissions.push({ channel, message });

                for (const recipient of recipients) {

                    recipient.push(message.payload);

                }

            }
        };

    }
};
gateway._gameplayContextResolver = {
    resolveRoomByGameId: (id) => id === gameId ? roomId : null
};
eventBus.subscribe(EVENT_TYPES.CLOCK_UPDATE, ({ payload }) => {

    gateway._handleClockUpdate(payload);

});

const broadcaster = new GameClockBroadcaster({
    logger: { info() {}, error() {} },
    eventBus,
    gameClockEngine: {
        getClock: () => ({ currentPhase: phase, running: true }),
        getRemaining: () => remainingMs,
        getPhaseSchedule: () => ({ startedAt: serverNow - 500, endsAt: serverNow + remainingMs })
    },
    gameStateEngine: { getState: () => phase },
    physicsEngine: { getSimulation: () => ({ runtime }) },
    setIntervalFn(callback, ms) {

        intervalMs = ms;

        intervalCallbacks.push(callback);

        return { unref() {} };

    },
    clearIntervalFn() {},
    nowFn: () => serverNow
});

broadcaster.initialize();
eventBus.emit({ type: EVENT_TYPES.CLOCK_STARTED, payload: { gameId } });

assert.equal(intervalMs, 1000, "server snapshots are scheduled every 1000 ms");
assert.equal(recipients[0].length, 1, "initial authoritative snapshot is immediate");
assert.equal(recipients[0][0].syncSequence, 1);
assert.equal(recipients[0][0].wheelAngle, runtime.angle * 180 / Math.PI);
assert.equal(recipients[0][0].triangleAngle, runtime.triangleAngle * 180 / Math.PI);
assert.equal(recipients[0][0].simulationTimeMs, runtime.simulationTimeMs);

const tick = intervalCallbacks[0];
const phases = ["SPEED", "BRAKE", "RESULT"];
for (const nextPhase of phases) {

    serverNow += 1000;

    phase = nextPhase;

    remainingMs = Math.max(0, remainingMs - 1000);

    runtime.angle += 0.1;

    runtime.triangleAngle -= 0.15;

    runtime.simulationTimeMs += 1000;

    tick();

}

assert.equal(emissions.length, 4, "one room broadcast per sampled second");
assert.ok(emissions.every(({ message }) => message.type === GAME_CLOCK_MESSAGE_TYPE));
for (let recipientIndex = 0; recipientIndex < recipients.length; recipientIndex += 1) {

    assert.deepEqual(
        recipients[recipientIndex].map(({ syncSequence }) => syncSequence),
        [1, 2, 3, 4],
        "one room emission reaches every player with the same ordered snapshots"
    );

}

assert.deepEqual(
    recipients[0].map(({ serverTimestamp }) => serverTimestamp),
    [1000, 2000, 3000, 4000]
);
assert.deepEqual(
    recipients[0].map(({ gameState }) => gameState),
    ["SELF_TEST", "SPEED", "BRAKE", "RESULT"]
);

const clients = recipients.map(() => new ClientPhysicsEngine());
const deliveries = [
    [1, 2, 3, 4],       // all snapshots
    [1, 3, 4],          // one lost snapshot
    [1, 4]              // two consecutive lost snapshots
];
for (let index = 0; index < clients.length; index += 1) {

    for (const sequence of deliveries[index]) {

        const snapshot = recipients[0].find((entry) => entry.syncSequence === sequence);

        assert.ok(snapshot, `snapshot sequence ${sequence} exists`);

        assert.equal(clients[index].applyServerSnapshot(snapshot), true);

    }

}

for (const client of clients) {

    assert.equal(client.wheelAngle, recipients[0][3].wheelAngle);

    assert.equal(client.triangleAngle, recipients[0][3].triangleAngle);

    assert.equal(client._lastServerSnapshotSequence, 4);

}

// A delayed recipient gets the latest state after a delay. A subsequently
// arriving old packet cannot rewind either angle or restart a phase.
serverNow += 1000;
runtime.angle += 0.1;
runtime.triangleAngle -= 0.15;
runtime.simulationTimeMs += 1000;
tick();
const sequenceFive = recipients[0][4];
serverNow += 1000;
runtime.angle += 0.1;
runtime.triangleAngle -= 0.15;
runtime.simulationTimeMs += 1000;
tick();
const sequenceSix = recipients[0][5];
for (const client of clients) {

    assert.equal(client.applyServerSnapshot(sequenceSix), true);

}
assert.equal(clients[1].applyServerSnapshot(sequenceFive), false,
    "delayed lower sequence is ignored after the current state arrives");
assert.equal(clients[1].applyServerSnapshot(recipients[0][2]), false,
    "an old out-of-order packet is ignored");

for (const client of clients) {

    assert.equal(client.wheelAngle, sequenceSix.wheelAngle);

    assert.equal(client.triangleAngle, sequenceSix.triangleAngle);

    assert.equal(client._lastServerSnapshotSequence, 6);

}

broadcaster.shutdown();
console.log("gameplaySecondSnapshotSync.test.js: all assertions passed");
