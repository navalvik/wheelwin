import assert from "node:assert/strict";

import { GAME_STATES } from "./GameState.js";
import {
    INITIAL_GAME_CLOCK,
    reduceGameClockUpdate,
    resolveGameplayCountdown
} from "./gameClock/gameClockView.js";
import { PhysicsEngine } from "./physics/PhysicsEngine.js";
import {
    AUTHORITATIVE_SESSION_ACTIONS,
    AUTHORITATIVE_SESSION_INITIAL_STATE,
    authoritativeSessionReducer
} from "./session/authoritativeSessionModel.js";
import { normalizeSessionSnapshot } from "./sessionRecovery/sessionSnapshotUtils.js";
import { resolveGameplayRecoveryPage } from "./sessionRecovery/recoveryFlow.js";

const gameId = "page5-three-client-game";
const clients = Array.from({ length: 3 }, () => ({
    session: authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START,
            payload: { gameId, roomId: "room-three-client" }
        }
    ),
    physics: new PhysicsEngine(),
    clock: INITIAL_GAME_CLOCK
}));

// Virtual-time delivery profiles exercise 1/5/15/40 second queues without
// making the regression test sleep or depend on socket timing.
const deliveryProfilesMs = [
    { speed: 40000, brake: 15000, result: 1000 },
    { speed: 15000, brake: 5000, result: 1000 },
    { speed: 5000, brake: 1000, result: 40000 }
];
assert.deepEqual(
    [...new Set(deliveryProfilesMs.flatMap((profile) => Object.values(profile)))].sort(
        (left, right) => left - right
    ),
    [1000, 5000, 15000, 40000]
);
const emittedUpdates = [
    { state: GAME_STATES.SPEED, revision: 4, emittedAt: 0 },
    { state: GAME_STATES.BRAKE, revision: 5, emittedAt: 1000 },
    { state: GAME_STATES.RESULT, revision: 6, emittedAt: 2000 }
];
for (let clientIndex = 0; clientIndex < clients.length; clientIndex += 1) {

    const client = clients[clientIndex];
    const profile = deliveryProfilesMs[clientIndex];
    const arrivals = emittedUpdates.map((update) => ({
        ...update,
        deliveredAt: update.emittedAt + profile[update.state.toLowerCase()]
    })).sort((left, right) => left.deliveredAt - right.deliveredAt);

    for (const update of arrivals) {

        client.session = authoritativeSessionReducer(client.session, {
            type: AUTHORITATIVE_SESSION_ACTIONS.GAME_STATE,
            payload: { gameId, state: update.state, revision: update.revision }
        });

    }

    assert.equal(client.session.gameState, GAME_STATES.RESULT);

}

const storeState = authoritativeSessionReducer(
    AUTHORITATIVE_SESSION_INITIAL_STATE,
    {
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START,
        payload: { gameId, roomId: "room-three-client" }
    }
);
const resultState = authoritativeSessionReducer(storeState, {
    type: AUTHORITATIVE_SESSION_ACTIONS.GAME_STATE,
    payload: { gameId, state: GAME_STATES.RESULT, revision: 6 }
});
const staleState = authoritativeSessionReducer(resultState, {
    type: AUTHORITATIVE_SESSION_ACTIONS.GAME_STATE,
    payload: { gameId, state: GAME_STATES.BRAKE, revision: 5 }
});

assert.equal(staleState, resultState, "stale session updates are ignored");
const nextGameState = authoritativeSessionReducer(resultState, {
    type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START,
    payload: { gameId: "page5-next-game", roomId: "room-three-client" }
});
const nextGamePhase = authoritativeSessionReducer(nextGameState, {
    type: AUTHORITATIVE_SESSION_ACTIONS.GAME_STATE,
    payload: {
        gameId: "page5-next-game",
        state: GAME_STATES.PRE_GAME_READY,
        revision: 1
    }
});
assert.equal(nextGamePhase.gameState, GAME_STATES.PRE_GAME_READY,
    "a new authoritative game can start after the previous RESULT");

let clock = reduceGameClockUpdate({
    gameId,
    phase: GAME_STATES.BRAKE,
    startedAt: 2000,
    remainingMs: 10000,
    remainingSeconds: 10,
    running: true,
    serverTimestamp: 3000
}, INITIAL_GAME_CLOCK, 500);
clock = reduceGameClockUpdate({
    gameId,
    phase: GAME_STATES.SPEED,
    startedAt: 1000,
    remainingMs: 50000,
    remainingSeconds: 50,
    running: true,
    serverTimestamp: 4000
}, clock, 2000);

assert.equal(clock.phase, GAME_STATES.BRAKE, "older clock phase is ignored");
assert.equal(resolveGameplayCountdown(clock, 2500), 8,
    "countdown advances on monotonic local time, independent of wall-clock skew");

const physics = new PhysicsEngine();
assert.equal(physics.applyServerUpdate({
    gameId,
    simulationTimeMs: 900,
    wheelAngle: 90
}), true);
assert.equal(physics.applyServerUpdate({
    gameId,
    simulationTimeMs: 800,
    wheelAngle: 180
}), false);
assert.equal(physics.wheelAngle, 90, "late physics cannot rewind the wheel");

const recoveryPayload = normalizeSessionSnapshot({
    gameId,
    roomId: "room-three-client",
    gameState: { currentState: GAME_STATES.RESULT, revision: 6 },
    physics: {
        wheelAngle: 123,
        triangleAngle: 45,
        simulationTimeMs: 12000
    },
    openPage6: true
});
assert.equal(recoveryPayload.gameStateRevision, 6);
assert.equal(recoveryPayload.physics.simulationTimeMs, 12000);
assert.equal(resolveGameplayRecoveryPage(recoveryPayload), 8,
    "recovery snapshot routes all clients to authoritative Page6");

const staleRecoveryState = authoritativeSessionReducer(resultState, {
    type: AUTHORITATIVE_SESSION_ACTIONS.SESSION_SNAPSHOT,
    payload: {
        gameId,
        roomId: "room-three-client",
        gameState: { currentState: GAME_STATES.SPEED, revision: 4 }
    }
});
assert.equal(staleRecoveryState, resultState,
    "late recovery snapshots cannot demote the active result state");

const isolatedClients = Array.from({ length: 50 }, (_, index) => ({
    gameId: `room-${index}`,
    session: authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START,
            payload: {
                gameId: `game-${index}`,
                roomId: `room-${index}`
            }
        }
    )
}));
for (const client of isolatedClients) {

    client.session = authoritativeSessionReducer(client.session, {
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_STATE,
        payload: {
            gameId: `game-${client.gameId.slice("room-".length)}`,
            state: GAME_STATES.BRAKE,
            revision: 5
        }
    });

    assert.equal(client.session.gameState, GAME_STATES.BRAKE);

}
const crossRoomSession = authoritativeSessionReducer(isolatedClients[1].session, {
    type: AUTHORITATIVE_SESSION_ACTIONS.GAME_STATE,
    payload: {
        gameId: "game-0",
        state: GAME_STATES.RESULT,
        revision: 6
    }
});
assert.equal(crossRoomSession, isolatedClients[1].session,
    "a packet from one room cannot affect another room");
assert.equal(isolatedClients[1].session.gameState, GAME_STATES.BRAKE);

console.log("page5ThreeClientSync.test.js: all assertions passed");
