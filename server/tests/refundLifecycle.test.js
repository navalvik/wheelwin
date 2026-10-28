import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { RoomManager } from "../managers/RoomManager.js";
import { LedgerStore } from "../payment/ledger/LedgerStore.js";
import { LEDGER_ENTRY_KIND } from "../payment/ledger/LedgerConstants.js";
import { PaymentIntent } from "../payment/PaymentIntent.js";
import { PAYMENT_INTENT_STATE } from "../payment/PaymentIntentStatus.js";
import { PaymentIntentStore } from "../payment/PaymentIntentStore.js";
import { RefundLifecycleCoordinator, RefundLifecycleError, TestnetRefundProvider } from "../payment/refund/RefundLifecycleCoordinator.js";
import { RefundObligation, REFUND_STATE } from "../payment/refund/RefundObligation.js";
import { RefundObligationStore } from "../payment/refund/RefundObligationStore.js";

const NOW = 1_800_000_000_000;
const TESTNET_PAYER = `0:${"a".repeat(64)}`;

function harness(confirmedCount) {
    const root = mkdtempSync(join(tmpdir(), "wheelwin-refunds-"));
    const intentStore = new PaymentIntentStore({ dataDir: join(root, "payments"), nowProvider: () => NOW });
    const ledgerStore = new LedgerStore({ dataDir: join(root, "ledger"), nowProvider: () => NOW });
    const store = new RefundObligationStore({ dataDir: join(root, "refunds") });
    intentStore.initialize(); ledgerStore.initialize(); store.initialize();
    for (let index = 0; index < 3; index += 1) {
        const paymentReference = `payment_${index}`;
        const transactionId = `incoming_${index}`;
        const intent = new PaymentIntent({
            paymentReference, roomId: "room-x", playerId: `player-${index}`,
            network: "testnet", destinationWalletId: "wallet-testnet",
            destinationWalletAddress: `0:${"b".repeat(64)}`, expectedSender: TESTNET_PAYER,
            amountAtomic: 1_000_000_000, asset: "TON", createdAt: NOW - 1000,
            expiresAt: NOW + 1000, roomDeadlineMs: NOW + 2000
        });
        intentStore.save(intent);
        if (index < confirmedCount) {
            const matched = intent.transition(PAYMENT_INTENT_STATE.MATCHED, { transactionId, now: NOW });
            intentStore.update(matched);
            intentStore.update(matched.transition(PAYMENT_INTENT_STATE.SETTLED, { now: NOW }));
            ledgerStore.append({
                idempotencyKey: `principal:${paymentReference}`, roomId: "room-x",
                kind: LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL, amountAtomic: intent.amountAtomic,
                playerId: intent.playerId, asset: intent.asset, network: intent.network,
                metadata: { paymentReference, transactionId, intentState: "SETTLED", source: "SETTLED_PAYMENT_INTENT" }
            });
        }
    }
    const coordinator = new RefundLifecycleCoordinator({ store, intentStore, ledgerStore, nowProvider: () => NOW });
    return { root, store, intentStore, ledgerStore, coordinator };
}

function prepare(h, count) {
    const result = h.coordinator.prepareClosedRoom({ roomId: "room-x", roomNumber: 37, closureReason: "setup_expired", status: "DESTROYED" });
    const expectedObligations = count;
    assert.equal(result.length, expectedObligations);
    assert.equal(h.store.size, expectedObligations);
    for (const record of h.store.list()) {
        assert.equal(record.networkName, "TESTNET");
        assert.equal(record.globalId, -3);
        assert.equal(record.roomNumber, 37);
        assert.equal(record.refundDestination, TESTNET_PAYER);
    }
}

for (const confirmedCount of [1, 2, 0, 3]) {
    const h = harness(confirmedCount);
    try { prepare(h, confirmedCount); }
    finally { rmSync(h.root, { recursive: true, force: true }); }
}

{
    // A third payment may be finalized only after setup expiry. The durable
    // two-payer obligations must replay, and the late payer must be added
    // exactly once without opening gameplay.
    const h = harness(2);
    try {
        assert.equal(h.coordinator.prepareClosedRoom({
            roomId: "room-x", roomNumber: 37,
            closureReason: "setup_expired", status: "DESTROYED"
        }).length, 2);
        const intent = h.intentStore.require("payment_2");
        const matched = intent.transition(PAYMENT_INTENT_STATE.MATCHED, {
            transactionId: "incoming_2", now: NOW
        });
        h.intentStore.update(matched);
        h.intentStore.update(matched.transition(PAYMENT_INTENT_STATE.SETTLED, { now: NOW }));
        h.ledgerStore.append({
            idempotencyKey: "principal:payment_2", roomId: "room-x",
            kind: LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL,
            amountAtomic: intent.amountAtomic, playerId: intent.playerId,
            asset: intent.asset, network: intent.network,
            metadata: {
                paymentReference: "payment_2", transactionId: "incoming_2",
                intentState: "SETTLED", source: "SETTLED_PAYMENT_INTENT"
            }
        });
        const replay = h.coordinator.prepareLateConfirmedPayments("room-x");
        assert.equal(replay.length, 3);
        assert.equal(replay.filter((entry) => entry.replay).length, 2);
        assert.equal(h.store.size, 3);
        assert.equal(h.coordinator.prepareLateConfirmedPayments("room-x").length, 3);
        assert.equal(h.store.size, 3);
    } finally { rmSync(h.root, { recursive: true, force: true }); }
}

{
    // Room destruction after a game (or without an authoritative pre-game
    // expiry reason) must never accidentally refund all three paid players.
    const h = harness(3);
    try {
        const obligations = h.coordinator.prepareClosedRoom({
            roomId: "room-x", roomNumber: 37,
            closureReason: "game_completed", status: "DESTROYED"
        });
        assert.equal(obligations.length, 0);
        assert.equal(h.store.size, 0);
    } finally { rmSync(h.root, { recursive: true, force: true }); }
}

{
    const h = harness(1);
    try {
        prepare(h, 1);
        let record = h.store.list()[0];
        const attempt = {
            networkName: "TESTNET", globalId: -3, idempotencyKey: record.idempotencyKey,
            attemptId: "attempt-1", state: "SUBMISSION_UNKNOWN", startedAtMs: NOW
        };
        record = h.store.update({ ...record.toRecord(), state: REFUND_STATE.SUBMISSION_UNKNOWN, attempts: [attempt] });
        assert.throws(() => h.store.update({ ...record.toRecord(), state: REFUND_STATE.COMPLETE }), /cannot be complete/);
        const completeRecord = {
            ...record.toRecord(), state: REFUND_STATE.COMPLETE,
            outgoingTransactionId: "outgoing-1",
            finalizedEvidence: {
                networkName: "TESTNET", globalId: -3, transactionId: "outgoing-1",
                amountAtomic: record.amountAtomic, destination: record.refundDestination,
                finalized: true, observedAtMs: NOW, blockId: "masterchain:123"
            }
        };
        const structurallyVerified = RefundObligation.fromRecord(completeRecord);
        assert.equal(structurallyVerified.state, REFUND_STATE.COMPLETE);
        assert.throws(() => h.store.update(completeRecord), /submission and completion are disabled/);
        assert.equal(h.store.listPending()[0].state, REFUND_STATE.SUBMISSION_UNKNOWN);
    } finally { rmSync(h.root, { recursive: true, force: true }); }
}

{
    const h = harness(1);
    try {
        let eventPayload;
        const logger = { info() {}, warn() {}, error() {}, decisionTrace() {} };
        const eventBus = new EventBus({ logger, eventBusConfig: { logEvents: false, showDebugPanel: false } });
        eventBus.initialize();
        eventBus.subscribe(EVENT_TYPES.ROOM_DESTROYED, (event) => { eventPayload = event.payload; });
        const manager = new RoomManager({ logger, eventBus, roomConfig: { maxPlayers: 3 } });
        manager.initialize();
        manager.attachSetupSessionLifecycle({ createForRoom: () => ({}), abortForRoom() {} });
        manager.attachRefundLifecycle(h.coordinator);
        const room = manager.createRoom();
        const order = [];
        let failOnce = true;
        h.coordinator.prepareClosedRoom = (args) => {
            assert.equal(args.status, "DESTROYED");
            assert.equal(manager.getRoom(args.roomId)?.status, "DESTROYED");
            if (failOnce) {
                failOnce = false;
                throw new Error("simulated durable write failure");
            }
            order.push("refund-prepared");
            return h.coordinator.constructor.prototype.prepareClosedRoom.call(h.coordinator, {
                ...args, roomId: "room-x"
            });
        };
        eventBus.subscribe(EVENT_TYPES.ROOM_DESTROYED, () => order.push("event"));
        assert.equal(manager.destroyRoom(room.roomId), false);
        assert.equal(manager.getRoom(room.roomId)?.status, "DESTROYED");
        assert.deepEqual(order, []);
        assert.equal(manager.destroyRoom(room.roomId), true);
        assert.deepEqual(order, ["refund-prepared", "event"]);
        assert.equal(eventPayload.roomNumber, room.roomNumber);
        assert.equal(eventPayload.closureReason, "unspecified");
        assert.equal(manager.getRoom(room.roomId), null);
        assert.equal(h.store.size, 1);
        manager.shutdown(); eventBus.shutdown();
    } finally { rmSync(h.root, { recursive: true, force: true }); }
}

{
    const h = harness(0);
    try {
        assert.deepEqual(h.coordinator.prepareClosedRoom({
            roomId: "room-x", roomNumber: 37, closureReason: "setup_expired", status: "DESTROYED"
        }), []);
        const intent = h.intentStore.require("payment_0");
        const transactionId = "arrived_after_close";
        const matched = intent.transition(PAYMENT_INTENT_STATE.MATCHED, { transactionId, now: NOW });
        h.intentStore.update(matched);
        h.intentStore.update(matched.transition(PAYMENT_INTENT_STATE.SETTLED, { now: NOW }));
        h.ledgerStore.append({
            idempotencyKey: "late-principal", roomId: "room-x",
            kind: LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL, amountAtomic: intent.amountAtomic,
            playerId: intent.playerId, asset: intent.asset, network: intent.network,
            metadata: { paymentReference: intent.paymentReference, transactionId, intentState: "SETTLED", source: "SETTLED_PAYMENT_INTENT" }
        });
        assert.equal(h.coordinator.prepareLateConfirmedPayments("room-x").length, 1);
        assert.equal(h.store.list()[0].roomNumber, 37);
    } finally { rmSync(h.root, { recursive: true, force: true }); }
}

{
    const h = harness(1);
    try {
        prepare(h, 1);
        const original = h.store.list()[0];
        const restart = new RefundObligationStore({ dataDir: join(h.root, "refunds") });
        const restartedCoordinator = new RefundLifecycleCoordinator({ store: restart, intentStore: h.intentStore, ledgerStore: h.ledgerStore });
        const report = restartedCoordinator.initialize();
        assert.equal(report.length, 1);
        assert.equal(report[0].outcome, "PENDING_PROVIDER_UNAVAILABLE");
        assert.equal(restart.list()[0].roomNumber, original.roomNumber);
        assert.equal(restart.list()[0].globalId, -3);
        assert.equal(restart.list()[0].state, REFUND_STATE.PENDING);
        const provider = new TestnetRefundProvider({ globalId: -3 });
        assert.equal(restartedCoordinator.recover({ providers: new Map([["TESTNET", provider]]) })[0].outcome, "PENDING_EXECUTION_DISABLED");
        assert.equal(restartedCoordinator.recover({ providers: new Map([["TESTNET", { networkName: "MAINNET", globalId: -239 }]]) })[0].outcome, "BLOCKED_NETWORK_MISMATCH");
        await assert.rejects(provider.submitRefund(), /execution is disabled/);
        assert.throws(() => new TestnetRefundProvider({ globalId: -239 }), /global ID -3/);
        const missingIdentity = { ...original.toRecord(), globalId: undefined };
        assert.throws(() => RefundObligation.fromRecord(missingIdentity), /globalId/);
        assert.throws(() => RefundObligation.fromRecord({ ...original.toRecord(), state: REFUND_STATE.COMPLETE, finalizedEvidence: null }), /cannot be complete/);
    } finally { rmSync(h.root, { recursive: true, force: true }); }
}

{
    const h = harness(1);
    try {
        prepare(h, 1);
        const replay = h.coordinator.prepareClosedRoom({ roomId: "room-x", roomNumber: 37, closureReason: "setup_expired", status: "DESTROYED" });
        assert.equal(replay.length, 1);
        assert.equal(replay[0].replay, true);
        assert.equal(h.store.size, 1);
        const badLedger = h.ledgerStore.listForRoom("room-x")[0];
        h.ledgerStore.append({
            idempotencyKey: "conflicting-principal", roomId: "room-x",
            kind: LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL, amountAtomic: badLedger.amountAtomic,
            playerId: badLedger.playerId, asset: badLedger.asset, network: "mainnet",
            metadata: badLedger.metadata
        });
        assert.throws(() => h.coordinator.prepareClosedRoom({ roomId: "room-x", roomNumber: 37, closureReason: "setup_expired", status: "DESTROYED" }), RefundLifecycleError);
    } finally { rmSync(h.root, { recursive: true, force: true }); }
}

console.log("Refund lifecycle tests passed");


{
    // RoomManager's numeric room slot can differ from the actual reserved
    // wallet number when an earlier room still holds a pending refund.
    // Refunds must always target the wallet that received the deposits.
    const h = harness(1);
    try {
        h.coordinator._walletPool = {
            getWallet(id) {
                return id === "wallet-testnet" ? {
                    walletId: id, roomNumber: 12, network: "testnet",
                    workchain: 0, address: `0:${"b".repeat(64)}`
                } : null;
            }
        };
        const obligations = h.coordinator.prepareClosedRoom({
            roomId: "room-x", roomNumber: 37,
            closureReason: "setup_expired", status: "DESTROYED"
        });
        assert.equal(obligations.length, 1);
        assert.equal(obligations[0].obligation.roomNumber, 12);
        assert.equal(h.store.getClosedRoom("room-x").roomNumber, 12);
        assert.equal(h.coordinator.prepareLateConfirmedPayments("room-x")[0].obligation.roomNumber, 12);
    } finally {
        rmSync(h.root, { recursive: true, force: true });
    }
}

{
    // Invalid pool identity must fail before recording closure or any refund.
    const h = harness(1);
    try {
        h.coordinator._walletPool = {
            getWallet() {
                return {
                    walletId: "wallet-testnet", roomNumber: 12,
                    network: "testnet", workchain: 0,
                    address: `0:${"c".repeat(64)}`
                };
            }
        };
        assert.throws(() => h.coordinator.prepareClosedRoom({
            roomId: "room-x", roomNumber: 37,
            closureReason: "setup_expired", status: "DESTROYED"
        }), /does not match authoritative Testnet pool/);
        assert.equal(h.store.getClosedRoom("room-x"), null);
        assert.equal(h.store.size, 0);
    } finally {
        rmSync(h.root, { recursive: true, force: true });
    }
}
