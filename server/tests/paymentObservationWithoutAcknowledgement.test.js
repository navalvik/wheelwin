import assert from "node:assert/strict";
import test from "node:test";

// Exercise the opt-in Testnet path without changing its production guard.
process.env.ROOM_WALLET_PAYMENTS_ENABLED = "true";
process.env.TON_NETWORK = "testnet";

const [{ RoomLobbyBridge }, { EVENT_TYPES }] = await Promise.all([
    import("../socket/RoomLobbyBridge.js"),
    import("../events/EventTypes.js")
]);

test("an authenticated Page4 observation request polls without wallet acknowledgement", async () => {
    const roomId = "room-bob-first";
    const players = ["bob", "olga", "lena"];
    const emitted = [];
    const observed = [];
    const delivered = [];
    const runtime = {
        sessionAdapter: {
            async observeRoomPayments(input) { observed.push(input); }
        },
        paymentForensicJournal: {
            recordObservation() {},
            recordDecision() {}
        },
        paymentService: { getWalletForRoom: () => ({ walletId: 4, address: "test-wallet" }) },
        paymentGate: { getGameStartGateStatus: () => ({ eligible: false }) }
    };
    const bridge = Object.create(RoomLobbyBridge.prototype);
    Object.assign(bridge, {
        _getSocketContext: socketId => ({ socketId, playerId: "bob", roomId }),
        _deliverPaymentStatusToSocket: (...args) => delivered.push(args),
        _roomManager: { getRoom: id => id === roomId ? { players } : null },
        _continueToVerifyByRoom: new Map([[roomId, true]]),
        _verifyBarrierCompletedByRoom: new Set([roomId]),
        _paymentApplicationBinding: { runtime },
        _playerToSocket: new Map(),
        _eventBus: { emit: event => emitted.push(event) },
        _logger: { info() {}, warn() {}, error() {} }
    });

    bridge._handlePaymentStatusRequest("socket-bob", {
        observationRequested: true,
        observationTrigger: "PAGE4_ACTIVE",
        paymentSubmissionAcknowledged: false
    });

    assert.equal(delivered.length, 1, "Page4 receives its own authoritative status");
    assert.equal(observed.length, 0, "the configured grace window precedes the blockchain request");
    const pending = bridge._roomPaymentChecks.get(roomId);
    assert.ok(pending, "the authenticated player's request schedules room observation");
    await pending;
    assert.deepEqual(observed, [{ roomId }], "Bob alone starts the shared active-room wallet poll");
    assert.ok(emitted.some(event => event.type === EVENT_TYPES.PAYMENT_OBSERVATION_REQUESTED
        && event.payload.playerId === "bob"), "the observation request is attributed to Bob");
    assert.equal(emitted.some(event => event.type === EVENT_TYPES.PAYMENT_SUBMISSION_ACKNOWLEDGED), false,
        "no wallet acknowledgement is fabricated");
    assert.equal(observed.length, 1, "Olga and Lena need not signal to start the poll");
});


test("NO_FRIENDS Page4 can observe payments without legacy Page3 VERIFY_NEXT", async () => {
    const roomId = "oVUZ";
    const players = ["bob", "olga", "lena"];
    const observed = [];
    const emitted = [];
    const delivered = [];
    const bridge = Object.create(RoomLobbyBridge.prototype);
    Object.assign(bridge, {
        _getSocketContext: () => ({ playerId: "olga", roomId }),
        _deliverPaymentStatusToSocket: (...args) => delivered.push(args),
        _roomManager: { getRoom: id => id === roomId
            ? { gameMode: "NO_FRIENDS", players } : null },
        // NO_FRIENDS calls _completeVerifyBarrier directly, not VERIFY_NEXT.
        _continueToVerifyByRoom: new Map(),
        _verifyBarrierCompletedByRoom: new Set([roomId]),
        _paymentApplicationBinding: { runtime: {
            sessionAdapter: { async observeRoomPayments(arg) { observed.push(arg); } },
            paymentService: { getWalletForRoom: () => ({ walletId: 2, address: "room-wallet-2" }) },
            paymentGate: { getGameStartGateStatus: () => ({ eligible: true }) },
            paymentForensicJournal: { recordObservation() {}, recordDecision() {} }
        } },
        _playerToSocket: new Map(players.map(playerId => [playerId, "socket-" + playerId])),
        _eventBus: { emit: event => emitted.push(event) },
        _logger: { info() {}, warn() {}, error() {} }
    });

    bridge._handlePaymentStatusRequest("socket-olga", {
        observationRequested: true,
        observationTrigger: "PAGE4_ACTIVE",
        paymentSubmissionAcknowledged: true
    });
    assert.equal(delivered.length, 1, "authoritative player payment status is delivered");
    const pending = bridge._roomPaymentChecks.get(roomId);
    assert.ok(pending, "NO_FRIENDS schedules the active-room observation");
    await pending;
    assert.deepEqual(observed, [{ roomId }], "the payment service is queried for NO_FRIENDS");
    assert.ok(emitted.some(x => x.type === EVENT_TYPES.PAYMENT_OBSERVATION_STARTED),
        "NO_FRIENDS emits the real observation event");
    assert.ok(emitted.some(x => x.type === EVENT_TYPES.VERIFY_BARRIER_COMPLETED
        && x.payload.paymentStatus === "ALL_THREE_SETTLED"),
        "verified 3/3 gate can authorize game start");
});

test("an uncompleted Page4 barrier cannot start on-chain observation", () => {
    const roomId = "not-yet-verified";
    const observed = [];
    const bridge = Object.create(RoomLobbyBridge.prototype);
    Object.assign(bridge, {
        _getSocketContext: () => ({ playerId: "bob", roomId }),
        _deliverPaymentStatusToSocket() {},
        _roomManager: { getRoom: () => ({ gameMode: "NO_FRIENDS", players: ["bob", "olga", "lena"] }) },
        _continueToVerifyByRoom: new Map(),
        _verifyBarrierCompletedByRoom: new Set(),
        _paymentApplicationBinding: { runtime: {
            sessionAdapter: { async observeRoomPayments(request) { observed.push(request); } }
        } }
    });
    bridge._handlePaymentStatusRequest("socket-bob", { observationRequested: true });
    assert.equal(bridge._roomPaymentChecks?.has(roomId) ?? false, false);
    assert.deepEqual(observed, [], "no blockchain poll before the authoritative barrier");
});
