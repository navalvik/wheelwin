import assert from "node:assert/strict";

import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameStartAuthorization } from "../gameplay/GameStartAuthorization.js";
import { ROOM_STATUS } from "../models/RoomStatus.js";
import {
    assertLivePaymentAcceptanceEnabled,
    LIVE_PAYMENT_ACCEPTANCE_ENABLED,
    LIVE_PAYMENT_ACCEPTANCE_DISABLED_REASON
} from "../payment/PaymentLifecycleAvailability.js";
import {
    assessThreePlayerPaymentGate
} from "../payment/runtime/ThreePlayerPaymentGate.js";

const ROOM_ID = "room-payment-gate-test";
const PLAYER_IDS = ["player-a", "player-b", "player-c"];
const NOW = 1_700_000_000_000;

const requirements = PLAYER_IDS.map((playerId, index) => ({
    roomId: ROOM_ID,
    playerId,
    paymentReference: `WW-GATE-${index + 1}`,
    expectedSender: `sender-${index + 1}`,
    amountAtomic: (index + 1) * 1_000
}));

const intents = requirements.map((requirement, index) => ({
    ...requirement,
    network: "testnet",
    asset: "TON",
    state: "SETTLED",
    transactionId: `transaction-${index + 1}`,
    expiresAt: NOW + 60_000
}));

const principalEntries = requirements.map((requirement, index) => ({
    roomId: ROOM_ID,
    kind: "INCOMING_PRINCIPAL",
    network: "testnet",
    asset: "TON",
    playerId: requirement.playerId,
    amountAtomic: requirement.amountAtomic,
    metadata: {
        paymentReference: requirement.paymentReference,
        transactionId: `transaction-${index + 1}`,
        intentState: "SETTLED",
        source: "SETTLED_PAYMENT_INTENT"
    }
}));

function assess(overrides = {}) {
    return assessThreePlayerPaymentGate({
        roomId: ROOM_ID,
        roomPlayerIds: PLAYER_IDS,
        network: "testnet",
        asset: "TON",
        requirements,
        intents,
        principalEntries,
        nowMs: NOW,
        ...overrides
    });
}

function makeAuthorization({ room, getPaymentStatus }) {
    const listeners = new Map();
    const emitted = [];
    const eventBus = {
        subscribe(type, handler) {
            const handlers = listeners.get(type) ?? new Set();
            handlers.add(handler);
            listeners.set(type, handlers);
        },
        unsubscribe(type, handler) {
            listeners.get(type)?.delete(handler);
        },
        emit(envelope) {
            emitted.push(envelope);
        },
        fire(type, payload) {
            for (const handler of listeners.get(type) ?? []) {
                handler({ payload });
            }
        }
    };
    const authorization = new GameStartAuthorization({
        logger: { info() {} },
        eventBus,
        roomManager: { getRoom: () => room },
        playerManager: { getIdentity: (playerId) => ({ playerId }) },
        gameManager: {
            getPendingGameplayGameId: () => "game-payment-gate-test",
            getGame: () => ({ id: "game-payment-gate-test" })
        },
        configurationEngine: {
            getConfiguration: () => ({ traceSeed: "seed" }),
            validateConfiguration() {}
        },
        paymentGate: { getGameStartGateStatus: getPaymentStatus },
        roomConfig: { gameStartAuthorizationDurationMs: 60_000 }
    });
    authorization.initialize();
    return { authorization, eventBus, emitted };
}

assert.equal(assess().eligible, true, "three independently matched settlements pass");
assert.equal(assess({ roomPlayerIds: PLAYER_IDS.slice(0, 2) }).eligible, false,
    "two players cannot satisfy the gate");
assert.equal(assess({ roomPlayerIds: [PLAYER_IDS[0], PLAYER_IDS[0], PLAYER_IDS[2]] }).eligible, false,
    "duplicate player identities are rejected");

for (const count of [0, 1, 2]) {
    const partialIntents = intents.map((intent, index) => ({
        ...intent,
        state: index < count ? "SETTLED" : "PENDING"
    }));
    assert.equal(assess({ intents: partialIntents }).eligible, false,
        `${count} settled intents cannot satisfy three requirements`);
    assert.equal(assess({ principalEntries: principalEntries.slice(0, count) }).eligible, false,
        `${count} principal entries cannot satisfy three requirements`);
}

for (const mutate of [
    (rows) => { rows[0].playerId = PLAYER_IDS[1]; },
    (rows) => { rows[0].transactionId = "wrong-transaction"; },
    (rows) => { rows[0].amountAtomic += 1; },
    (rows) => { rows[0].paymentReference = requirements[1].paymentReference; },
    (rows) => { rows[0].expectedSender = "another-sender"; },
    (rows) => { rows[0].expiresAt = NOW; }
]) {
    const altered = intents.map((intent) => ({ ...intent }));
    mutate(altered);
    assert.equal(assess({ intents: altered }).eligible, false,
        "mismatched or expired intent cannot satisfy another requirement");
}

const duplicateTransactions = intents.map((intent) => ({ ...intent }));
duplicateTransactions[1].transactionId = duplicateTransactions[0].transactionId;
assert.equal(assess({ intents: duplicateTransactions }).eligible, false,
    "one transaction cannot satisfy multiple player requirements");

for (const mutate of [
    (entry) => { entry.metadata.transactionId = "wrong-transaction"; },
    (entry) => { entry.metadata.source = "CLIENT_CALLBACK"; },
    (entry) => { entry.playerId = PLAYER_IDS[1]; },
    (entry) => { entry.amountAtomic += 1; },
    (entry) => { entry.asset = "OTHER"; }
]) {
    const altered = principalEntries.map((entry) => ({
        ...entry,
        metadata: { ...entry.metadata }
    }));
    mutate(altered[0]);
    assert.equal(assess({ principalEntries: altered }).eligible, false,
        "mismatched principal evidence cannot satisfy a player requirement");
}

assert.equal(assess({ requirements: null }).eligible, false,
    "missing payment requirements fail closed");
assert.equal(LIVE_PAYMENT_ACCEPTANCE_ENABLED, false,
    "live payment acceptance remains disabled unless Testnet is explicitly enabled");
assert.throws(assertLivePaymentAcceptanceEnabled,
    new RegExp(LIVE_PAYMENT_ACCEPTANCE_DISABLED_REASON),
    "the isolated Testnet acceptance CLI remains guarded");

const room = {
    status: ROOM_STATUS.FULL,
    maxPlayers: 3,
    players: [...PLAYER_IDS]
};
let currentStatus = { eligible: false, reason: "payment_state_incomplete" };
const testAuthorization = makeAuthorization({
    room,
    getPaymentStatus: () => currentStatus
});
testAuthorization.eventBus.fire(EVENT_TYPES.VERIFY_BARRIER_COMPLETED, { roomId: ROOM_ID });
assert.equal(testAuthorization.emitted.some(({ type }) =>
    type === EVENT_TYPES.GAME_START_AUTHORIZED), false,
"one or two payments do not authorize gameplay");
currentStatus = {
    eligible: true,
    roomId: ROOM_ID,
    playerIds: [...PLAYER_IDS]
};
testAuthorization.eventBus.fire(EVENT_TYPES.ROOM_PAYMENT_GATE_UPDATED, { roomId: ROOM_ID });
assert.equal(testAuthorization.emitted.filter(({ type }) =>
    type === EVENT_TYPES.GAME_START_AUTHORIZED).length, 1,
"the authoritative gate authorizes only after the complete payment status arrives");
testAuthorization.authorization.shutdown();

const closedAuthorization = makeAuthorization({
    room: { ...room, status: ROOM_STATUS.DESTROYED },
    getPaymentStatus: () => ({ eligible: true, roomId: ROOM_ID, playerIds: [...PLAYER_IDS] })
});
closedAuthorization.eventBus.fire(EVENT_TYPES.VERIFY_BARRIER_COMPLETED, { roomId: ROOM_ID });
assert.equal(closedAuthorization.emitted.some(({ type }) =>
    type === EVENT_TYPES.GAME_START_AUTHORIZED), false,
"a destroyed room cannot authorize gameplay");
closedAuthorization.authorization.shutdown();

process.stdout.write("PASS three-player payment gate (27 assertions)\n");
