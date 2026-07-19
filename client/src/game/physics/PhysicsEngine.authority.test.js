import {
    bindAuthoritativeSessionStore,
    isServerAuthoritative
} from "../gameAuthority.js";

import {
    AUTHORITATIVE_SESSION_ACTIONS,
    createAuthoritativeSessionStore
} from "../session/authoritativeSessionModel.js";

import { GAME_STATES } from "../GameState.js";

import { PhysicsEngine } from "./PhysicsEngine.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

{

    bindAuthoritativeSessionStore(null);

    const engine = new PhysicsEngine();

    engine.prepare();

    assert(engine.wheelSpeed > 0, "offline prepare may initialize speed");

    assert(
        isServerAuthoritative() === false,
        "no session → not authoritative"
    );

    console.log("  offline prepare allowed passed");

}

{

    const store = createAuthoritativeSessionStore();

    bindAuthoritativeSessionStore(store);

    store.dispatch({
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START,
        payload: { roomId: "R1", gameId: "g1", players: [] }
    });

    assert(isServerAuthoritative() === true, "after GAME_START");

    const engine = new PhysicsEngine();

    engine.wheelAngle = 42;

    engine.wheelSpeed = 0;

    engine.prepare();

    assert(
        engine.wheelAngle === 42 && engine.wheelSpeed === 0,
        "prepare must no-op under Server Authority"
    );

    engine.handleGameState(GAME_STATES.SELF_TEST);

    assert(
        engine.wheelAngle === 42 && engine.wheelSpeed === 0,
        "handleGameState SELF_TEST must not prepare under SA"
    );

    engine.handleGameState(GAME_STATES.SPEED);

    assert(
        engine.wheelAngle === 42 && engine.wheelSpeed === 0,
        "handleGameState SPEED must not prepare under SA"
    );

    engine.handleGameState(GAME_STATES.BRAKE);

    assert(
        engine.isBraking() === false,
        "handleGameState BRAKE must not set braking under SA"
    );

    bindAuthoritativeSessionStore(null);

    console.log("  authoritative prepare blocked passed");

}

console.log("PhysicsEngine.authority.test.js: all assertions passed");
