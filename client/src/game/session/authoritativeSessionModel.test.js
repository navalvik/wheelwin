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

// P6.7 — GAME_START_AUTHORIZED / GAME_INITIALIZING stamp lifecycle only.
{

    let state = authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START_AUTHORIZED,
            payload: { roomId: "ROOM01", gameId: "G1" }
        }
    );

    assert(
        state.lifecycle.gameStartAuthorized === true,
        "GAME_START_AUTHORIZED stamps lifecycle"
    );

    assert(
        state.lifecycle.gameInitializing !== true,
        "initializing waits for GAME_INITIALIZING"
    );

    state = authoritativeSessionReducer(state, {
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_INITIALIZING,
        payload: { roomId: "ROOM01", gameId: "G1" }
    });

    assert(
        state.lifecycle.gameInitializing === true,
        "GAME_INITIALIZING stamps lifecycle"
    );

    console.log("  GAME_START_AUTHORIZED lifecycle stamp passed");

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

// R7.70C10 — playerIndex survives authoritative payment session projection.
{

    const state = authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.PAYMENT_SESSION_UPDATED,
            payload: {
                paymentSessionId: "pay_stake",
                roomId: "ROOM83",
                gameId: "G_STAKE",
                status: "WAITING_FOR_PAYMENTS",
                participants: [
                    {
                        playerId: "player_a",
                        playerIndex: 0,
                        requiredGram: 1,
                        status: "AWAITING_PLAYER_CONFIRMATION",
                        wallet: "EQwalletA_for_unit_tests_only________",
                        paymentReference: "payref_pay_stake_player_a",
                        contractAddress: "EQescrow_for_unit_tests_only_________",
                        txHash: null
                    },
                    {
                        playerId: "player_b",
                        playerIndex: 1,
                        requiredGram: 1,
                        status: "AWAITING_PLAYER_CONFIRMATION",
                        wallet: "EQwalletB_for_unit_tests_only________",
                        paymentReference: "payref_pay_stake_player_b",
                        contractAddress: "EQescrow_for_unit_tests_only_________",
                        txHash: null
                    },
                    {
                        playerId: "player_c",
                        playerIndex: 2,
                        requiredGram: 1,
                        status: "AWAITING_PLAYER_CONFIRMATION",
                        wallet: "EQwalletC_for_unit_tests_only________",
                        paymentReference: "payref_pay_stake_player_c",
                        contractAddress: "EQescrow_for_unit_tests_only_________",
                        txHash: null
                    }
                ]
            }
        }
    );

    const seats = state.paymentSession?.participants ?? [];

    assert(seats.length === 3, "three payment seats mirrored");
    assert(seats[0].playerIndex === 0, "playerIndex 0 preserved from server");
    assert(seats[1].playerIndex === 1, "playerIndex 1 preserved from server");
    assert(seats[2].playerIndex === 2, "playerIndex 2 preserved from server");
    assert(
        seats[0].paymentReference === "payref_pay_stake_player_a",
        "paymentReference still preserved"
    );
    assert(
        seats[0].contractAddress === "EQescrow_for_unit_tests_only_________",
        "contractAddress still preserved"
    );
    assert(seats[0].wallet === "EQwalletA_for_unit_tests_only________",
        "wallet still preserved");
    assert(seats[0].txHash === null, "txHash still preserved");

    console.log("  R7.70C10 playerIndex projection passed");

}

// P6.4 — GAME_CONTRACT_UPDATED mirrors identifier + state only.
{

    const state = authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.GAME_CONTRACT_UPDATED,
            payload: {
                contractId: "contract_1",
                roomId: "ROOM01",
                gameId: "G1",
                status: "AWAITING_PAYMENTS",
                createdAt: 99
            }
        }
    );

    assert(
        state.gameContract?.contractId === "contract_1",
        "gameContract id stamped"
    );

    assert(
        state.gameContract?.status === "AWAITING_PAYMENTS",
        "gameContract status mirrored"
    );

    assert(
        state.gameContract?.snapshot === undefined,
        "client must not receive contract snapshot body"
    );

    console.log("  GAME_CONTRACT_UPDATED mirror passed");

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

// R18 S4 — deposit projection mirrors the server payload verbatim (no local
// seat/creator/amount derivation, no funding inference).
{
    const state = authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.DEPOSIT_PACKAGE_PUBLISHED,
            payload: {
                deposit: {
                    phase: "AWAITING_FUNDS",
                    depositId: "dep_1",
                    depositAddress: "EQD_TEST_DEPOSIT",
                    network: "testnet",
                    package: { baseStake: "10", depositAmount: "1000000000" },
                    mySeatIndex: 0,
                    isCreator: true,
                    mySeatStatus: "PENDING",
                    myExpectedAmountNanotons: 1000000000,
                    confirmedSeats: 0
                }
            }
        }
    );

    assert(state.deposit !== null, "deposit must be stored");

    assert(state.deposit.phase === "AWAITING_FUNDS", "phase mirrored");

    assert(state.deposit.depositId === "dep_1", "depositId mirrored");

    assert(state.deposit.mySeatIndex === 0, "seat index mirrored (server-derived)");

    assert(state.deposit.isCreator === true, "creator flag mirrored (server-derived)");

    assert(
        state.deposit.myExpectedAmountNanotons === 1000000000,
        "expected amount mirrored (server-derived)"
    );

    assert(
        state.deposit.package.baseStake === "10",
        "package payload mirrored"
    );

    assert(Object.isFrozen(state.deposit), "deposit must be frozen");

    assert(
        state.deposit.mySeatStatus === "PENDING"
            && state.deposit.confirmedSeats === 0,
        "seat status / confirmed seats mirrored"
    );

    console.log("  DEPOSIT_PACKAGE_PUBLISHED requester-scoped mirror passed");

}

// R18-S16 — activationStatus is mirrored from the server projection; VERIFIED
// stamps lifecycle.depositActivationVerified without inventing a deposit.
{
    const withStatus = authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.DEPOSIT_PACKAGE_PUBLISHED,
            payload: {
                deposit: {
                    phase: "AWAITING_FUNDS",
                    depositId: "dep_act",
                    activationStatus: "VERIFIED",
                    mySeatIndex: 1,
                    isCreator: false,
                    confirmedSeats: 0
                }
            }
        }
    );

    assert(
        withStatus.deposit.activationStatus === "VERIFIED",
        "activationStatus mirrored from projection"
    );

    assert(
        withStatus.lifecycle.depositActivationVerified === true,
        "VERIFIED projection stamps lifecycle.depositActivationVerified"
    );

    const viaEvent = authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.DEPOSIT_ACTIVATION_VERIFIED,
            payload: {
                depositId: "dep_act",
                roomId: "room-1",
                status: "VERIFIED"
            }
        }
    );

    assert(
        viaEvent.lifecycle.depositActivationVerified === true,
        "DEPOSIT_ACTIVATION_VERIFIED stamps lifecycle without inventing deposit"
    );

    assert(
        viaEvent.deposit === null,
        "activation event must not invent a deposit projection"
    );

    const rejected = authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.DEPOSIT_ACTIVATION_VERIFIED,
            payload: { status: "REJECTED" }
        }
    );

    assert(
        rejected.lifecycle.depositActivationVerified === false,
        "non-verified activation status must not open the FundSeat gate"
    );

    console.log("  DEPOSIT_ACTIVATION_VERIFIED mirror passed");

}

// R18 S4 — store dispatch exercises the exact AuthoritativeSessionContext path
// (context.onDepositPackagePublished → store.dispatch). Reducer is the same.
{
    const store = createAuthoritativeSessionStore();

    const payload = {
        deposit: {
            phase: "AWAITING_FUNDS",
            depositId: "dep_store",
            mySeatIndex: 1,
            isCreator: false,
            confirmedSeats: 2
        }
    };

    const byContext = store.dispatch({
        type: AUTHORITATIVE_SESSION_ACTIONS.DEPOSIT_PACKAGE_PUBLISHED,
        payload
    });

    assert(
        byContext.deposit.depositId === "dep_store"
            && byContext.deposit.isCreator === false,
        "store dispatch stores the requester-scoped projection"
    );

    console.log("  store dispatch (context path) passed");

}

// R18 S4 — invalid / missing payload fails closed (existing deposit unchanged).
{
    const seeded = authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.DEPOSIT_PACKAGE_PUBLISHED,
            payload: { deposit: { depositId: "dep_keep" } }
        }
    );

    const afterNullPayload = authoritativeSessionReducer(seeded, {
        type: AUTHORITATIVE_SESSION_ACTIONS.DEPOSIT_PACKAGE_PUBLISHED,
        payload: null
    });

    assert(
        afterNullPayload.deposit.depositId === "dep_keep",
        "null payload must leave existing deposit untouched"
    );

    const afterMissingDeposit = authoritativeSessionReducer(seeded, {
        type: AUTHORITATIVE_SESSION_ACTIONS.DEPOSIT_PACKAGE_PUBLISHED,
        payload: { foo: "bar" }
    });

    assert(
        afterMissingDeposit.deposit.depositId === "dep_keep",
        "missing deposit key must fail closed"
    );

    const afterInvalidDeposit = authoritativeSessionReducer(seeded, {
        type: AUTHORITATIVE_SESSION_ACTIONS.DEPOSIT_PACKAGE_PUBLISHED,
        payload: { deposit: "not-an-object" }
    });

    assert(
        afterInvalidDeposit.deposit.depositId === "dep_keep",
        "non-object deposit must fail closed"
    );

    console.log("  DEPOSIT_PACKAGE_PUBLISHED invalid payload fail-closed passed");

}

// R18 S4 — RESET clears the deposit mirror; existing payment/gameContract stays
// untouched by the deposit action and is properly reset too.
{
    let state = authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.PAYMENT_SESSION_UPDATED,
            payload: {
                paymentSessionId: "ps_1",
                status: "ACTIVE",
                participants: []
            }
        }
    );

    state = authoritativeSessionReducer(state, {
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_CONTRACT_UPDATED,
        payload: {
            contractId: "contract_1",
            status: "AWAITING_PAYMENTS"
        }
    });

    state = authoritativeSessionReducer(state, {
        type: AUTHORITATIVE_SESSION_ACTIONS.DEPOSIT_PACKAGE_PUBLISHED,
        payload: { deposit: { depositId: "dep_1", phase: "AWAITING_FUNDS" } }
    });

    assert(state.deposit.depositId === "dep_1", "deposit set pre-reset");

    // The deposit action must never clobber the payment/game-contract mirrors.
    assert(
        state.paymentSession?.status === "ACTIVE",
        "payment session unchanged by deposit action"
    );

    assert(
        state.gameContract?.status === "AWAITING_PAYMENTS",
        "game contract unchanged by deposit action"
    );

    const reset = authoritativeSessionReducer(state, {
        type: AUTHORITATIVE_SESSION_ACTIONS.RESET
    });

    assert(reset.deposit === null, "RESET clears deposit state");

    assert(reset.gameContract === null, "RESET clears existing game-contract state");

    assert(reset.paymentSession === null, "RESET clears existing payment-session state");

    console.log("  RESET clears deposit (payment/game-contract preserved until reset) passed");
}

console.log("authoritativeSessionModel.test.js: all assertions passed");
