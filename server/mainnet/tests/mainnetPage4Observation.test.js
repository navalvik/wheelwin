import assert from "node:assert/strict";
import test from "node:test";
import { ActiveRoomObservationBudget } from "../../payment/runtime/ActiveRoomObservationBudget.js";

process.env.ROOM_WALLET_PAYMENTS_ENABLED = "true";
process.env.TON_NETWORK = "testnet";

const [{ RoomLobbyBridge }, { EVENT_TYPES }] = await Promise.all([
    import("../../socket/RoomLobbyBridge.js"),
    import("../../events/EventTypes.js")
]);

test("authenticated Mainnet Page4 request observes its room once and never opens gameplay", async () => {
    const roomId = "mainnet-page4-observation";
    const players = ["player-a", "player-b", "player-c"];
    const events = [];
    const deliveries = [];
    const observations = [];
    const runtime = {
        network: "mainnet",
        getCapabilities: () => ({ livePaymentAcceptanceEnabled: false }),
        sessionAdapter: {
            async observeRoomPayments(id) {
                observations.push(id);
                return { status: "OBSERVED", paymentStatus: { status: "3/3" } };
            }
        },
        paymentService: { getWalletForRoom: id => ({ roomId: id,
            walletId: "mn-wallet-7", address: "mainnet-wallet" }) },
        paymentGate: { getGameStartGateStatus: () => ({ eligible: true }) }
    };
    const bridge = Object.create(RoomLobbyBridge.prototype);
    Object.assign(bridge, {
        _getSocketContext: socketId => ({ socketId, playerId: "player-a", roomId }),
        _deliverPaymentStatusToSocket: (...args) => deliveries.push(args),
        _roomManager: { getRoom: id => id === roomId ? { players } : null },
        _verifyBarrierCompletedByRoom: new Set([roomId]),
        _paymentApplicationBinding: {
            runtime,
            walletPool: { getReservationForRoom: id => id === roomId
                ? { walletId: "mn-wallet-7", address: "mainnet-wallet" } : null }
        },
        _playerToSocket: new Map(players.map(id => [id, `socket-${id}`])),
        _eventBus: { emit: event => events.push(event) },
        _logger: { info() {}, warn() {}, error() {} },
        _roomPaymentObservationRequestedPlayers: new Map(),
        _roomPaymentObservationRequestedAt: new Map([[roomId, Date.now() - 4_000]]),
        _roomPaymentSubmissionAcknowledgedPlayers: new Map(),
        _paymentNoSignalLogged: new Set(),
        _roomObservationBudget: new ActiveRoomObservationBudget(),
        _roomPaymentChecks: new Map()
    });

    bridge._handlePaymentStatusRequest("socket-player-a", {
        observationRequested: true,
        paymentSubmissionAcknowledged: false,
        observationTrigger: "PAGE4_ACTIVE"
    });
    const pending = bridge._roomPaymentChecks.get(roomId);
    assert.ok(pending, "authorized Page4 request schedules the active room observer");
    bridge._handlePaymentStatusRequest("socket-player-a", { observationRequested: true });
    await pending;

    assert.deepEqual(observations, [roomId], "repeat request is coalesced into one Toncenter observation");
    assert.equal(deliveries.length, 5,
        "each request gets immediate status and all three seated players get refreshed status");
    assert.ok(events.some(event => event.type === EVENT_TYPES.PAYMENT_OBSERVATION_STARTED));
    assert.ok(events.some(event => event.type === EVENT_TYPES.PAYMENT_OBSERVATION_REQUESTED
        && event.payload.playerId === "player-a"));
    assert.equal(events.some(event => event.type === EVENT_TYPES.VERIFY_BARRIER_COMPLETED), false,
        "even eligible 3/3 Mainnet ledger state cannot trigger gameplay while live operations are disabled");

    bridge._handlePaymentStatusRequest("socket-player-a", { observationRequested: true });
    const rateLimited = bridge._roomPaymentChecks.get(roomId);
    assert.ok(rateLimited, "subsequent requests still use the shared room cadence budget");
    await rateLimited;
    assert.deepEqual(observations, [roomId],
        "the active-room frequency limit prevents a second Toncenter observation");
});

test("live Testnet 3/3 uses the same VERIFY_BARRIER_COMPLETED path", async () => {
    const roomId = "testnet-page4-observation";
    const players = ["player-a", "player-b", "player-c"];
    const events = [];
    const runtime = {
        network: "testnet",
        sessionAdapter: { async observeRoomPayments() {} },
        paymentService: { getWalletForRoom: () => ({ walletId: 7, address: "testnet-wallet" }) },
        paymentGate: { getGameStartGateStatus: () => ({ eligible: true }) }
    };
    const bridge = Object.create(RoomLobbyBridge.prototype);
    Object.assign(bridge, {
        _getSocketContext: socketId => ({ socketId, playerId: "player-a", roomId }),
        _deliverPaymentStatusToSocket() {},
        _roomManager: { getRoom: id => id === roomId ? { players } : null },
        _verifyBarrierCompletedByRoom: new Set([roomId]),
        _paymentApplicationBinding: { runtime },
        _playerToSocket: new Map(players.map(id => [id, `socket-${id}`])),
        _eventBus: { emit: event => events.push(event) },
        _logger: { info() {}, warn() {}, error() {} },
        _roomPaymentObservationRequestedPlayers: new Map(),
        _roomPaymentObservationRequestedAt: new Map([[roomId, Date.now() - 4_000]]),
        _roomPaymentSubmissionAcknowledgedPlayers: new Map(),
        _paymentNoSignalLogged: new Set(),
        _roomObservationBudget: new ActiveRoomObservationBudget(),
        _roomPaymentChecks: new Map()
    });

    bridge._handlePaymentStatusRequest("socket-player-a", { observationRequested: true });
    await bridge._roomPaymentChecks.get(roomId);

    const ready = events.find(event => event.type === EVENT_TYPES.VERIFY_BARRIER_COMPLETED);
    assert.ok(ready, "live Testnet's eligible ledger gate emits the shared start authorization event");
    assert.deepEqual(ready.payload, { roomId, paymentAcceptanceEnabled: true,
        paymentSessionPrepared: true, paymentStatus: "ALL_THREE_SETTLED" });
});

test("Mainnet Page4 observer rejects a socket that does not own a room seat", () => {
    const observed = [];
    const bridge = Object.create(RoomLobbyBridge.prototype);
    Object.assign(bridge, {
        _getSocketContext: () => ({ playerId: "outsider", roomId: "room" }),
        _deliverPaymentStatusToSocket() {},
        _roomManager: { getRoom: () => ({ players: ["a", "b", "c"] }) },
        _verifyBarrierCompletedByRoom: new Set(["room"]),
        _paymentApplicationBinding: { runtime: { network: "mainnet",
            sessionAdapter: { async observeRoomPayments(roomId) { observed.push(roomId); } } } }
    });
    bridge._handlePaymentStatusRequest("socket-outsider", { observationRequested: true });
    assert.deepEqual(observed, []);
});
