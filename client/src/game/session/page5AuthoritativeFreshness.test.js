import {
    AUTHORITATIVE_SESSION_ACTIONS,
    AUTHORITATIVE_SESSION_INITIAL_STATE,
    authoritativeSessionReducer
} from "./authoritativeSessionModel.js";
import { reduceGameClockUpdate } from "../gameClock/gameClockView.js";
import { PhysicsEngine } from "../physics/PhysicsEngine.js";

function assert(condition, message) {

    if (!condition) throw new Error(message);

}

let session = authoritativeSessionReducer(
    AUTHORITATIVE_SESSION_INITIAL_STATE,
    {
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START,
        payload: { gameId: "game-sync" }
    }
);

session = authoritativeSessionReducer(session, {
    type: AUTHORITATIVE_SESSION_ACTIONS.GAME_STATE,
    payload: { gameId: "game-sync", state: "SPEED", serverTimestamp: 4000 }
});

const afterStalePhase = authoritativeSessionReducer(session, {
    type: AUTHORITATIVE_SESSION_ACTIONS.GAME_STATE,
    payload: { gameId: "game-sync", state: "SELF_TEST", serverTimestamp: 5000 }
});

assert(afterStalePhase === session, "older phase is ignored even when timestamp is newer");

const afterOldTimestamp = authoritativeSessionReducer(session, {
    type: AUTHORITATIVE_SESSION_ACTIONS.GAME_STATE,
    payload: { gameId: "game-sync", state: "BRAKE", serverTimestamp: 3000 }
});

assert(afterOldTimestamp === session, "older server timestamp is ignored");

let clock = reduceGameClockUpdate({
    gameId: "game-sync",
    phase: "SPEED",
    remainingMs: 5000,
    serverTimestamp: 5000
});

const afterStaleClock = reduceGameClockUpdate({
    gameId: "game-sync",
    phase: "SELF_TEST",
    remainingMs: 1,
    serverTimestamp: 6000
}, clock);

assert(afterStaleClock === clock, "stale clock phase is ignored");

clock = reduceGameClockUpdate({
    gameId: "game-sync",
    phase: "BRAKE",
    remainingMs: 4000,
    serverTimestamp: 7000
}, clock);

const afterDelayedClock = reduceGameClockUpdate({
    gameId: "game-sync",
    phase: "BRAKE",
    remainingMs: 5500,
    serverTimestamp: 8000
}, clock);

assert(afterDelayedClock === clock, "same-phase delayed clock cannot restore time");

const physics = new PhysicsEngine();

assert(physics.applyServerUpdate({
    gameId: "game-sync",
    simulationTime: 100,
    wheelAngle: 10,
    triangleAngle: 20
}) === true, "first physics sample is accepted");

assert(physics.applyServerUpdate({
    gameId: "game-sync",
    simulationTime: 140,
    wheelAngle: 14,
    triangleAngle: 24
}) === true, "newest physics sample is accepted without replaying missing samples");

assert(physics.wheelAngle === 14 && physics.triangleAngle === 24,
    "latest wheel and triangle coordinates are applied");

assert(physics.applyServerUpdate({
    gameId: "game-sync",
    simulationTime: 120,
    wheelAngle: 12,
    triangleAngle: 22
}) === false, "out-of-order physics sample is rejected");

assert(physics.wheelAngle === 14 && physics.triangleAngle === 24,
    "rejecting an old sample leaves the latest pose unchanged");

assert(physics.applyServerUpdate({
    gameId: "next-game",
    simulationTime: 0,
    wheelAngle: 1,
    triangleAngle: 2
}) === true, "a new game starts a fresh simulation sequence");

console.log("page5AuthoritativeFreshness.test.js: all assertions passed");
