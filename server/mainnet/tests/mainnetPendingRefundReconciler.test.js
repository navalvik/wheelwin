import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMainnetRuntimeConfig } from "../config/MainnetRuntimeConfig.js";
import { MainnetPaymentRuntime } from "../payment/MainnetPaymentRuntime.js";
import { MainnetPendingRefundReconciler } from "../payment/MainnetPendingRefundReconciler.js";
import { MainnetPendingRefundExecutor } from "../payment/MainnetPendingRefundExecutor.js";

const NOW = 1_800_000_000_000;
const ROOM = "restart-refund-room";
const ROOM_WALLET = `0:${"1".repeat(64)}`;
const PAYER = `0:${"2".repeat(64)}`;
const OUT_TX = "a".repeat(64);
const RECIPIENT_TX = "b".repeat(64);
const MESSAGE = "c".repeat(64);

function makeLedger(t) {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-refund-worker-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const catalog = JSON.stringify(Array.from({ length: 64 }, (_, index) => ({
        walletId: `wallet-${index + 1}`, roomNumber: index + 1,
        address: `0:${String(index + 10).padStart(64, "0")}`, network: "mainnet"
    })));
    const config = loadMainnetRuntimeConfig({ TON_NETWORK: "mainnet",
        MAINNET_TONCENTER_API_KEY: "offline-mock-key", MAINNET_ROOM_WALLET_DATA_DIR: dataDir,
        MAINNET_ROOM_WALLETS_JSON: catalog });
    return { dataDir, config };
}

function makeExecutorRuntime({ obligations, calls, submit = async obligationId => {
    calls.push(obligationId);
    const item = obligations.find(x => x.obligationId === obligationId);
    item.state = "SUBMISSION_UNKNOWN";
    return { outcome: item.state };
} }) {
    return { network: "mainnet", globalId: -239, liveOperationsEnabled: true,
        financialLedger: { network: "mainnet", globalId: -239,
            listPendingRefunds: () => obligations },
        refundLifecycle: { submitRefund: submit } };
}

function createPendingObligation(runtime, { roomId = ROOM, roomNumber = 4,
    walletAddress = ROOM_WALLET, payerAddress = PAYER } = {}) {
    runtime.refundLifecycle.configurePage5StateResolver(() => false);
    runtime.refundLifecycle.configureReservedWalletRoomNumberResolver(() => roomNumber);
    runtime.refundLifecycle.configureCurrentWalletReservationResolver(number => number === roomNumber ? ({
        walletId: `mainnet-wallet-${number}`, roomNumber, address: walletAddress,
        network: "mainnet", reservedByRoomId: roomId
    }) : null);
    const players = Array.from({ length: 3 }, (_, index) => ({
        playerId: `player-${index + 1}`, paymentReference: `pending-${roomId}-${index + 1}`,
        expectedSender: index === 0 ? payerAddress : `0:${String(index + 20).padStart(64, "0")}`,
        amountAtomic: "1000000000"
    }));
    runtime.incomingLedger.createRoomPaymentIntents({ roomId,
        wallet: { walletId: `mainnet-wallet-${roomNumber}`, address: walletAddress,
            network: "mainnet", globalId: -239 }, players,
        createdAt: NOW - 60_000, expiresAt: NOW + 10_000 });
    const intent = runtime.incomingLedger.listRoomIntents(roomId)[0];
    runtime.incomingLedger.recordTransfer({
        observation: { network: "mainnet", globalId: -239, roomId, transactionId: `incoming-${roomId}`,
            payloadFingerprint: "e".repeat(64), sourceAddress: payerAddress,
            destinationAddress: walletAddress, amountAtomic: "1000000000", asset: "TON",
            transactionTime: NOW - 30_000, observedAt: NOW - 29_000 },
        receipt: { network: "mainnet", globalId: -239, status: "CONFIRMED", reason: null,
            roomId, transactionId: `incoming-${roomId}`, paymentReference: intent.paymentReference,
            playerId: intent.playerId, amountAtomic: "1000000000", sourceAddress: payerAddress,
            destinationAddress: walletAddress, asset: "TON", transactionTime: NOW - 30_000,
            updatedAt: NOW - 29_000 },
        settleReference: intent.paymentReference
    });
    return runtime.refundLifecycle.prepareClosedRoom({ roomId, roomNumber,
        closureReason: "pre_page5_destroyed", status: "DESTROYED" })[0];
}

function makeMockRefundRuntime(config, overrides = {}) {
    const adapter = overrides.adapter ?? {
        async estimateOutboundTransferFee() { return { ok: true, totalNano: 1_000_000n }; },
        async sendTransfer() { return { ok: true, txHash: "mock-refund-transaction" }; }
    };
    return new MainnetPaymentRuntime({ config,
        fetchImpl: async () => { throw new Error("offline test must not call RPC"); },
        adapter,
        independentVerifier: { async verifyTransfer() { throw new Error("not used by submission test"); } },
        nowProvider: () => NOW });
}

test("bounded scheduler rotates over eligible obligations and skips PENDING/COMPLETE", async () => {
    const obligations = ["a", "b", "c", "d"].map((obligationId, index) => ({
        obligationId, state: index === 0 ? "SUBMISSION_UNKNOWN" : "SUBMITTED",
        network: "mainnet", globalId: -239
    })).concat([
        { obligationId: "pending", state: "PENDING", network: "mainnet", globalId: -239 },
        { obligationId: "complete", state: "COMPLETE", network: "mainnet", globalId: -239 },
        { obligationId: "testnet", state: "SUBMITTED", network: "testnet", globalId: -3 }
    ]);
    const calls = [];
    const reconciler = new MainnetPendingRefundReconciler({
        financialLedger: { network: "mainnet", globalId: -239, listPendingRefunds: () => obligations },
        refundLifecycle: { async reconcileRefund(id) { calls.push(id); return { outcome: "FINALITY_PENDING" }; } }
    });
    const first = await reconciler.runPass();
    const second = await reconciler.runPass();
    assert.equal(first.scanned, 2);
    assert.equal(second.scanned, 2);
    assert.deepEqual(calls, ["a", "b", "c", "d"]);
    assert.ok(first.results.every(item => item.outcome === "FINALITY_PENDING"));
});

test("parallel passes are coalesced and stop prevents later checks", async () => {
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    const calls = [];
    const reconciler = new MainnetPendingRefundReconciler({
        financialLedger: { network: "mainnet", globalId: -239, listPendingRefunds: () => [
            { obligationId: "one", state: "SUBMITTED", network: "mainnet", globalId: -239 }
        ] },
        refundLifecycle: { async reconcileRefund(id) { calls.push(id); await hold; return { outcome: "FINALITY_PENDING" }; } }
    });
    const firstPass = reconciler.runPass();
    const overlap = await reconciler.runPass();
    assert.equal(overlap.status, "RECONCILIATION_IN_PROGRESS");
    assert.deepEqual(calls, ["one"]);
    release();
    assert.equal((await firstPass).scanned, 1);
    reconciler.stop();
    assert.equal((await reconciler.runPass()).status, "RECONCILIATION_STOPPED");
    assert.equal(calls.length, 1);
});

test("restart resumes a persisted attempted refund and completes it only from mocked Toncenter + TonAPI", async t => {
    const { config } = makeLedger(t);
    let sends = 0;
    const adapter = {
        async estimateOutboundTransferFee() { throw new Error("reconciliation must not estimate or submit"); },
        async sendTransfer() { sends += 1; throw new Error("reconciliation must not broadcast"); }
    };
    const indexedTx = { hash: OUT_TX, account: ROOM_WALLET,
        now: Math.floor((NOW + 30_000) / 1000),
        description: { aborted: false, action: { success: true } },
        mc_block_seqno: 10, block_ref: { workchain: 0, shard: "8000000000000000", seqno: 10 },
        emulated: false, finality: 2,
        out_msgs: [{ hash: MESSAGE, source: ROOM_WALLET, destination: PAYER,
            value: "998800000", bounced: false }] };
    const recipientTx = { hash: RECIPIENT_TX, account: PAYER,
        now: Math.floor((NOW + 31_000) / 1000),
        description: { aborted: false, action: { success: true } },
        mc_block_seqno: 11, block_ref: { workchain: 0, shard: "8000000000000000", seqno: 11 },
        emulated: false, finality: 2,
        in_msg: { hash: MESSAGE, source: ROOM_WALLET, destination: PAYER,
            value: "998800000", bounced: false } };
    const fetchImpl = async requestUrl => {
        const url = new URL(String(requestUrl));
        if (url.pathname.endsWith("/masterchainInfo")) {
            return { status: 200, json: async () => ({ last: { global_id: -239, seqno: 20 } }) };
        }
        return { status: 200, json: async () => ({ transactions:
            url.searchParams.get("account") === ROOM_WALLET ? [indexedTx] : [recipientTx] }) };
    };
    const tonapiCalls = [];
    const independentVerifier = { async verifyTransfer(input) {
        tonapiCalls.push(input);
        return { status: "INDEPENDENT_INDEXED_CREDIT_OBSERVED", ...input,
            provider: "tonapi-mainnet", network: "mainnet", globalId: -239, actualFeeAtomic: 500 };
    } };

    const firstRuntime = new MainnetPaymentRuntime({ config, fetchImpl, adapter,
        independentVerifier, nowProvider: () => NOW });
    const players = Array.from({ length: 3 }, (_, index) => ({
        playerId: `player-${index + 1}`, paymentReference: `pay-${index + 1}`,
        expectedSender: index === 0 ? PAYER : `0:${String(index + 20).padStart(64, "0")}`,
        amountAtomic: "1000000000"
    }));
    firstRuntime.incomingLedger.createRoomPaymentIntents({ roomId: ROOM,
        wallet: { walletId: "reserved-mainnet-4", address: ROOM_WALLET, network: "mainnet", globalId: -239 },
        players, createdAt: NOW - 60_000, expiresAt: NOW + 10_000 });
    const intent = firstRuntime.incomingLedger.listRoomIntents(ROOM)[0];
    firstRuntime.incomingLedger.recordTransfer({
        observation: { network: "mainnet", globalId: -239, roomId: ROOM, transactionId: "d".repeat(64),
            payloadFingerprint: "e".repeat(64), sourceAddress: PAYER, destinationAddress: ROOM_WALLET,
            amountAtomic: "1000000000", asset: "TON", transactionTime: NOW - 30_000, observedAt: NOW - 29_000 },
        receipt: { network: "mainnet", globalId: -239, status: "CONFIRMED", reason: null,
            roomId: ROOM, transactionId: "d".repeat(64), paymentReference: intent.paymentReference,
            playerId: intent.playerId, amountAtomic: "1000000000", sourceAddress: PAYER,
            destinationAddress: ROOM_WALLET, asset: "TON", transactionTime: NOW - 30_000,
            updatedAt: NOW - 29_000 },
        settleReference: intent.paymentReference
    });
    const obligation = firstRuntime.refundLifecycle.prepareClosedRoom({ roomId: ROOM, roomNumber: 4,
        closureReason: "pre_page5_destroyed", status: "DESTROYED" })[0];
    firstRuntime.financialLedger.updateRefund(obligation.obligationId, { state: "SUBMISSION_UNKNOWN",
        transferAmountAtomic: 998_800_000, gasChargeAtomic: 1_200_000 });

    const restartedRuntime = new MainnetPaymentRuntime({ config, fetchImpl, adapter,
        independentVerifier, nowProvider: () => NOW + 60_000 });
    restartedRuntime.refundLifecycle.configureReservedWalletRoomNumberResolver(() => 4);
    restartedRuntime.refundLifecycle.configurePage5StateResolver(() => false);
    const recovered = restartedRuntime.refundLifecycle.recover();
    assert.equal(recovered.some(item => item.obligationId === obligation.obligationId), true);
    const worker = new MainnetPendingRefundReconciler({ financialLedger: restartedRuntime.financialLedger,
        refundLifecycle: restartedRuntime.refundLifecycle, maxPerPass: 2 });
    const pass = await worker.runPass();
    assert.equal(pass.scanned, 1);
    assert.equal(pass.results[0].outcome, "REFUND_COMPLETE_TWO_SOURCES");
    assert.equal(restartedRuntime.financialLedger.getRefund(obligation.obligationId).state, "COMPLETE");
    assert.equal(tonapiCalls.length, 1);
    assert.equal(sends, 0);
});

test("restart reconciliation accepts an uncredited PENDING-intent receipt and retries evidence without resubmitting", async t => {
    const { config } = makeLedger(t);
    let evidenceStage = 0;
    let sends = 0;
    const indexedTx = { hash: OUT_TX, account: ROOM_WALLET,
        now: Math.floor((NOW + 30_000) / 1000),
        description: { aborted: false, action: { success: true } },
        mc_block_seqno: 10, block_ref: { workchain: 0, shard: "8000000000000000", seqno: 10 },
        emulated: false, finality: 2,
        out_msgs: [{ hash: MESSAGE, source: ROOM_WALLET, destination: PAYER,
            value: "1498000000", bounced: false }] };
    const recipientTx = { hash: RECIPIENT_TX, account: PAYER,
        now: Math.floor((NOW + 31_000) / 1000),
        description: { aborted: false, action: { success: true } },
        mc_block_seqno: 11, block_ref: { workchain: 0, shard: "8000000000000000", seqno: 11 },
        emulated: false, finality: 2,
        in_msg: { hash: MESSAGE, source: ROOM_WALLET, destination: PAYER,
            value: "1498000000", bounced: false } };
    const fetchImpl = async requestUrl => {
        const url = new URL(String(requestUrl));
        if (url.pathname.endsWith("/masterchainInfo")) {
            return { status: 200, json: async () => ({ last: { global_id: -239, seqno: 20 } }) };
        }
        const account = url.searchParams.get("account");
        const transactions = account === ROOM_WALLET
            ? evidenceStage >= 1 ? [indexedTx] : []
            : evidenceStage >= 2 ? [recipientTx] : [];
        return { status: 200, json: async () => ({ transactions }) };
    };
    const adapter = {
        async estimateOutboundTransferFee() { return { ok: true, totalNano: 1_000_000n }; },
        async sendTransfer() { sends += 1; throw new Error("mock timeout after possible broadcast"); }
    };
    const independentVerifier = { async verifyTransfer(input) {
        return { status: "INDEPENDENT_INDEXED_CREDIT_OBSERVED", ...input,
            provider: "tonapi-mainnet", network: "mainnet", globalId: -239 };
    } };
    const firstRuntime = new MainnetPaymentRuntime({ config, fetchImpl, adapter,
        independentVerifier, nowProvider: () => NOW });
    firstRuntime.refundLifecycle.configureReservedWalletRoomNumberResolver(() => 4);
    firstRuntime.refundLifecycle.configureCurrentWalletReservationResolver(number => number === 4 ? ({
        walletId: "mainnet-wallet-4", roomNumber: 4, address: ROOM_WALLET,
        network: "mainnet", reservedByRoomId: ROOM
    }) : null);
    const players = Array.from({ length: 3 }, (_, index) => ({
        playerId: `player-${index + 1}`, paymentReference: `uncredited-${index + 1}`,
        expectedSender: index === 0 ? PAYER : `0:${String(index + 20).padStart(64, "0")}`,
        amountAtomic: "1000000000"
    }));
    firstRuntime.incomingLedger.createRoomPaymentIntents({ roomId: ROOM,
        wallet: { walletId: "mainnet-wallet-4", address: ROOM_WALLET, network: "mainnet", globalId: -239 },
        players, createdAt: NOW - 60_000, expiresAt: NOW + 10_000 });
    const intent = firstRuntime.incomingLedger.listRoomIntents(ROOM)[0];
    firstRuntime.incomingLedger.recordTransfer({
        observation: { network: "mainnet", globalId: -239, roomId: ROOM,
            transactionId: "uncredited-incoming", payloadFingerprint: "f".repeat(64),
            sourceAddress: PAYER, destinationAddress: ROOM_WALLET, amountAtomic: "1500000000",
            asset: "TON", transactionTime: NOW - 30_000, observedAt: NOW - 29_000 },
        receipt: { network: "mainnet", globalId: -239, status: "EXTRA_PAYMENT", reason: "AMOUNT_MISMATCH",
            roomId: ROOM, transactionId: "uncredited-incoming", paymentReference: intent.paymentReference,
            playerId: intent.playerId, amountAtomic: "1500000000", sourceAddress: PAYER,
            destinationAddress: ROOM_WALLET, asset: "TON", transactionTime: NOW - 30_000,
            updatedAt: NOW - 29_000 }
    });
    const obligation = firstRuntime.refundLifecycle.prepareClosedRoom({ roomId: ROOM, roomNumber: 4,
        closureReason: "pre_page5_destroyed", status: "DESTROYED" })[0];
    assert.equal(intent.state, "PENDING");
    assert.equal(obligation.amountAtomic, 1_500_000_000);
    const submission = await firstRuntime.refundLifecycle.submitRefund(obligation.obligationId);
    assert.equal(submission.outcome, "SUBMISSION_UNKNOWN");
    assert.equal(sends, 1);

    const restartedRuntime = new MainnetPaymentRuntime({ config, fetchImpl, adapter,
        independentVerifier, nowProvider: () => NOW + 60_000 });
    restartedRuntime.refundLifecycle.configureReservedWalletRoomNumberResolver(() => 4);
    restartedRuntime.refundLifecycle.configurePage5StateResolver(() => false);
    restartedRuntime.refundLifecycle.configureCurrentWalletReservationResolver(number => number === 4 ? ({
        walletId: "mainnet-wallet-4", roomNumber: 4, address: ROOM_WALLET,
        network: "mainnet", reservedByRoomId: ROOM
    }) : null);
    restartedRuntime.refundLifecycle.recover();
    const worker = new MainnetPendingRefundReconciler({ financialLedger: restartedRuntime.financialLedger,
        refundLifecycle: restartedRuntime.refundLifecycle, maxPerPass: 2 });

    const firstCheck = await worker.runPass();
    assert.equal(firstCheck.results[0].outcome, "FINALITY_PENDING");
    assert.equal(restartedRuntime.financialLedger.getRefund(obligation.obligationId).state, "SUBMISSION_UNKNOWN");
    assert.equal(sends, 1);

    evidenceStage = 1;
    const secondCheck = await worker.runPass();
    assert.equal(secondCheck.results[0].outcome, "FINALITY_PENDING");
    assert.equal(restartedRuntime.financialLedger.getRefund(obligation.obligationId).state, "SUBMISSION_UNKNOWN");

    evidenceStage = 2;
    const thirdCheck = await worker.runPass();
    assert.equal(thirdCheck.results[0].outcome, "REFUND_COMPLETE_TWO_SOURCES");
    assert.equal(restartedRuntime.financialLedger.getRefund(obligation.obligationId).state, "COMPLETE");
    assert.equal((await worker.runPass()).status, "NO_SUBMITTED_REFUNDS");
    assert.equal(sends, 1, "reconciliation never submits another independent refund transfer");
});

test("executor submits bounded PENDING batches sequentially and advances cyclically", async () => {
    const obligations = ["a", "b", "c", "d", "e"].map(obligationId => ({
        obligationId, state: "PENDING", network: "mainnet", globalId: -239
    })).concat([
        { obligationId: "unknown", state: "SUBMISSION_UNKNOWN", network: "mainnet", globalId: -239 },
        { obligationId: "testnet", state: "PENDING", network: "testnet", globalId: -3 }
    ]);
    const calls = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const runtime = makeExecutorRuntime({ obligations, calls, submit: async obligationId => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(resolve => setTimeout(resolve, 2));
        calls.push(obligationId);
        obligations.find(item => item.obligationId === obligationId).state = "SUBMITTED";
        concurrent -= 1;
        return { outcome: "SUBMITTED" };
    } });
    const executor = new MainnetPendingRefundExecutor({ paymentRuntime: runtime, maxPerPass: 2 });
    const first = await executor.runPass();
    const second = await executor.runPass();
    const third = await executor.runPass();
    assert.equal(first.attempted, 2);
    assert.equal(second.attempted, 2);
    assert.equal(third.attempted, 1);
    assert.deepEqual(calls, ["a", "b", "e", "c", "d"]);
    assert.deepEqual(new Set(calls), new Set(["a", "b", "c", "d", "e"]));
    assert.equal(maxConcurrent, 1);
    assert.equal((await executor.runPass()).status, "NO_PENDING_REFUNDS");
});

test("overlapping executor passes are coalesced and stop prevents later sends", async () => {
    const obligations = [{ obligationId: "pending", state: "PENDING", network: "mainnet", globalId: -239 }];
    const calls = [];
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const runtime = makeExecutorRuntime({ obligations, calls, submit: async id => {
        calls.push(id);
        await held;
        return { outcome: "SUBMITTED" };
    } });
    const executor = new MainnetPendingRefundExecutor({ paymentRuntime: runtime });
    const first = executor.runPass();
    assert.equal((await executor.runPass()).status, "EXECUTOR_IN_PROGRESS");
    assert.deepEqual(calls, ["pending"]);
    release();
    assert.equal((await first).attempted, 1);
    executor.stop();
    assert.equal((await executor.runPass()).status, "EXECUTOR_STOPPED");
    assert.deepEqual(calls, ["pending"]);
});

test("disabled production runtime leaves persisted PENDING refunds untouched across restart", async t => {
    const { config } = makeLedger(t);
    let estimates = 0;
    let sends = 0;
    const adapter = {
        async estimateOutboundTransferFee() { estimates += 1; return { ok: true, totalNano: 1_000_000n }; },
        async sendTransfer() { sends += 1; return { ok: true, txHash: "must-not-send" }; }
    };
    const firstRuntime = makeMockRefundRuntime(config, { adapter });
    const obligation = createPendingObligation(firstRuntime);
    assert.equal(obligation.state, "PENDING");
    assert.equal(firstRuntime.liveOperationsEnabled, false);
    assert.equal((await firstRuntime.pendingRefundExecutor.runPass()).status, "LIVE_OPERATIONS_DISABLED");
    assert.equal(firstRuntime.financialLedger.getRefund(obligation.obligationId).state, "PENDING");

    const restarted = makeMockRefundRuntime(config, { adapter });
    assert.equal(restarted.liveOperationsEnabled, false);
    assert.equal(restarted.financialLedger.getRefund(obligation.obligationId).state, "PENDING");
    assert.equal((await restarted.pendingRefundExecutor.runPass()).status, "LIVE_OPERATIONS_DISABLED");
    assert.equal(estimates, 0);
    assert.equal(sends, 0);
});

test("mock-enabled executor resumes PENDING work after restart; unknown submission is left to the reconciler", async t => {
    const { config } = makeLedger(t);
    let sends = 0;
    let estimates = 0;
    const adapter = {
        async estimateOutboundTransferFee() { estimates += 1; return { ok: true, totalNano: 1_000_000n }; },
        async sendTransfer() { sends += 1; return { ok: true, txHash: "synthetic-outgoing" }; }
    };
    const firstRuntime = makeMockRefundRuntime(config, { adapter });
    const obligation = createPendingObligation(firstRuntime);
    const runtime = makeMockRefundRuntime(config, { adapter });
    runtime.refundLifecycle.configureCurrentWalletReservationResolver(number => number === 4 ? ({
        walletId: "mainnet-wallet-4", roomNumber: 4, address: ROOM_WALLET,
        network: "mainnet", reservedByRoomId: ROOM
    }) : null);
    // Test-only fixture toggle: no production configuration or live RPC is enabled.
    runtime.liveOperationsEnabled = true;
    const first = await runtime.pendingRefundExecutor.runPass();
    assert.equal(first.attempted, 1);
    assert.equal(runtime.financialLedger.getRefund(obligation.obligationId).state, "SUBMITTED");
    assert.equal((await runtime.pendingRefundExecutor.runPass()).status, "NO_PENDING_REFUNDS");
    assert.equal(estimates, 1);
    assert.equal(sends, 1);

    const unknown = createPendingObligation(runtime, { roomId: "uncertain-refund-room", roomNumber: 5,
        walletAddress: `0:${"5".repeat(64)}`, payerAddress: `0:${"6".repeat(64)}` });
    runtime.liveOperationsEnabled = false;
    const afterAmbiguousRestart = makeMockRefundRuntime(config, { adapter });
    afterAmbiguousRestart.refundLifecycle.configureCurrentWalletReservationResolver(number => number === 5 ? ({
        walletId: "mainnet-wallet-5", roomNumber: 5, address: `0:${"5".repeat(64)}`,
        network: "mainnet", reservedByRoomId: "uncertain-refund-room"
    }) : null);
    afterAmbiguousRestart.liveOperationsEnabled = true;
    adapter.sendTransfer = async () => { sends += 1; throw new Error("synthetic uncertain RPC result"); };
    const uncertainPass = await afterAmbiguousRestart.pendingRefundExecutor.runPass();
    assert.equal(uncertainPass.attempted, 1);
    assert.equal(afterAmbiguousRestart.financialLedger.getRefund(unknown.obligationId).state, "SUBMISSION_UNKNOWN");
    assert.equal((await afterAmbiguousRestart.pendingRefundExecutor.runPass()).status, "NO_PENDING_REFUNDS");
    assert.equal(estimates, 2);
    assert.equal(sends, 2);
});

test("executor preserves wallet ownership guard and does not send for a room assigned elsewhere", async t => {
    const { config } = makeLedger(t);
    let estimates = 0;
    let sends = 0;
    const adapter = {
        async estimateOutboundTransferFee() { estimates += 1; return { ok: true, totalNano: 1_000_000n }; },
        async sendTransfer() { sends += 1; return { ok: true, txHash: "must-not-send" }; }
    };
    const runtime = makeMockRefundRuntime(config, { adapter });
    const obligation = createPendingObligation(runtime);
    runtime.refundLifecycle.configureCurrentWalletReservationResolver(number => number === 4 ? ({
        walletId: "mainnet-wallet-4", roomNumber: 4, address: ROOM_WALLET,
        network: "mainnet", reservedByRoomId: "new-active-room"
    }) : null);
    runtime.liveOperationsEnabled = true;

    const pass = await runtime.pendingRefundExecutor.runPass();
    assert.equal(pass.results[0].outcome, "WALLET_RESERVED_FOR_OTHER_ROOM");
    assert.equal(runtime.financialLedger.getRefund(obligation.obligationId).state, "PENDING");
    assert.equal(estimates, 0);
    assert.equal(sends, 0);
});
