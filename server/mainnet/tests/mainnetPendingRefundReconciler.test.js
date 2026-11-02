import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMainnetRuntimeConfig } from "../config/MainnetRuntimeConfig.js";
import { MainnetPaymentRuntime } from "../payment/MainnetPaymentRuntime.js";
import { MainnetPendingRefundReconciler } from "../payment/MainnetPendingRefundReconciler.js";

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
