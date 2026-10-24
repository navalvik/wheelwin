import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Address, beginCell, internal, storeMessageRelaxed } from "@ton/core";
import { RefundObligationStore } from "../payment/refund/RefundObligationStore.js";
import { RefundLifecycleCoordinator } from "../payment/refund/RefundLifecycleCoordinator.js";
import { NativeGramRefundTransferPlanStore } from "../payment/refund/NativeGramRefundTransferPlanStore.js";
import { TestnetOutgoingRefundProvider } from "../payment/refund/TestnetOutgoingRefundProvider.js";
import { WalletV4SignedNativeGramRefundInspector } from "../payment/refund/WalletV4SignedNativeGramRefundInspector.js";
import { walletV4SignedBodyHash } from "../payment/refund/WalletV4SignedPayloadSignature.js";
import { LIVE_PAYMENT_ACCEPTANCE_ENABLED } from "../payment/PaymentLifecycleAvailability.js";

// Offline fixtures only: the estimator and on-chain readers below are explicit
// test doubles. Real Ed25519 signing/decoding is exercised with ephemeral keys.
const NOW = 1800000000000;
const SOURCE = "0:" + "b".repeat(64);
const PAYER = "0:" + "a".repeat(64);
const CODE = "feb5ff6820e2ff0d9483e7e0d62c817d846789fb4ae580c878866d959dabd5c0";
const WALLET_ID = 698983191;
const record = id => ({
    schemaVersion: 1, obligationId: `refund_${id}`, idempotencyKey: `TESTNET:payment_${id}:incoming_${id}`,
    networkName: "TESTNET", globalId: -3, roomId: "room-a", roomNumber: 1, playerId: id,
    paymentIntentId: `payment_${id}`, incomingTransactionId: `incoming_${id}`,
    amountAtomic: 1000000000, denomination: "TON", payerAddress: PAYER, refundDestination: PAYER,
    closureReason: "setup_expired", createdAtMs: NOW, state: "PENDING", attempts: [],
    outgoingTransactionId: null, finalizedEvidence: null, lastError: null
});

function harness(t) {
    const root = mkdtempSync(join(tmpdir(), "issue17-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new RefundObligationStore({ dataDir: root }).initialize();
    const plans = new NativeGramRefundTransferPlanStore({ dataDir: root });
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const sources = new Map();
    const calls = { signs: 0, broadcasts: 0, estimates: 0 };
    const state = { seqno: 1, fee: "10000000", success: true, bounced: false, ambiguous: false, tamper: false, globalId: -3, hash: null };
    const publicBytes = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const intentStore = { require(id) {
        const obligation = store.list().find(item => item.paymentIntentId === id);
        return { paymentReference: id, state: "SETTLED", network: "testnet", asset: "TON",
            roomId: obligation.roomId, playerId: obligation.playerId, transactionId: obligation.incomingTransactionId,
            amountAtomic: obligation.amountAtomic, expectedSender: PAYER,
            destinationWalletAddress: sources.get(id) ?? SOURCE };
    } };
    const inspector = new WalletV4SignedNativeGramRefundInspector({ nowSeconds: () => NOW / 1000,
        walletStateReader: { async getVerifiedWalletState({ sourceWalletAddress }) {
            return { verifiedOnChain: true, networkName: "TESTNET", globalId: state.globalId,
                sourceWalletAddress, version: "V4R2", codeHash: CODE, walletId: WALLET_ID,
                seqno: state.seqno, publicKey: publicBytes };
        } }
    });
    const signer = { async signPlannedRefund(descriptor) {
        calls.signs++;
        assert.equal(store.get(descriptor.obligationId).state, "SUBMISSION_UNKNOWN");
        const message = beginCell().store(storeMessageRelaxed(internal({
            to: Address.parse(descriptor.to), value: BigInt(descriptor.amountAtomic), bounce: true
        }))).endCell();
        const body = beginCell().storeUint(WALLET_ID, 32).storeUint(NOW / 1000 + 120, 32)
            .storeUint(state.seqno, 32).storeUint(0, 8).storeUint(1, 8).storeRef(message).endCell();
        const signature = sign(null, body.hash(), privateKey);
        if (state.tamper) signature[0] ^= 1;
        const signed = beginCell().storeBuffer(signature).storeSlice(body.beginParse()).endCell();
        return { ...descriptor, boc: signed.toBoc().toString("base64") };
    } };
    const broadcaster = { async broadcast({ signedTransfer }) {
        calls.broadcasts++;
        const receipt = plans.getSignedMessage(signedTransfer.obligationId);
        assert.equal(receipt.signedBodyHash, walletV4SignedBodyHash(Buffer.from(signedTransfer.boc, "base64")));
        if (state.ambiguous) throw Error("transport credential value that must never be logged");
        return { status: "SUBMITTED", transactionId: "tx-" + signedTransfer.obligationId };
    } };
    const feeEstimator = { async estimateRefundFee(input) {
        calls.estimates++;
        return { ...input, maxFeeAtomic: "10000000", finalized: true, estimateSource: "testnet-network-estimator" };
    } };
    const finalityEvidenceProvider = { async getSettlementEvidence({ accountId, providerTransactionId }) {
        const block = { workchain: 0, shard: "8000000000000000", seqno: 10 };
        return {
            networkIdentity: { network: "testnet", globalId: -3, source: "toncenter-masterchain-info", observedAtMs: NOW },
            transactionInclusion: { transactionId: providerTransactionId, accountId, block },
            finality: { status: "finalized", source: "toncenter-streaming-v2", transactionId: providerTransactionId,
                accountId, block, masterchainSeqno: 11, observedAtMs: NOW }
        };
    } };
    const outgoingTransferProvider = {
        async findOutgoingTransfer(query) {
            assert.match(query.signedBodyHash, /^[a-f0-9]{64}$/);
            const obligation = store.list().find(item => plans.getSignedMessage(item.obligationId)?.signedBodyHash === query.signedBodyHash);
            return { transactionId: "tx-" + obligation.obligationId, ambiguous: false };
        },
        async getOutgoingTransfer({ sourceWalletAddress, transactionId }) {
            return { transactionId, sourceAddress: sourceWalletAddress, destinationAddress: PAYER,
                amountAtomic: 990000000, actualFeeAtomic: state.fee, success: state.success, bounced: state.bounced,
                signedBodyHash: state.hash ?? plans.getSignedMessage(transactionId.slice(3)).signedBodyHash };
        }
    };
    const bundle = { globalId: -3, signer, broadcaster, feeEstimator, refundPlanStore: plans,
        signedTransferInspector: inspector, finalityEvidenceProvider, outgoingTransferProvider };
    const provider = new TestnetOutgoingRefundProvider(bundle);
    const coordinator = new RefundLifecycleCoordinator({ store, intentStore, nowProvider: () => NOW, outgoingRefundProvider: provider });
    function add(id, source = SOURCE) {
        const obligation = store.create(record(id)).obligation;
        sources.set(obligation.paymentIntentId, source);
        return obligation;
    }
    return { root, store, plans, provider, coordinator, intentStore, add, calls, state, bundle };
}

test("real signed V4 bytes traverse durable plan, UNKNOWN, broadcast and exact-fee finality", async t => {
    const h = harness(t), obligation = h.add("a");
    assert.equal((await h.coordinator.submitRefund(obligation.obligationId)).outcome, "SUBMITTED");
    assert.equal((await h.coordinator.finalizeRefund(obligation.obligationId)).outcome, "COMPLETE");
    const evidence = h.store.get(obligation.obligationId).finalizedEvidence;
    assert.equal(evidence.actualFeeAtomic, "10000000");
    assert.equal(evidence.signedBodyHash, h.plans.getSignedMessage(obligation.obligationId).signedBodyHash);
    assert.equal(LIVE_PAYMENT_ACCEPTANCE_ENABLED, false);
});

test("concurrent workers submit an obligation once and retain UNKNOWN across restart", async t => {
    const h = harness(t), obligation = h.add("a");
    h.state.ambiguous = true;
    const otherStore = new RefundObligationStore({ dataDir: h.root }).initialize();
    const other = new RefundLifecycleCoordinator({ store: otherStore, intentStore: h.intentStore,
        nowProvider: () => NOW, outgoingRefundProvider: h.provider });
    const results = await Promise.allSettled([h.coordinator.submitRefund(obligation.obligationId), other.submitRefund(obligation.obligationId)]);
    assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
    assert.equal(h.calls.signs, 1); assert.equal(h.calls.broadcasts, 1);
    assert.equal(otherStore.get(obligation.obligationId).state, "SUBMISSION_UNKNOWN");
    const restarted = new RefundObligationStore({ dataDir: h.root }).initialize();
    const readOnly = new TestnetOutgoingRefundProvider({ ...h.bundle, signer: null, broadcaster: null });
    const recovery = new RefundLifecycleCoordinator({ store: restarted, intentStore: h.intentStore, nowProvider: () => NOW });
    assert.equal(readOnly.canExecute(), false);
    assert.equal((await recovery.reconcileAmbiguousSubmission(obligation.obligationId, { provider: readOnly })).outcome, "COMPLETE");
    await assert.rejects(other.submitRefund(obligation.obligationId), /not awaiting submission/);
    assert.equal(h.calls.broadcasts, 1);
});

test("separate OS processes cannot both claim the same durable submission", async t => {
    const h = harness(t), obligation = h.add("a");
    const worker = fileURLToPath(new URL("./fixtures/refundClaimWorker.js", import.meta.url));
    const run = () => promisify(execFile)(process.execPath, [worker, h.root, obligation.obligationId, SOURCE]);
    const results = await Promise.all([run(), run()]);
    assert.deepEqual(results.map(item => item.stdout).sort(), ["CLAIMED", "HELD"]);
    assert.equal(h.store.get(obligation.obligationId).state, "SUBMISSION_UNKNOWN");
    await assert.rejects(h.coordinator.submitRefund(obligation.obligationId), /not awaiting submission/);
    assert.equal(h.calls.broadcasts, 0);
});

test("a settled intent from another room cannot select a refund source wallet", async t => {
    const h = harness(t), obligation = h.add("a");
    const original = h.intentStore.require;
    for (const mutation of [ { roomId: "other-room" }, { playerId: "other-player" },
        { network: "mainnet" }, { state: "MATCHED" }, { transactionId: "other-payment" } ]) {
        h.intentStore.require = id => ({ ...original(id), ...mutation });
        await assert.rejects(h.coordinator.submitRefund(obligation.obligationId), /durable payment intent/);
    }
    assert.equal(h.calls.signs, 0); assert.equal(h.calls.broadcasts, 0);
});

test("one unresolved refund holds its wallet; an independent room wallet can proceed", async t => {
    const h = harness(t), a = h.add("a"), b = h.add("b"), c = h.add("c", "0:" + "c".repeat(64));
    const results = await Promise.allSettled([h.coordinator.submitRefund(a.obligationId), h.coordinator.submitRefund(b.obligationId)]);
    assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
    assert.match(results.find(item => item.status === "rejected").reason.message, /unresolved refund/);
    await h.coordinator.submitRefund(c.obligationId);
    assert.equal(h.calls.broadcasts, 2);
    await h.coordinator.finalizeRefund(a.obligationId);
    h.state.seqno++;
    await h.coordinator.submitRefund(b.obligationId);
    assert.equal(h.calls.broadcasts, 3);
});

test("crash after verified body persistence never grants a direct provider resend", async t => {
    const h = harness(t), obligation = h.add("a");
    h.state.ambiguous = true;
    await h.coordinator.submitRefund(obligation.obligationId);
    const restarted = new TestnetOutgoingRefundProvider({ ...h.bundle,
        refundPlanStore: new NativeGramRefundTransferPlanStore({ dataDir: h.root }) });
    const result = await restarted.signAndBroadcast({ obligation, sourceWalletAddress: SOURCE, nowMs: NOW });
    assert.equal(result.outcome, "FAILED");
    assert.equal(h.calls.broadcasts, 1);
});

test("crashed transition lock fails closed without deleting or timing out the hold", async t => {
    const h = harness(t), obligation = h.add("a");
    mkdirSync(join(h.root, "refund-transition.lock"));
    await assert.rejects(h.coordinator.submitRefund(obligation.obligationId), { code: "EEXIST" });
    assert.equal(h.calls.signs, 0); assert.equal(h.calls.broadcasts, 0);
    const restart = new RefundObligationStore({ dataDir: h.root }).initialize();
    assert.equal(restart.get(obligation.obligationId).state, "PENDING");
});

test("malformed BOC, bad signature and wrong network cannot reach broadcast", async t => {
    for (const mode of ["signature", "network", "boc", "wallet"]) {
        await t.test(mode, async t => {
            const h = harness(t), obligation = h.add("a");
            if (mode === "signature") h.state.tamper = true;
            if (mode === "network") h.state.globalId = -239;
            if (mode === "boc") h.bundle.signer.signPlannedRefund = async descriptor => ({ ...descriptor, boc: "AAAA" });
            if (mode === "wallet") h.bundle.signer.signPlannedRefund = async descriptor => ({ ...descriptor, from: PAYER, boc: "AAAA" });
            await h.coordinator.submitRefund(obligation.obligationId);
            assert.equal(h.calls.broadcasts, 0);
            assert.equal(h.plans.getSignedMessage(obligation.obligationId), null);
        });
    }
});

test("fee overrun, unused reserve and historical same-value transfer remain unresolved", async t => {
    for (const [field, value, reason] of [
        ["fee", "10000001", "REFUND_FEE_OVERRUN"], ["fee", "9999999", "REFUND_UNUSED_FEE_RESERVE"],
        ["hash", "f".repeat(64), "REFUND_SIGNED_MESSAGE_MISMATCH"], ["success", false, "REFUND_EXECUTION_NOT_SUCCESSFUL"]
    ]) await t.test(reason, async t => {
        const h = harness(t), obligation = h.add("a");
        h.state.ambiguous = true;
        await h.coordinator.submitRefund(obligation.obligationId);
        h.state[field] = value;
        const result = await h.coordinator.reconcileAmbiguousSubmission(obligation.obligationId);
        assert.equal(result.reason, reason);
        assert.equal(result.outcome, "RECONCILIATION_REQUIRED");
        assert.equal(h.calls.broadcasts, 1);
        assert.equal(new RefundObligationStore({ dataDir: h.root }).initialize().get(obligation.obligationId).finalizedEvidence, null);
    });
});

test("unassured fee retries leave PENDING and never call signer or persist a plan", async t => {
    const h = harness(t), obligation = h.add("a");
    h.bundle.feeEstimator.estimateRefundFee = async () => { throw Error("REFUND_FEE_NOT_GUARANTEED"); };
    for (let attempt = 0; attempt < 2; attempt++)
        await assert.rejects(h.coordinator.submitRefund(obligation.obligationId), /REFUND_FEE_NOT_GUARANTEED/);
    assert.equal(h.plans.get(obligation.obligationId), null);
    assert.equal(h.store.get(obligation.obligationId).state, "PENDING");
    assert.equal(h.calls.signs, 0); assert.equal(h.calls.broadcasts, 0);
});

test("transport messages cannot enter logs or durable refund records", async t => {
    const h = harness(t), obligation = h.add("a"), logs = [];
    h.coordinator._logger = { warn: value => logs.push(value) };
    h.bundle.broadcaster.broadcast = async () => ({ status: "UNKNOWN", reason: "opaque-credential-123" });
    const result = await h.coordinator.submitRefund(obligation.obligationId);
    assert.equal(result.reason, "BROADCAST_OUTCOME_AMBIGUOUS");
    const disk = readFileSync(join(h.root, "refund-obligations", obligation.obligationId + ".json"), "utf8");
    assert.equal((JSON.stringify(logs) + disk).includes("opaque-credential-123"), false);
});
