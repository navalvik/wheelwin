import assert from "node:assert/strict";
import test from "node:test";
import { LOBBY_SERVER_EVENTS } from "../../socket/lobbyProtocol.js";

// Capture the existing Testnet default for the comparison case. Mainnet cases
// vary only the server-owned payment runtime flag below.
process.env.TON_NETWORK = "testnet";
process.env.ROOM_WALLET_PAYMENTS_ENABLED = "true";
const { RoomLobbyBridge } = await import("../../socket/RoomLobbyBridge.js");

function reconnectWithPaymentFlag({ network, liveOperationsEnabled }) {
    const roomId = `room-${network}-${liveOperationsEnabled}`;
    const playerId = "player-one";
    const socketId = "reconnected-socket";
    const room = { roomId, players: [playerId, "player-two", "player-three"],
        gameMode: "NO_FRIENDS" };
    const deliveries = [];
    const bridge = Object.create(RoomLobbyBridge.prototype);
    Object.assign(bridge, {
        _socketToPlayer: new Map(),
        _playerToSocket: new Map([[playerId, "old-socket"]]),
        _recoveryOwnershipBySocket: new Map([[socketId, { playerId, roomId }]]),
        _recoveryOwnershipByPlayer: new Map(),
        _obsoleteSockets: new Map(),
        _roomManager: { getRoom: id => id === roomId ? room : null },
        _playerManager: {
            hasPlayer: id => id === playerId,
            getIdentity: id => id === playerId ? { playerId, nickname: "Player" } : null,
            getRuntime: () => ({ roomId }),
            setConnectionState() {}
        },
        _logger: { info() {}, warn() {}, error() {} },
        _setupSessionLifecycle: {
            isRecoverable: () => true,
            isGameplayOwnershipReleased: () => false,
            buildSyncPayload: () => null
        },
        _resultSessionLifecycle: { isActive: () => false },
        _gameStartAuthorization: { getReconnectSnapshot: () => null },
        _paymentApplicationBinding: { runtime: { network, liveOperationsEnabled } },
        _verifyBarrierCompletedByRoom: new Set([roomId]),
        _roomNetworkByRoom: new Map([[roomId, network]]),
        _noFriendsOptionsReadyByRoom: new Map(),
        _profilesRevealedByRoom: new Set(),
        _startedRooms: new Set(),
        _findRecoverableTelegramSeat: () => null,
        _markPendingSocket() {},
        _commitSocketAuthority: () => ({ ok: true, oldSocketId: null }),
        _attachSocketToRoom() {},
        _deliverSecretMatrixStatus() {},
        _buildPlayerList: activeRoom => activeRoom.players.map(id => ({ playerId: id })),
        _deliverPaymentStatusToSocket() {},
        _clearRecoveryOwnershipForPlayer() {},
        _isActiveGameplayProtected: () => false,
        _buildRoomRecoverySync: () => ({ stage: "PAYMENT" }),
        _deliverToSocket(targetSocket, event, payload) {
            deliveries.push({ socketId: targetSocket, event, payload });
        }
    });

    const result = bridge.reconnectSession(socketId, { roomId });
    const readyEvents = deliveries.filter(delivery =>
        delivery.event === LOBBY_SERVER_EVENTS.PAYMENT_STAGE_READY);
    return { result, readyEvents, deliveries };
}

test("NO_FRIENDS Mainnet reconnect sends matching Page4 availability in both delivery paths", () => {
    for (const liveOperationsEnabled of [true, false]) {
        const { result, readyEvents, deliveries } = reconnectWithPaymentFlag({
            network: "mainnet", liveOperationsEnabled
        });
        assert.equal(result.ok, true);
        assert.equal(readyEvents.length, 2,
            "the general Page4 restoration and NO_FRIENDS restoration both send PAYMENT_STAGE_READY");
        assert.deepEqual(readyEvents.map(event => event.payload.paymentAcceptanceEnabled),
            [liveOperationsEnabled, liveOperationsEnabled]);
        assert.equal(deliveries.some(event => event.event === LOBBY_SERVER_EVENTS.PAYMENT_REQUEST), false,
            "reconnect only restores Page4 state and does not create or send payment intents");
    }
});

test("NO_FRIENDS Testnet reconnect retains the existing Testnet acceptance setting", () => {
    const { result, readyEvents } = reconnectWithPaymentFlag({
        network: "testnet", liveOperationsEnabled: false
    });
    assert.equal(result.ok, true);
    assert.equal(readyEvents.length, 2);
    assert.deepEqual(readyEvents.map(event => event.payload.paymentAcceptanceEnabled), [true, true]);
});
