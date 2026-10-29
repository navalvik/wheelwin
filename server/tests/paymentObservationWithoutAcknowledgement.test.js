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
