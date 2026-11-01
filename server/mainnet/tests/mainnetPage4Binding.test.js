import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMainnetBootstrap } from "../MainnetBootstrap.js";
import { MainnetPage4PaymentApplicationBinding } from "../payment/MainnetPage4PaymentApplicationBinding.js";
import { RoomLobbyBridge } from "../../socket/RoomLobbyBridge.js";
import { LOBBY_SERVER_EVENTS } from "../../socket/lobbyProtocol.js";

const PLAYER_IDS = ["seat-a", "seat-b", "seat-c"];

function catalog() {
    return JSON.stringify(Array.from({ length: 64 }, (_, index) => ({
        walletId: `mainnet-room-${index + 1}`,
        roomNumber: index + 1,
        address: `0:${String(index + 100).padStart(64, "0")}`,
        network: "mainnet"
    })));
}

function setup(t) {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-page4-mainnet-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    let rpcCalls = 0;
    const env = {
        TON_NETWORK: "mainnet",
        MAINNET_TONCENTER_API_KEY: "offline-only-key",
        MAINNET_ROOM_WALLETS_JSON: catalog(),
        MAINNET_ROOM_WALLET_DATA_DIR: dataDir
    };
    const bootstrap = createMainnetBootstrap({
        env,
        nowProvider: () => 1_700_000_100_000,
        fetchImpl: async () => { rpcCalls += 1; throw new Error("unexpected RPC"); }
    });
    bootstrap.initialize();
    const room = { roomId: "mainnet-page4-room", createdAt: 1_700_000_000_000,
        maxPlayers: 3, players: [...PLAYER_IDS] };
    const roomManager = { getRoom: id => id === room.roomId ? room : null };
    const binding = new MainnetPage4PaymentApplicationBinding({
        runtime: bootstrap.paymentRuntime,
        walletPool: bootstrap.walletPool,
        dataDir,
        roomManager,
        nowProvider: () => 1_700_000_100_000
    });
    const identities = new Map(PLAYER_IDS.map((playerId, index) => [playerId, {
        playerId, wallet: `0:${String(index + 1).padStart(64, "0")}`,
        baseStake: 1, sectorCount: 1
    }]));
    return { dataDir, bootstrap, binding, room, roomManager, identities,
        getRpcCalls: () => rpcCalls };
}

function makeBridge(h) {
    const delivered = [];
    const bridge = Object.create(RoomLobbyBridge.prototype);
    bridge._roomManager = h.roomManager;
    bridge._playerManager = { getIdentity: playerId => h.identities.get(playerId) };
    bridge._paymentApplicationBinding = h.binding;
    bridge._playerToSocket = new Map(PLAYER_IDS.map((id, index) => [id, `socket-${index}`]));
    bridge._logger = { info() {}, warn() {} };
    bridge._deliverToSocket = (...args) => delivered.push(args);
    return { bridge, delivered };
}

test("Page4 bridge prepares exactly three private Mainnet ledger intents once", (t) => {
    const h = setup(t);
    const { bridge, delivered } = makeBridge(h);

    // The Mainnet path runs preparation although live acceptance is false.
    bridge._preparePaymentSessionIfEnabled(h.room.roomId, h.room);
    bridge._preparePaymentSessionIfEnabled(h.room.roomId, h.room);

    const intents = h.bootstrap.paymentRuntime.incomingLedger.listRoomIntents(h.room.roomId);
    assert.equal(intents.length, 3);
    assert.equal(new Set(intents.map(item => item.playerId)).size, 3);
    assert.equal(new Set(intents.map(item => item.destinationWalletId)).size, 1);
    assert.equal(new Set(intents.map(item => item.destinationWalletAddress)).size, 1);
    assert.ok(intents.every(item => item.network === "mainnet" && item.globalId === -239));
    assert.ok(intents.every(item => item.amountAtomic === "1000000000"));
    assert.deepEqual(intents.map(item => item.expectedSender), PLAYER_IDS.map((_, index) =>
        `0:${String(index + 1).padStart(64, "0")}`));
    assert.deepEqual(delivered, [], "Mainnet preparation must not emit payment instructions");
    assert.equal(h.bootstrap.walletPool.getReservedCount(), 1);
    assert.equal(h.bootstrap.paymentRuntime.liveOperationsEnabled, false);
    assert.equal(h.getRpcCalls(), 0);
});

test("Page4 status is ledger-derived, reconnect-idempotent, and bound to the authenticated socket", (t) => {
    const h = setup(t);
    const { bridge, delivered } = makeBridge(h);
    bridge._preparePaymentSessionIfEnabled(h.room.roomId, h.room);

    const settledIntent = h.bootstrap.paymentRuntime.incomingLedger.listRoomIntents(h.room.roomId)[0];
    const observation = { network: "mainnet", globalId: -239, roomId: h.room.roomId,
        transactionId: "synthetic-page4-confirmed-transfer",
        payloadFingerprint: "a".repeat(64),
        sourceAddress: settledIntent.expectedSender,
        destinationAddress: settledIntent.destinationWalletAddress,
        amountAtomic: settledIntent.amountAtomic, asset: "TON",
        transactionTime: settledIntent.createdAt + 1, observedAt: settledIntent.createdAt + 2 };
    h.bootstrap.paymentRuntime.incomingLedger.recordTransfer({ observation,
        receipt: { network: "mainnet", globalId: -239, roomId: h.room.roomId,
            transactionId: observation.transactionId, status: "CONFIRMED", reason: null,
            paymentReference: settledIntent.paymentReference,
            amountAtomic: settledIntent.amountAtomic,
            sourceAddress: settledIntent.expectedSender,
            destinationAddress: settledIntent.destinationWalletAddress,
            transactionTime: observation.transactionTime, updatedAt: observation.observedAt, asset: "TON" },
        settleReference: settledIntent.paymentReference });

    bridge._deliverPaymentStatusToSocket(h.room.roomId, "seat-a", "socket-0");
    bridge._deliverPaymentStatusToSocket(h.room.roomId, "seat-a", "socket-0");
    bridge._deliverPaymentStatusToSocket(h.room.roomId, "seat-a", "attacker-socket");

    const updates = delivered.filter(([, event]) =>
        event === LOBBY_SERVER_EVENTS.ENTRY_PAYMENT_SESSION_UPDATED);
    assert.equal(updates.length, 2);
    const payload = updates[0][2];
    assert.equal(payload.status, "PAYMENT_UNAVAILABLE");
    assert.equal(payload.paymentAcceptanceEnabled, false);
    assert.equal(payload.network, "mainnet");
    assert.equal(payload.globalId, -239);
    assert.equal(payload.confirmedCount, 1);
    assert.equal(payload.requiredCount, 3);
    assert.equal(payload.playerPaymentStatus, "SETTLED");
    assert.deepEqual(payload.playerPaymentStatuses.map(row => row.playerId), PLAYER_IDS);
    assert.deepEqual(payload.playerPaymentStatuses.map(row => row.status), ["SETTLED", "PENDING", "PENDING"]);
    for (const field of ["destinationWalletAddress", "paymentReference", "amountAtomic", "payerAddress"]) {
        assert.equal(Object.hasOwn(payload, field), false, `${field} must not be disclosed as payment instructions`);
    }
    assert.equal(h.bootstrap.paymentRuntime.incomingLedger.listRoomIntents(h.room.roomId).length, 3);
});

test("Page4 preparation rejects client roster mismatch and reuses persisted reservation after restart", (t) => {
    const h = setup(t);
    const requests = PLAYER_IDS.map((playerId, index) => ({
        playerId, paymentReference: `WW_${playerId}_offline`,
        expectedSender: `0:${String(index + 1).padStart(64, "0")}`,
        amountAtomic: 1_000_000_000
    }));
    const prepared = h.binding.prepareRoomPaymentSession(h.room.roomId, requests);
    assert.equal(prepared.intentCount, 3);
    assert.equal(prepared.payments.length, 0);
    assert.equal(prepared.idempotent, false);
    assert.equal(h.binding.prepareRoomPaymentSession(h.room.roomId, requests).idempotent, true);
    assert.throws(() => h.binding.prepareRoomPaymentSession(h.room.roomId,
        requests.map((row, index) => index === 1 ? { ...row, amountAtomic: row.amountAtomic + 1 } : row)),
    /MAINNET_PAGE4_EXISTING_INTENTS_CONFLICT/);
    assert.equal(h.bootstrap.paymentRuntime.incomingLedger.listRoomIntents(h.room.roomId).length, 3,
        "conflicting retry does not append any payment intents");
    assert.throws(() => h.binding.prepareRoomPaymentSession(h.room.roomId,
        requests.map((row, index) => index === 2 ? { ...row, playerId: "unseated" } : row)),
    /MAINNET_PAGE4_PAYMENT_ROSTER_INVALID|MAINNET_PAGE4_PAYMENT_ROSTER_MISMATCH|MAINNET_PAGE4_PAYMENT_REQUIREMENTS_INVALID/);

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
    const recoveredBinding = new MainnetPage4PaymentApplicationBinding({
        runtime: restarted.paymentRuntime, walletPool: restarted.walletPool,
        dataDir: h.dataDir, roomManager: h.roomManager,
        nowProvider: () => 1_700_000_100_000
    });
    assert.equal(recoveredBinding.prepareRoomPaymentSession(h.room.roomId, requests).idempotent, true);
    assert.equal(restarted.walletPool.getReservedCount(), 1);
    assert.equal(restarted.paymentRuntime.incomingLedger.listRoomIntents(h.room.roomId).length, 3);
});
