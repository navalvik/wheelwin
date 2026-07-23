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

    assert(state.entryPayment === null, "entryPayment must start empty");

    assert(state.setup === null, "setup must start empty");

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

// Redacted PLAYER_UPDATE must not wipe a private profile reveal.
{

    let state = authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START,
            payload: {
                roomId: "R2",
                players: [
                    { playerId: "p1", nickname: null, sectorCount: null },
                    { playerId: "p2", nickname: null, sectorCount: null },
                    { playerId: "p3", nickname: null, sectorCount: null }
                ]
            }
        }
    );

    assert(
        Object.keys(state.players).length === 3,
        "startGame seeds all Verify seats"
    );

    state = authoritativeSessionReducer(state, {
        type: AUTHORITATIVE_SESSION_ACTIONS.PLAYER_UPDATE,
        payload: {
            playerId: "p1",
            nickname: "Alex",
            age: 30,
            sectorCount: 2,
            sectorValue: "2"
        }
    });

    state = authoritativeSessionReducer(state, {
        type: AUTHORITATIVE_SESSION_ACTIONS.PLAYER_UPDATE,
        payload: {
            playerId: "p1",
            nickname: null,
            age: null,
            sectorCount: null,
            sectorValue: null
        }
    });

    assert(
        state.players.p1.nickname === "Alex",
        "redacted update must not wipe private nickname"
    );

    assert(
        state.players.p1.sectorCount === 2,
        "redacted update must not wipe private sectorCount"
    );

    assert(
        Object.keys(state.players).length === 3,
        "roster seats remain after redacted peer updates"
    );

    console.log("  verify barrier redaction preserve passed");

}

// VERIFY_COMPLETED roster replaces redacted peer seats.
{

    let state = authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START,
            payload: {
                roomId: "R3",
                players: [
                    { playerId: "p1", nickname: null },
                    { playerId: "p2", nickname: null },
                    { playerId: "p3", nickname: null }
                ]
            }
        }
    );

    state = authoritativeSessionReducer(state, {
        type: AUTHORITATIVE_SESSION_ACTIONS.PLAYER_UPDATE,
        payload: {
            playerId: "p1",
            nickname: "Alex",
            age: 30,
            sectorCount: 1,
            sectorValue: "1"
        }
    });

    state = authoritativeSessionReducer(state, {
        type: AUTHORITATIVE_SESSION_ACTIONS.VERIFY_COMPLETED,
        payload: {
            roomId: "R3",
            players: [
                {
                    playerId: "p1",
                    nickname: "Alex",
                    age: 30,
                    icon: "🎲",
                    sectorCount: 1,
                    sectorValue: "1"
                },
                {
                    playerId: "p2",
                    nickname: "Blake",
                    age: 25,
                    icon: "🎯",
                    sectorCount: 2,
                    sectorValue: "2"
                },
                {
                    playerId: "p3",
                    nickname: "Casey",
                    age: 28,
                    icon: "⭐",
                    sectorCount: 1,
                    sectorValue: "1"
                }
            ]
        }
    });

    assert(
        state.lifecycle.verifyCompleted === true,
        "verifyCompleted stamped"
    );

    assert(
        state.players.p2.nickname === "Blake",
        "VERIFY_COMPLETED must reveal peer nickname"
    );

    assert(
        state.players.p3.age === 28,
        "VERIFY_COMPLETED must reveal peer age"
    );

    assert(
        state.players.p1.nickname === "Alex",
        "local profile remains after roster reveal"
    );

    console.log("  VERIFY_COMPLETED roster reveal passed");

}

// C5.8A — PAYMENT_STAGE_READY stamps lifecycle barrier only.
{

    const state = authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.PAYMENT_STAGE_READY,
            payload: { roomId: "ROOM01" }
        }
    );

    assert(
        state.lifecycle.paymentStageReady === true,
        "paymentStageReady stamped"
    );

    assert(
        state.roomId === "ROOM01",
        "PAYMENT_STAGE_READY preserves roomId"
    );

    assert(
        state.lifecycle.verifyCompleted === false,
        "PAYMENT_STAGE_READY must not alter verifyCompleted"
    );

    console.log("  PAYMENT_STAGE_READY lifecycle stamp passed");

}

// C5.8C — ENTRY_PAYMENT_SESSION_UPDATED mirrors entry payment session.
{

    const state = authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.ENTRY_PAYMENT_SESSION_UPDATED,
            payload: {
                roomId: "ROOM01",
                createdAt: 100,
                smartContractStatus: "waiting",
                players: [
                    {
                        playerId: "p1",
                        wallet: "EQ" + "A".repeat(46),
                        paymentStatus: "waiting"
                    }
                ]
            }
        }
    );

    assert(
        state.entryPayment?.smartContractStatus === "waiting",
        "entryPayment smartContractStatus stamped"
    );

    assert(
        state.entryPayment?.players?.[0]?.paymentStatus === "waiting",
        "entryPayment player paymentStatus stamped"
    );

    assert(
        state.payment === null,
        "ENTRY_PAYMENT_SESSION_UPDATED must not touch settlement payment"
    );

    console.log("  ENTRY_PAYMENT_SESSION_UPDATED mirror passed");

}

// C5.8E — ENTRY_PAYMENT_COMPLETED stamps lifecycle for Page5 navigation.
{

    const state = authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.ENTRY_PAYMENT_COMPLETED,
            payload: { roomId: "ROOM01" }
        }
    );

    assert(
        state.lifecycle.entryPaymentCompleted === true,
        "entryPaymentCompleted stamped"
    );

    assert(
        state.roomId === "ROOM01",
        "ENTRY_PAYMENT_COMPLETED preserves roomId"
    );

    console.log("  ENTRY_PAYMENT_COMPLETED lifecycle stamp passed");

}

// P6.3 — PAYMENT_SESSION_UPDATED mirrors authoritative payment session.
{

    const state = authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.PAYMENT_SESSION_UPDATED,
            payload: {
                paymentSessionId: "pay_1",
                roomId: "ROOM01",
                gameId: "G1",
                status: "ACTIVE",
                expiresAt: 123456,
                participants: [
                    {
                        playerId: "p1",
                        requiredGram: 10,
                        status: "AWAITING_PLAYER_CONFIRMATION"
                    },
                    {
                        playerId: "p2",
                        requiredGram: 25,
                        status: "PAYMENT_CONFIRMED"
                    }
                ]
            }
        }
    );

    assert(
        state.paymentSession?.paymentSessionId === "pay_1",
        "paymentSession id stamped"
    );

    assert(
        state.paymentSession?.participants?.length === 2,
        "paymentSession participants mirrored"
    );

    assert(
        state.paymentSession?.participants?.[0]?.status
            === "AWAITING_PLAYER_CONFIRMATION",
        "participant status mirrored from server"
    );

    assert(
        state.entryPayment === null,
        "PAYMENT_SESSION_UPDATED must not touch legacy entryPayment"
    );

    console.log("  PAYMENT_SESSION_UPDATED mirror passed");

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
