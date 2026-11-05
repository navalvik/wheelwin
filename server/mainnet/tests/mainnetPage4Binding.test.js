import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMainnetBootstrap } from "../MainnetBootstrap.js";
import { MainnetPage4PaymentApplicationBinding } from "../payment/MainnetPage4PaymentApplicationBinding.js";
import { deriveMainnetRoomPaymentRequirements } from "../testnet_source/payment/runtime/deriveTestnetRoomPaymentRequirements.js";

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
        getRpcCalls: () => rpcCalls };
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
