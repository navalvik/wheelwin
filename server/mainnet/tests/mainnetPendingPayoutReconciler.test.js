import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMainnetRuntimeConfig } from "../config/MainnetRuntimeConfig.js";
import { MainnetPaymentRuntime } from "../payment/MainnetPaymentRuntime.js";
import { MainnetPendingPayoutReconciler } from "../payment/MainnetPendingPayoutReconciler.js";

const NOW = 1_800_000_000_000;
const SOURCE = `0:${"1".repeat(64)}`;
const WINNER = `0:${"2".repeat(64)}`;
const OWNER = `0:${"3".repeat(64)}`;
const hashes = {
    winnerSource: "a".repeat(64), winnerRecipient: "b".repeat(64), winnerMessage: "c".repeat(64),
    ownerSource: "d".repeat(64), ownerRecipient: "e".repeat(64), ownerMessage: "f".repeat(64)
};

function makeConfig(t) {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-payout-worker-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const catalog = JSON.stringify(Array.from({ length: 64 }, (_, index) => ({
        walletId: `payout-wallet-${index + 1}`, roomNumber: index + 1,
        address: `0:${String(index + 10).padStart(64, "0")}`, network: "mainnet"
    })));
    return loadMainnetRuntimeConfig({ TON_NETWORK: "mainnet",
        MAINNET_TONCENTER_API_KEY: "offline-payout-key", MAINNET_ROOM_WALLET_DATA_DIR: dataDir,
        MAINNET_ROOM_WALLETS_JSON: catalog });
}

function plan(payoutId, index = 0) {
    const addr = n => `0:${String(n).padStart(64, "0")}`;
    return { payoutId, roomId: `room-${index}`, roomNumber: index + 2,
        sourceWalletAddress: addr(index + 10), principalAtomic: 100_000_000,
        winner: { address: addr(index + 100), recipientId: `winner-${index}`, amountAtomic: 95_000_000 },
        owner: { address: addr(index + 200), recipientId: "owner", amountAtomic: 4_900_000 } };
}

test("scheduler scans only attempted unsettled legs, at most two, and rotates fairly", async () => {
    const payouts = Array.from({ length: 5 }, (_, index) => ({
        ...plan(`payout_${String(index + 1).padStart(32, "0")}`, index),
        winner: { ...plan("unused", index).winner, state: index % 2 ? "SUBMITTED" : "SUBMISSION_UNKNOWN" },
        owner: { ...plan("unused", index).owner, state: "PENDING" }
    }));
    payouts.push(
        { ...plan("payout_pending"), winner: { ...plan("x").winner, state: "PENDING" }, owner: { ...plan("y").owner, state: "PENDING" } },
        { ...plan("payout_unpaid"), winner: { ...plan("x").winner, state: "CONFIRMED" }, owner: { ...plan("y").owner, state: "UNPAID_INSUFFICIENT_GAS" } },
        { ...plan("payout_complete"), winner: { ...plan("x").winner, state: "CONFIRMED" }, owner: { ...plan("y").owner, state: "CONFIRMED" } }
    );
    const calls = [];
    const reconciler = new MainnetPendingPayoutReconciler({
        financialLedger: { network: "mainnet", globalId: -239, listPayouts: () => payouts },
        payoutLifecycle: { async reconcilePayout(id) { calls.push(id); return {
            payoutId: id, status: "PENDING", winnerState: "SUBMITTED", ownerState: "PENDING"
        }; } }
    });
    const first = await reconciler.runPass();
    const second = await reconciler.runPass();
    const third = await reconciler.runPass();
    assert.equal(first.scanned, 2);
    assert.equal(second.scanned, 2);
    assert.equal(third.scanned, 2);
    assert.deepEqual(calls, [
        payouts[0].payoutId, payouts[1].payoutId,
        payouts[2].payoutId, payouts[3].payoutId,
        payouts[4].payoutId, payouts[0].payoutId
    ]);
    assert.ok(!calls.includes("payout_pending"));
    assert.ok(!calls.includes("payout_unpaid"));
    assert.ok(!calls.includes("payout_complete"));
});

test("parallel passes do not repeat a plan and stop prevents new passes", async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    let calls = 0;
    const reconciler = new MainnetPendingPayoutReconciler({
        financialLedger: { network: "mainnet", globalId: -239,
            listPayouts: () => [{ ...plan("payout_once"),
                winner: { ...plan("winner").winner, state: "SUBMITTED" },
                owner: { ...plan("owner").owner, state: "PENDING" } }] },
        payoutLifecycle: { async reconcilePayout() { calls += 1; await pending; return { status: "PENDING" }; } }
    });
    const first = reconciler.runPass();
    assert.equal((await reconciler.runPass()).status, "RECONCILIATION_IN_PROGRESS");
    assert.equal(calls, 1);
    release();
    assert.equal((await first).scanned, 1);
    reconciler.stop();
    assert.equal((await reconciler.runPass()).status, "RECONCILIATION_STOPPED");
    assert.equal(calls, 1);
});

test("restart reconciles attempted winner then owner with Toncenter + TonAPI mocks and never sends", async t => {
    const config = makeConfig(t);
    let sends = 0;
    let feeQuotes = 0;
    const adapter = {
        async sendTransfer() { sends += 1; throw new Error("read-only payout recovery must not send"); },
        async estimateOutboundTransferFee() { feeQuotes += 1; throw new Error("read-only payout recovery has no fee quote"); }
    };
    const transactions = new Map([
        [hashes.winnerSource, { hash: hashes.winnerSource, account: SOURCE,
            now: Math.floor((NOW + 10_000) / 1000), description: { aborted: false, action: { success: true } },
            mc_block_seqno: 10, block_ref: { workchain: 0, shard: "8000000000000000", seqno: 10 },
            emulated: false, finality: 2,
            out_msgs: [{ hash: hashes.winnerMessage, source: SOURCE, destination: WINNER,
                value: "95000000", bounced: false }] }],
        [hashes.winnerRecipient, { hash: hashes.winnerRecipient, account: WINNER,
            now: Math.floor((NOW + 11_000) / 1000), description: { aborted: false, action: { success: true } },
            mc_block_seqno: 11, block_ref: { workchain: 0, shard: "8000000000000000", seqno: 11 },
            emulated: false, finality: 2,
            in_msg: { hash: hashes.winnerMessage, source: SOURCE, destination: WINNER,
                value: "95000000", bounced: false } }],
        [hashes.ownerSource, { hash: hashes.ownerSource, account: SOURCE,
            now: Math.floor((NOW + 12_000) / 1000), description: { aborted: false, action: { success: true } },
            mc_block_seqno: 12, block_ref: { workchain: 0, shard: "8000000000000000", seqno: 12 },
            emulated: false, finality: 2,
            out_msgs: [{ hash: hashes.ownerMessage, source: SOURCE, destination: OWNER,
                value: "4900000", bounced: false }] }],
        [hashes.ownerRecipient, { hash: hashes.ownerRecipient, account: OWNER,
            now: Math.floor((NOW + 13_000) / 1000), description: { aborted: false, action: { success: true } },
            mc_block_seqno: 13, block_ref: { workchain: 0, shard: "8000000000000000", seqno: 13 },
            emulated: false, finality: 2,
            in_msg: { hash: hashes.ownerMessage, source: SOURCE, destination: OWNER,
                value: "4900000", bounced: false } }]
    ]);
    const fetchImpl = async requestUrl => {
        const url = new URL(String(requestUrl));
        if (url.pathname.endsWith("/masterchainInfo")) {
            return { status: 200, json: async () => ({ last: { global_id: -239, seqno: 30 } }) };
        }
        const account = url.searchParams.get("account");
        return { status: 200, json: async () => ({ transactions: [...transactions.values()]
            .filter(row => row.account === account) }) };
    };
    const tonapiCalls = [];
    const independentVerifier = { async verifyTransfer(input) {
        tonapiCalls.push(input);
        return { status: "INDEPENDENT_INDEXED_CREDIT_OBSERVED", ...input,
            provider: "tonapi-mainnet", network: "mainnet", globalId: -239, actualFeeAtomic: 123 };
    } };

    const firstRuntime = new MainnetPaymentRuntime({ config, fetchImpl, adapter,
        independentVerifier, nowProvider: () => NOW });
    const created = firstRuntime.payoutLifecycle.createPayout({
        payoutId: "payout_restart_worker", roomId: "payout-restart-room", roomNumber: 9,
        sourceWalletAddress: SOURCE, principalAtomic: 100_000_000,
        winner: { recipientId: "winner", address: WINNER },
        owner: { recipientId: "owner", address: OWNER }
    });
    // Winner's submission outcome is unknown, so recovery must discover the
    // already-existing transfer from indexed history; owner has a submitted ID.
    for (const [role, transactionId] of [["winner", null], ["owner", hashes.ownerSource]]) {
        firstRuntime.financialLedger.updatePayoutLeg(created.payoutId, role, { state: "SUBMISSION_UNKNOWN" });
        if (transactionId) {
            firstRuntime.financialLedger.updatePayoutLeg(created.payoutId, role, { state: "SUBMITTED", transactionId });
        }
    }

    const restartedRuntime = new MainnetPaymentRuntime({ config, fetchImpl, adapter,
        independentVerifier, nowProvider: () => NOW + 60_000 });
    assert.equal(restartedRuntime.financialLedger.listPayouts().length, 1);
    const reconciler = new MainnetPendingPayoutReconciler({
        financialLedger: restartedRuntime.financialLedger,
        payoutLifecycle: restartedRuntime.payoutLifecycle,
        maxPerPass: 2
    });
    const pass = await reconciler.runPass();
    assert.equal(pass.scanned, 1);
    assert.equal(pass.results[0].winnerState, "CONFIRMED");
    assert.equal(pass.results[0].ownerState, "CONFIRMED");
    assert.deepEqual(tonapiCalls.map(call => call.sourceTransactionId), [hashes.winnerSource, hashes.ownerSource]);
    assert.equal(restartedRuntime.financialLedger.getPayout(created.payoutId).state, "COMPLETE");
    assert.equal((await reconciler.runPass()).status, "NO_SUBMITTED_PAYOUTS");
    assert.equal(tonapiCalls.length, 2, "completed payout must not be rechecked");
    assert.equal(sends, 0);
    assert.equal(feeQuotes, 0);
});

test("missing dual-source evidence leaves payout unsettled and never retries submission", async t => {
    const config = makeConfig(t);
    let sends = 0;
    const runtime = new MainnetPaymentRuntime({ config, adapter: {
        async sendTransfer() { sends += 1; throw new Error("must not send"); },
        async estimateOutboundTransferFee() { throw new Error("must not quote fees"); }
    }, nowProvider: () => NOW });
    const payout = runtime.payoutLifecycle.createPayout({
        payoutId: "payout_pending_evidence", roomId: "payout-pending-room", roomNumber: 10,
        sourceWalletAddress: SOURCE, principalAtomic: 100_000_000,
        winner: { recipientId: "winner", address: WINNER },
        owner: { recipientId: "owner", address: OWNER }
    });
    runtime.financialLedger.updatePayoutLeg(payout.payoutId, "winner", { state: "SUBMISSION_UNKNOWN" });
    runtime.financialLedger.updatePayoutLeg(payout.payoutId, "winner", { state: "SUBMITTED", transactionId: hashes.winnerSource });
    const reconciler = new MainnetPendingPayoutReconciler({
        financialLedger: runtime.financialLedger, payoutLifecycle: runtime.payoutLifecycle
    });
    const pass = await reconciler.runPass();
    assert.equal(pass.scanned, 1);
    assert.equal(runtime.financialLedger.getPayout(payout.payoutId).winner.state, "SUBMITTED");
    assert.equal(runtime.financialLedger.getPayout(payout.payoutId).owner.state, "PENDING");
    assert.equal(sends, 0);
});
