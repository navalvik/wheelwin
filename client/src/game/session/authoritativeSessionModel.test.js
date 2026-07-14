import {
    AUTHORITATIVE_SESSION_ACTIONS,
    AUTHORITATIVE_SESSION_INITIAL_STATE,
    authoritativeSessionReducer,
    createAuthoritativeSessionStore
} from "./authoritativeSessionModel.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

// Starts empty — no fabricated players, stake, room, or timer.
{

    const state = AUTHORITATIVE_SESSION_INITIAL_STATE;

    assert(state.roomId === null, "roomId must start empty");

    assert(state.gameId === null, "gameId must start empty");

    assert(Object.keys(state.players).length === 0, "players must start empty");

    assert(state.configuration === null, "configuration must start empty");

    assert(state.winner === null, "winner must start empty");

    assert(state.payment === null, "payment must start empty");

    assert(state.lifecycle.gameStarted === false, "lifecycle starts idle");

    console.log("  initial empty mirror passed");

}

// GAME_START mirrors room + roster from the server payload only.
{

    const state = authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START,
            payload: {
                roomId: "AB12CD",
                gameId: "game_1",
                players: [
                    { playerId: "p1", nickname: "Alice" },
                    { playerId: "p2", nickname: "Bob" }
                ]
            }
        }
    );

    assert(state.roomId === "AB12CD", "roomId must come from server");

    assert(state.gameId === "game_1", "gameId must come from server");

    assert(state.players.p1.nickname === "Alice", "player fields pass through");

    assert(state.lifecycle.gameStarted === true, "gameStarted mirrors GAME_START");

    assert(state.payment === null, "must not invent payment");

    console.log("  GAME_START mirror passed");

}

// Incomplete GAME_RESULT must not fabricate a winner.
{

    const state = authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.GAME_RESULT,
            payload: { gameId: "game_1", finalWheelAngle: 90 }
        }
    );

    assert(state.winner === null, "angle-only payload must not create a winner");

    console.log("  no fabricated winner passed");

}

// Full lifecycle signals for STEP 4 validation coverage.
{

    const store = createAuthoritativeSessionStore();

    store.dispatch({
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START,
        payload: {
            roomId: "R1",
            gameId: "G1",
            players: ["p1", "p2", "p3"]
        }
    });

    store.dispatch({
        type: AUTHORITATIVE_SESSION_ACTIONS.WHEEL_CONFIGURATION,
        payload: { gameId: "G1", sectors: [{ color: "#f00" }] }
    });

    store.dispatch({
        type: AUTHORITATIVE_SESSION_ACTIONS.PLAYER_OFFLINE,
        payload: { playerId: "p2" }
    });

    store.dispatch({
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_RESULT,
        payload: {
            gameId: "G1",
            winner: { id: "p1", color: "#f00", icon: "dice" },
            winningSector: { index: 0, color: "#f00", icon: "dice" }
        }
    });

    store.dispatch({
        type: AUTHORITATIVE_SESSION_ACTIONS.PAYMENT,
        payload: { gameId: "G1", status: "COMPLETED", winnerId: "p1" }
    });

    store.dispatch({
        type: AUTHORITATIVE_SESSION_ACTIONS.SESSION_SNAPSHOT,
        payload: {
            gameId: "G1",
            roomId: "R1",
            gameState: "RESULT"
        }
    });

    store.dispatch({
        type: AUTHORITATIVE_SESSION_ACTIONS.AUDIT,
        payload: { gameId: "G1", status: "READY", auditId: "a1" }
    });

    const snapshot = store.getSnapshot();

    assert(snapshot.roomId === "R1", "room mirrored");

    assert(snapshot.players.p2.online === false, "offline player mirrored");

    assert(snapshot.configuration.sectors.length === 1, "configuration mirrored");

    assert(snapshot.winner.winner.id === "p1", "winner mirrored");

    assert(snapshot.payment.status === "COMPLETED", "payment mirrored");

    assert(snapshot.recovery.gameId === "G1", "recovery mirrored");

    assert(snapshot.lifecycle.cleanupObserved === true, "cleanup mirrored via audit");

    console.log("  full lifecycle mirror passed");

}

console.log("authoritativeSessionModel.test.js: all assertions passed");
