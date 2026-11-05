import assert from "node:assert/strict";
import { Address } from "@ton/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildRoomWalletTonConnectRequest } from "../../../client/src/payment/buildRoomWalletTonConnectRequest.js";
import { normalizeMainnetPaymentRequest } from "../../../client/src/payment/mainnetPaymentRequest.js";
import { createMainnetBootstrap } from "../MainnetBootstrap.js";
import { MainnetPage4PaymentApplicationBinding } from "../payment/MainnetPage4PaymentApplicationBinding.js";
import { deriveMainnetRoomPaymentRequirements } from "../testnet_source/payment/runtime/deriveTestnetRoomPaymentRequirements.js";

process.env.ROOM_WALLET_PAYMENTS_ENABLED = "true";
const { RoomLobbyBridge } = await import("../../socket/RoomLobbyBridge.js");

const PLAYERS = ["seat-a", "seat-b", "seat-c"];

function catalog() {
    return JSON.stringify(Array.from({ length: 64 }, (_, index) => ({
        walletId: `mainnet-room-${index + 1}`,
        roomNumber: index + 1,
        address: `0:${String(index + 100).padStart(64, "0")}`,
        network: "mainnet"
    })));
}

function setup(t) {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-page4-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    let rpcCalls = 0;
    const env = {
        TON_NETWORK: "mainnet",
        MAINNET_TONCENTER_API_KEY: "offline-only-key",
        MAINNET_ROOM_WALLETS_JSON: catalog(),
        MAINNET_ROOM_WALLET_DATA_DIR: dataDir
    };
    const now = 1_700_000_100_000;
    const bootstrap = createMainnetBootstrap({
        env,
        nowProvider: () => now,
        fetchImpl: async () => { rpcCalls++; throw new Error("unexpected RPC"); }
    });
    bootstrap.initialize();
    const room = { roomId: "mainnet-page4-room", createdAt: now - 100_000,
        maxPlayers: 3, players: [...PLAYERS] };
    const roomManager = { getRoom: id => id === room.roomId ? room : null };
    const identities = new Map(PLAYERS.map((playerId, index) => [playerId, {
        playerId,
        wallet: `0:${String(index + 1).padStart(64, "0")}`,
        baseStake: 1,
        sectorCount: 1
    }]));
    const binding = new MainnetPage4PaymentApplicationBinding({
        runtime: bootstrap.paymentRuntime,
        walletPool: bootstrap.walletPool,
        dataDir,
        roomManager,
        nowProvider: () => now
    });
    return { dataDir, bootstrap, room, roomManager, identities, binding,
        now, getRpcCalls: () => rpcCalls };
}

function requirements(h) {
    return deriveMainnetRoomPaymentRequirements(h.room.roomId, PLAYERS,
        playerId => h.identities.get(playerId));
}

test("Page4 binding prepares three saved intents against one reserved Mainnet wallet", t => {
    const h = setup(t);
    const prepared = h.binding.prepareRoomPaymentSession(h.room.roomId, requirements(h));
    assert.equal(prepared.prepared, true);
    assert.equal(prepared.intentCount, 3);
    assert.equal(prepared.payments.length, 0, "offline mode does not disclose live instructions");
    assert.equal(prepared.paymentStatus.eligible, false);

    const intents = h.bootstrap.paymentRuntime.paymentService.listPaymentIntentsForRoom(h.room.roomId);
    assert.equal(intents.length, 3);
    assert.ok(intents.every(intent => intent.network === "mainnet"));
    assert.deepEqual(intents.map(intent => intent.playerId), PLAYERS);
    assert.equal(new Set(intents.map(intent => intent.destinationWalletAddress)).size, 1);
    assert.equal(intents[0].destinationWalletAddress,
        h.bootstrap.walletPool.getReservationForRoom(h.room.roomId).address);
    assert.equal(h.bootstrap.paymentRuntime.getCapabilities().globalId, -239);
    assert.equal(h.bootstrap.paymentRuntime.getCapabilities().livePaymentAcceptanceEnabled, false);
    assert.equal(h.getRpcCalls(), 0);
});

test("Page4 retries are idempotent and conflicting requirements fail closed", t => {
    const h = setup(t);
    const playerPayments = requirements(h);
    const first = h.binding.prepareRoomPaymentSession(h.room.roomId, playerPayments);
    const retry = h.binding.prepareRoomPaymentSession(h.room.roomId, playerPayments);
    assert.equal(first.idempotent, false);
    assert.equal(retry.idempotent, true);
    assert.equal(h.bootstrap.paymentRuntime.paymentService
        .listPaymentIntentsForRoom(h.room.roomId).length, 3);

    assert.throws(() => h.binding.prepareRoomPaymentSession(h.room.roomId,
        playerPayments.map((payment, index) => index === 0
            ? { ...payment, amountAtomic: payment.amountAtomic + 1 }
            : payment)));
    assert.equal(h.bootstrap.paymentRuntime.paymentService
        .listPaymentIntentsForRoom(h.room.roomId).length, 3);
});

test("Page4 sends a client-valid Mainnet request from the saved intent on entry and refresh", t => {
    const h = setup(t);
    const runtime = Object.create(h.bootstrap.paymentRuntime);
    Object.defineProperty(runtime, "getCapabilities", {
        value: () => ({
            ...h.bootstrap.paymentRuntime.getCapabilities(),
            livePaymentAcceptanceEnabled: true
        })
    });
    const binding = new MainnetPage4PaymentApplicationBinding({
        runtime,
        walletPool: h.bootstrap.walletPool,
        dataDir: h.dataDir,
        roomManager: h.roomManager,
        nowProvider: () => h.now,
        paymentAcceptanceEnabled: true
    });
    const deliveries = [];
    const bridge = Object.create(RoomLobbyBridge.prototype);
    Object.assign(bridge, {
        _paymentApplicationBinding: binding,
        _roomManager: h.roomManager,
        _playerManager: { getIdentity: playerId => h.identities.get(playerId) },
        _playerToSocket: new Map(PLAYERS.map(playerId => [playerId, `socket-${playerId}`])),
        _deliverToSocket: (socketId, event, payload) => deliveries.push({ socketId, event, payload }),
        _logger: { info() {}, warn() {} }
    });

    bridge._preparePaymentSessionIfEnabled(h.room.roomId, h.room);
    const entryRequests = deliveries.filter(item => item.event === "PAYMENT_REQUEST");
    assert.equal(entryRequests.length, 3, "all seated players receive their own saved payment intent");

    const checkRequest = ({ socketId, payload }) => {
        assert.equal(typeof payload.amountAtomic, "string",
            "the Mainnet socket contract sends atomic units as a decimal string");
        assert.equal(payload.amount, 1_000_000_000);
        assert.equal(payload.asset, "TON");
        assert.equal(payload.network, "mainnet");
        const payment = normalizeMainnetPaymentRequest(payload, {
            roomId: h.room.roomId,
            playerId: payload.playerId,
            paymentAcceptanceEnabled: true,
            now: h.now
        });
        assert.ok(payment, "Page4 accepts the request and can render its payment button");
        assert.equal(payment.payerAddress, h.identities.get(payload.playerId).wallet);
        assert.equal(payment.destinationWalletAddress,
            h.bootstrap.walletPool.getReservationForRoom(h.room.roomId).address);
        assert.equal(payment.amountAtomic, 1_000_000_000);

        const tonConnect = buildRoomWalletTonConnectRequest({
            ...payment,
            status: "AWAITING_PAYMENT"
        }, h.now);
        assert.equal(tonConnect.network, "-239");
        assert.equal(tonConnect.messages.length, 1);
        assert.equal(tonConnect.messages[0].amount, "1000000000");
        assert.equal(Address.parse(tonConnect.messages[0].address).toRawString(),
            Address.parse(payment.destinationWalletAddress).toRawString());
        return socketId;
    };

    for (const item of entryRequests) checkRequest(item);

    const refreshSocketId = `socket-${PLAYERS[0]}`;
    bridge._deliverPaymentStatusToSocket(h.room.roomId, PLAYERS[0], refreshSocketId,
        { includePaymentRequest: true });
    const refreshedRequest = deliveries.filter(item => item.event === "PAYMENT_REQUEST")
        .find(item => item.socketId === refreshSocketId);
    assert.ok(refreshedRequest, "Page4 refresh re-sends the saved request after its status event");
    checkRequest(refreshedRequest);
});

test("Page4 state survives restart without RPC or live transfer capabilities", t => {
    const h = setup(t);
    h.binding.prepareRoomPaymentSession(h.room.roomId, requirements(h));
    const restarted = createMainnetBootstrap({
        env: {
            TON_NETWORK: "mainnet",
            MAINNET_TONCENTER_API_KEY: "offline-only-key",
            MAINNET_ROOM_WALLETS_JSON: catalog(),
            MAINNET_ROOM_WALLET_DATA_DIR: h.dataDir
        },
        nowProvider: () => 1_700_000_100_000,
        fetchImpl: async () => { throw new Error("unexpected RPC"); }
    });
    restarted.initialize();
    const recovered = new MainnetPage4PaymentApplicationBinding({
        runtime: restarted.paymentRuntime,
        walletPool: restarted.walletPool,
        dataDir: h.dataDir,
        roomManager: h.roomManager,
        nowProvider: () => 1_700_000_100_000
    });
    const replay = recovered.prepareRoomPaymentSession(h.room.roomId, requirements(h));
    assert.equal(replay.idempotent, true);
    assert.equal(restarted.paymentRuntime.paymentService
        .listPaymentIntentsForRoom(h.room.roomId).length, 3);
    assert.equal(restarted.walletPool.getReservedCount(), 1);
    assert.equal(restarted.paymentRuntime.getCapabilities().outgoingRefundTransfersEnabled, false);
    assert.equal(restarted.paymentRuntime.getCapabilities().livePaymentAcceptanceEnabled, false);
});
