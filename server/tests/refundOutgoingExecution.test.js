import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PaymentIntent } from "../payment/PaymentIntent.js";
import { PAYMENT_INTENT_STATE } from "../payment/PaymentIntentStatus.js";
import { PaymentIntentStore } from "../payment/PaymentIntentStore.js";
import { LedgerStore } from "../payment/ledger/LedgerStore.js";
import { LEDGER_ENTRY_KIND } from "../payment/ledger/LedgerConstants.js";
import {
    RefundLifecycleCoordinator,
    TestnetRefundProvider
} from "../payment/refund/RefundLifecycleCoordinator.js";
import {
    REFUND_STATE,
    RefundObligation
} from "../payment/refund/RefundObligation.js";
import { RefundObligationStore } from "../payment/refund/RefundObligationStore.js";
import { NativeGramRefundTransferPlanStore } from "../payment/refund/NativeGramRefundTransferPlanStore.js";
import { buildNativeGramRefundTransferPlan } from "../payment/refund/NativeGramRefundTransferPlan.js";
import { signedRefundBocHashOrNull } from "../payment/refund/SignedNativeGramRefundEvidence.js";
import { makeNativeRefundV4Boc } from "./fixtures/nativeRefundV4BocFixture.js";
import {
    TestnetOutgoingRefundProvider,
    OUTGOING_SUBMISSION_OUTCOME,
    TON_TESTNET_GLOBAL_ID
} from "../payment/refund/TestnetOutgoingRefundProvider.js";
import { buildPaymentRuntime } from "../payment/runtime/PaymentRuntimeFactory.js";
import { LIVE_PAYMENT_ACCEPTANCE_ENABLED } from "../payment/PaymentLifecycleAvailability.js";

const NOW = 1_800_000_000_000;
const TESTNET_PAYER = `0:${"a".repeat(64)}`;
const TESTNET_ROOM_WALLET = `0:${"b".repeat(64)}`;

function harness(confirmedCount = 1) {
    const root = mkdtempSync(join(tmpdir(), "wheelwin-refund-outgoing-"));
    const intentStore = new PaymentIntentStore({ dataDir: join(root, "payments"), nowProvider: () => NOW });
    const ledgerStore = new LedgerStore({ dataDir: join(root, "ledger"), nowProvider: () => NOW });
    const store = new RefundObligationStore({ dataDir: join(root, "refunds") });
    intentStore.initialize();
    ledgerStore.initialize();
    store.initialize();

    for (let index = 0; index < 3; index += 1) {
        const paymentReference = `payment_${index}`;
        const transactionId = `incoming_${index}`;
        const intent = new PaymentIntent({
            paymentReference,
            roomId: "room-x",
            playerId: `player-${index}`,
            network: "testnet",
            destinationWalletId: "wallet-testnet",
            destinationWalletAddress: TESTNET_ROOM_WALLET,
            expectedSender: TESTNET_PAYER,
            amountAtomic: 1_000_000_000,
            asset: "TON",
            createdAt: NOW - 1000,
            expiresAt: NOW + 1000,
            roomDeadlineMs: NOW + 2000
        });
        intentStore.save(intent);
        if (index < confirmedCount) {
            const matched = intent.transition(PAYMENT_INTENT_STATE.MATCHED, { transactionId, now: NOW });
            intentStore.update(matched);
            intentStore.update(matched.transition(PAYMENT_INTENT_STATE.SETTLED, { now: NOW }));
            ledgerStore.append({
                idempotencyKey: `principal:${paymentReference}`,
                roomId: "room-x",
                kind: LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL,
                amountAtomic: intent.amountAtomic,
                playerId: intent.playerId,
                asset: intent.asset,
                network: intent.network,
                metadata: {
                    paymentReference,
                    transactionId,
                    intentState: "SETTLED",
                    source: "SETTLED_PAYMENT_INTENT"
                }
            });
        }
    }
    const coordinator = new RefundLifecycleCoordinator({ store, intentStore, ledgerStore, nowProvider: () => NOW });
    return { root, store, intentStore, ledgerStore, coordinator, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function prepareObligations(h, count = 1) {
    const result = h.coordinator.prepareClosedRoom({
        roomId: "room-x",
        roomNumber: 37,
        closureReason: "setup_expired",
        status: "DESTROYED"
    });
    const expected = count === 3 ? 0 : count;
    assert.equal(result.length, expected);
    assert.equal(h.store.size, expected);
    return h.store.list();
}

function makeSyntheticFinalityEvidence({ accountId, transactionId }) {
    const block = { workchain: 0, shard: "8000000000000000", seqno: 10 };
    const observedAtMs = NOW;
    return {
        networkIdentity: {
            network: "testnet",
            globalId: -3,
            source: "toncenter-masterchain-info",
            observedAtMs
        },
        transactionInclusion: {
            transactionId,
            accountId,
            block
        },
        finality: {
            status: "finalized",
            source: "toncenter-streaming-v2",
            transactionId,
            accountId,
            block,
            masterchainSeqno: 11,
            observedAtMs
        }
    };
}

function makeMocks({ failBroadcast = false, ambiguousBroadcast = false, failSigner = false, missingEvidence = false, missingTransfer = false }) {
    const calls = { sign: 0, broadcast: 0 };
    const signer = {
        signTransfer() {
            calls.sign += 1;
            if (failSigner) throw new Error("signer unavailable");
            return { type: "signed", payload: "payload" };
        }
    };
    const broadcaster = {
        broadcast() {
            calls.broadcast += 1;
            if (failBroadcast) throw new Error("broadcast error");
            if (ambiguousBroadcast) return { status: "UNKNOWN", reason: "timeout after send" };
            return { status: "SUBMITTED", transactionId: "outgoing-testnet-tx" };
        }
    };
    const finalityEvidenceProvider = {
        async getSettlementEvidence({ accountId, providerTransactionId }) {
            if (missingEvidence) return null;
            return makeSyntheticFinalityEvidence({ accountId, transactionId: providerTransactionId });
        }
    };
    const outgoingTransferProvider = {
        async getOutgoingTransfer({ sourceWalletAddress, transactionId }) {
            if (missingTransfer) return null;
            return {
                transactionId,
                sourceAddress: sourceWalletAddress,
                destinationAddress: TESTNET_PAYER,
                amountAtomic: 1_000_000_000
            };
        },
        async findOutgoingTransfer() {
            if (missingTransfer) return null;
            return {
                transactionId: "outgoing-testnet-tx",
                ambiguous: false
            };
        }
    };
    return { signer, broadcaster, finalityEvidenceProvider, outgoingTransferProvider, calls };
}

async function testValidSubmission() {
    const h = harness(1);
    try {
        const obligations = prepareObligations(h, 1);
        const obligation = obligations[0];
        assert.equal(obligation.state, REFUND_STATE.PENDING);

        const mocks = makeMocks({});
        const provider = new TestnetOutgoingRefundProvider({
            globalId: -3,
            signer: mocks.signer,
            broadcaster: mocks.broadcaster,
            finalityEvidenceProvider: mocks.finalityEvidenceProvider,
            outgoingTransferProvider: mocks.outgoingTransferProvider
        });
        assert.equal(provider.canExecute(), true);

        const resSubmit = await h.coordinator.submitRefund(obligation.obligationId, { provider });
        assert.equal(resSubmit.outcome, "SUBMITTED");
        assert.equal(resSubmit.outgoingTransactionId, "outgoing-testnet-tx");

        const afterSubmit = h.store.get(obligation.obligationId);
        assert.equal(afterSubmit.state, REFUND_STATE.SUBMITTED);
        assert.equal(afterSubmit.outgoingTransactionId, "outgoing-testnet-tx");

        const resFinalize = await h.coordinator.finalizeRefund(obligation.obligationId, { provider });
        assert.equal(resFinalize.outcome, "COMPLETE");

        const afterComplete = h.store.get(obligation.obligationId);
        assert.equal(afterComplete.state, REFUND_STATE.COMPLETE);
        assert.ok(afterComplete.finalizedEvidence);
        assert.equal(afterComplete.finalizedEvidence.finalized, true);
        assert.equal(afterComplete.finalizedEvidence.transactionId, "outgoing-testnet-tx");
        assert.equal(afterComplete.finalizedEvidence.destination, TESTNET_PAYER);
        assert.equal(afterComplete.finalizedEvidence.amountAtomic, 1_000_000_000);
        assert.equal(afterComplete.finalizedEvidence.networkName, "TESTNET");
        assert.equal(afterComplete.finalizedEvidence.globalId, -3);
    } finally {
        h.cleanup();
    }
}

async function testRejections() {
    const h = harness(1);
    try {
        const [obligation] = prepareObligations(h, 1);

        // Reject identity-only provider cannot execute
        const identityOnly = new TestnetRefundProvider({ globalId: -3 });
        await assert.rejects(h.coordinator.submitRefund(obligation.obligationId, { provider: identityOnly }), /no outgoing refund provider|not authorized|signer/i);

        // Reject constructing provider with MAINNET globalId
        const mocks = makeMocks({});
        assert.throws(
            () => new TestnetOutgoingRefundProvider({
                globalId: -239,
                signer: mocks.signer,
                broadcaster: mocks.broadcaster,
                finalityEvidenceProvider: mocks.finalityEvidenceProvider,
                outgoingTransferProvider: mocks.outgoingTransferProvider
            }),
            /global ID -3/
        );

        // Store cannot complete without evidence via update (keep block)
        const sub = h.store.get(obligation.obligationId);
        const withUnknown = h.store.update({ ...sub.toRecord(), state: REFUND_STATE.SUBMISSION_UNKNOWN, attempts: [] });
        assert.throws(() => h.store.update({ ...withUnknown.toRecord(), state: REFUND_STATE.COMPLETE }), /submission and completion are disabled|cannot be complete/);
    } finally {
        h.cleanup();
    }
}

async function testAmbiguousNoBlindResubmit() {
    const h = harness(1);
    try {
        const [obligation] = prepareObligations(h, 1);
        const mocks = makeMocks({ ambiguousBroadcast: true });
        const provider = new TestnetOutgoingRefundProvider({
            globalId: -3,
            signer: mocks.signer,
            broadcaster: mocks.broadcaster,
            finalityEvidenceProvider: mocks.finalityEvidenceProvider,
            outgoingTransferProvider: mocks.outgoingTransferProvider
        });
        const res = await h.coordinator.submitRefund(obligation.obligationId, { provider });
        assert.equal(res.outcome, "SUBMISSION_UNKNOWN");
        const after = h.store.get(obligation.obligationId);
        assert.equal(after.state, REFUND_STATE.SUBMISSION_UNKNOWN);
        const signCountBefore = mocks.calls.sign;
        await assert.rejects(h.coordinator.submitRefund(obligation.obligationId, { provider }), /not awaiting submission/);
        assert.equal(mocks.calls.sign, signCountBefore, "no blind resubmission");
    } finally {
        h.cleanup();
    }
}

async function testSignerUnavailable() {
    const h = harness(1);
    try {
        const [obligation] = prepareObligations(h, 1);
        const mocks = makeMocks({ failSigner: true });
        const provider = new TestnetOutgoingRefundProvider({
            globalId: -3,
            signer: mocks.signer,
            broadcaster: mocks.broadcaster,
            finalityEvidenceProvider: mocks.finalityEvidenceProvider,
            outgoingTransferProvider: mocks.outgoingTransferProvider
        });
        const res = await h.coordinator.submitRefund(obligation.obligationId, { provider });
        assert.equal(res.outcome, "SUBMISSION_UNKNOWN");
        const after = h.store.get(obligation.obligationId);
        assert.equal(after.state, REFUND_STATE.SUBMISSION_UNKNOWN,
            "even signer failures after reservation require reconciliation");
        await assert.rejects(
            h.coordinator.submitRefund(obligation.obligationId, { provider }),
            /not awaiting submission/,
            "no second sign/broadcast attempt is allowed"
        );
        assert.equal(mocks.calls.sign, 1);
        assert.equal(mocks.calls.broadcast, 0);
    } finally {
        h.cleanup();
    }
}

async function testBroadcastFailureUnknown() {
    const h = harness(1);
    try {
        const [obligation] = prepareObligations(h, 1);
        const mocks = makeMocks({ failBroadcast: true });
        const provider = new TestnetOutgoingRefundProvider({
            globalId: -3,
            signer: mocks.signer,
            broadcaster: mocks.broadcaster,
            finalityEvidenceProvider: mocks.finalityEvidenceProvider,
            outgoingTransferProvider: mocks.outgoingTransferProvider
        });
        const res = await h.coordinator.submitRefund(obligation.obligationId, { provider });
        assert.equal(res.outcome, "SUBMISSION_UNKNOWN");
    } finally {
        h.cleanup();
    }
}

async function testFinalityMissing() {
    const h = harness(1);
    try {
        const [obligation] = prepareObligations(h, 1);
        const mocks = makeMocks({ missingEvidence: true, missingTransfer: true });
        const provider = new TestnetOutgoingRefundProvider({
            globalId: -3,
            signer: mocks.signer,
            broadcaster: mocks.broadcaster,
            finalityEvidenceProvider: mocks.finalityEvidenceProvider,
            outgoingTransferProvider: mocks.outgoingTransferProvider
        });
        await h.coordinator.submitRefund(obligation.obligationId, { provider });
        const res = await h.coordinator.finalizeRefund(obligation.obligationId, { provider });
        assert.equal(res.outcome, "NOT_FINALIZED");
        const after = h.store.get(obligation.obligationId);
        assert.equal(after.state, REFUND_STATE.SUBMITTED);
        assert.ok(!after.finalizedEvidence);
    } finally {
        h.cleanup();
    }
}

async function testRuntimeCapabilitiesAndNoAcceptanceFlip() {
    const h = harness(1);
    try {
        const rootCap = mkdtempSync(join(tmpdir(), "wheelwin-rt-cap-"));
        const configDir = join(rootCap, "config");
        mkdirSync(configDir, { recursive: true });
        const catalogPath = join(configDir, "synthetic-public-wallets.json");
        const wallets = Array.from({ length: 64 }, (_, index) => ({
            roomNumber: index + 1,
            address: `0:${(index + 1).toString(16).padStart(64, "f")}`,
            publicKey: null,
            workchain: 0,
            network: "testnet"
        }));
        const { writeFileSync } = await import("node:fs");
        writeFileSync(catalogPath, `${JSON.stringify(wallets)}\n`, "utf8");
        const dataDirCap = join(rootCap, "payment-data");
        const rt = buildPaymentRuntime({
            dataDir: dataDirCap,
            network: "testnet",
            walletCatalogPath: catalogPath,
            nowProvider: () => NOW
        });
        rt.initialize();
        const caps = rt.getCapabilities();
        assert.equal(caps.outgoingRefundTransfersEnabled, false);
        assert.equal(LIVE_PAYMENT_ACCEPTANCE_ENABLED, false);
        assert.equal(caps.livePaymentAcceptanceEnabled, false);
        rt.shutdown();
        rmSync(rootCap, { recursive: true, force: true });
    } finally {
        h.cleanup();
    }
}

function makeNonFinalEvidence({ accountId, transactionId }) {
    const block = { workchain: 0, shard: "8000000000000000", seqno: 10 };
    const observedAtMs = NOW;
    return {
        networkIdentity: {
            network: "testnet",
            globalId: -3,
            source: "toncenter-masterchain-info",
            observedAtMs
        },
        transactionInclusion: {
            transactionId,
            accountId,
            block
        },
        finality: {
            status: "pending",
            source: "toncenter-streaming-v2",
            transactionId,
            accountId,
            block,
            masterchainSeqno: 11,
            observedAtMs
        }
    };
}

async function testConflictingEvidenceCannotComplete() {
    const h = harness(1);
    try {
        const [obligation] = prepareObligations(h, 1);
        const mocks = makeMocks({});
        const baseProvider = new TestnetOutgoingRefundProvider({
            globalId: -3,
            signer: mocks.signer,
            broadcaster: mocks.broadcaster,
            finalityEvidenceProvider: mocks.finalityEvidenceProvider,
            outgoingTransferProvider: mocks.outgoingTransferProvider
        });
        await h.coordinator.submitRefund(obligation.obligationId, { provider: baseProvider });
        assert.equal(h.store.get(obligation.obligationId).state, REFUND_STATE.SUBMITTED);

        const mutations = [
            {
                label: "recipient mismatch",
                outgoingTransfer: {
                    transactionId: "outgoing-testnet-tx",
                    sourceAddress: TESTNET_ROOM_WALLET,
                    destinationAddress: `0:${"c".repeat(64)}`,
                    amountAtomic: 1_000_000_000
                }
            },
            {
                label: "amount mismatch",
                outgoingTransfer: {
                    transactionId: "outgoing-testnet-tx",
                    sourceAddress: TESTNET_ROOM_WALLET,
                    destinationAddress: TESTNET_PAYER,
                    amountAtomic: 2_000_000_000
                }
            }
        ];
        for (const mutation of mutations) {
            const conflictingTransferProvider = {
                async getOutgoingTransfer() { return mutation.outgoingTransfer; },
                async findOutgoingTransfer() { return null; }
            };
            const conflictingProvider = new TestnetOutgoingRefundProvider({
                globalId: -3,
                signer: mocks.signer,
                broadcaster: mocks.broadcaster,
                finalityEvidenceProvider: mocks.finalityEvidenceProvider,
                outgoingTransferProvider: conflictingTransferProvider
            });
            const res = await h.coordinator.finalizeRefund(obligation.obligationId, { provider: conflictingProvider });
            assert.equal(res.outcome, "NOT_FINALIZED", `${mutation.label}: conflicting evidence is rejected`);
            const after = h.store.get(obligation.obligationId);
            assert.equal(after.state, REFUND_STATE.SUBMITTED, `${mutation.label}: obligation stays SUBMITTED`);
            assert.ok(!after.finalizedEvidence, `${mutation.label}: no finalized evidence is recorded`);
        }
    } finally {
        h.cleanup();
    }
}

async function testNonFinalEvidenceCannotComplete() {
    const h = harness(1);
    try {
        const [obligation] = prepareObligations(h, 1);
        const mocks = makeMocks({});
        const baseProvider = new TestnetOutgoingRefundProvider({
            globalId: -3,
            signer: mocks.signer,
            broadcaster: mocks.broadcaster,
            finalityEvidenceProvider: mocks.finalityEvidenceProvider,
            outgoingTransferProvider: mocks.outgoingTransferProvider
        });
        await h.coordinator.submitRefund(obligation.obligationId, { provider: baseProvider });
        assert.equal(h.store.get(obligation.obligationId).state, REFUND_STATE.SUBMITTED);

        const nonFinalEvidenceProvider = {
            async getSettlementEvidence({ accountId, providerTransactionId }) {
                return makeNonFinalEvidence({ accountId, transactionId: providerTransactionId });
            }
        };
        const nonFinalProvider = new TestnetOutgoingRefundProvider({
            globalId: -3,
            signer: mocks.signer,
            broadcaster: mocks.broadcaster,
            finalityEvidenceProvider: nonFinalEvidenceProvider,
            outgoingTransferProvider: mocks.outgoingTransferProvider
        });
        const res = await h.coordinator.finalizeRefund(obligation.obligationId, { provider: nonFinalProvider });
        assert.equal(res.outcome, "NOT_FINALIZED", "non-final evidence cannot complete");
        const after = h.store.get(obligation.obligationId);
        assert.equal(after.state, REFUND_STATE.SUBMITTED, "non-final evidence leaves SUBMITTED");
        assert.ok(!after.finalizedEvidence, "non-final evidence records nothing");
    } finally {
        h.cleanup();
    }
}

async function testWrongTransactionIdentityCannotComplete() {
    const h = harness(1);
    try {
        const [obligation] = prepareObligations(h, 1);
        const mocks = makeMocks({});
        const baseProvider = new TestnetOutgoingRefundProvider({
            globalId: -3,
            signer: mocks.signer,
            broadcaster: mocks.broadcaster,
            finalityEvidenceProvider: mocks.finalityEvidenceProvider,
            outgoingTransferProvider: mocks.outgoingTransferProvider
        });
        await h.coordinator.submitRefund(obligation.obligationId, { provider: baseProvider });
        assert.equal(h.store.get(obligation.obligationId).state, REFUND_STATE.SUBMITTED);

        const mismatchedEvidenceProvider = {
            async getSettlementEvidence({ accountId, providerTransactionId }) {
                return makeSyntheticFinalityEvidence({ accountId, transactionId: "some-other-tx" });
            }
        };
        const mismatchedProvider = new TestnetOutgoingRefundProvider({
            globalId: -3,
            signer: mocks.signer,
            broadcaster: mocks.broadcaster,
            finalityEvidenceProvider: mismatchedEvidenceProvider,
            outgoingTransferProvider: mocks.outgoingTransferProvider
        });
        const res = await h.coordinator.finalizeRefund(obligation.obligationId, { provider: mismatchedProvider });
        assert.equal(res.outcome, "NOT_FINALIZED", "evidence bound to a different transaction is rejected");
        const after = h.store.get(obligation.obligationId);
        assert.equal(after.state, REFUND_STATE.SUBMITTED, "transaction identity mismatch leaves SUBMITTED");
        assert.ok(!after.finalizedEvidence, "transaction identity mismatch records nothing");
    } finally {
        h.cleanup();
    }
}

async function testReconcileAmbiguousSubmissionToComplete() {
    const h = harness(1);
    try {
        const [obligation] = prepareObligations(h, 1);
        const calls = { sign: 0, broadcast: 0, reconcile: 0 };
        const signer = {
            signTransfer() {
                calls.sign += 1;
                return { type: "signed", payload: "payload" };
            }
        };
        const broadcaster = {
            broadcast() {
                calls.broadcast += 1;
                return { status: "UNKNOWN", reason: "timeout after send" };
            }
        };
        const finalizedEvidence = {
            networkName: "TESTNET",
            globalId: -3,
            transactionId: "observed-outgoing-tx",
            amountAtomic: 1_000_000_000,
            destination: TESTNET_PAYER,
            finalized: true,
            observedAtMs: NOW,
            blockId: "0:8000000000000000:10"
        };
        const finalityEvidenceProvider = {
            async getSettlementEvidence({ accountId, providerTransactionId }) {
                return makeSyntheticFinalityEvidence({ accountId, transactionId: providerTransactionId });
            }
        };
        const outgoingTransferProvider = {
            async getOutgoingTransfer() {
                return {
                    transactionId: "observed-outgoing-tx",
                    sourceAddress: TESTNET_ROOM_WALLET,
                    destinationAddress: TESTNET_PAYER,
                    amountAtomic: 1_000_000_000
                };
            },
            async findOutgoingTransfer() {
                calls.reconcile += 1;
                return { transactionId: "observed-outgoing-tx", ambiguous: false };
            }
        };
        const provider = new TestnetOutgoingRefundProvider({
            globalId: -3,
            signer,
            broadcaster,
            finalityEvidenceProvider,
            outgoingTransferProvider
        });
        assert.equal(provider.canExecute(), true);

        const resSubmit = await h.coordinator.submitRefund(obligation.obligationId, { provider });
        assert.equal(resSubmit.outcome, "SUBMISSION_UNKNOWN", "ambiguous broadcast is not a clean failure");
        assert.equal(h.store.get(obligation.obligationId).state, REFUND_STATE.SUBMISSION_UNKNOWN);

        const signBefore = calls.sign;
        const broadcastBefore = calls.broadcast;
        const resReconcile = await h.coordinator.reconcileAmbiguousSubmission(obligation.obligationId, { provider });
        assert.equal(resReconcile.outcome, "COMPLETE", "reconciliation completes from observed finalized evidence");
        assert.equal(resReconcile.outgoingTransactionId, "observed-outgoing-tx");
        assert.equal(calls.sign, signBefore, "reconciliation does not re-sign");
        assert.equal(calls.broadcast, broadcastBefore, "reconciliation does not re-broadcast");
        assert.equal(calls.reconcile, 1, "reconciliation path was exercised");

        const after = h.store.get(obligation.obligationId);
        assert.equal(after.state, REFUND_STATE.COMPLETE, "reconciled obligation reaches COMPLETE");
        assert.ok(after.finalizedEvidence, "COMPLETE carries validated finalized evidence");
        assert.equal(after.finalizedEvidence.transactionId, "observed-outgoing-tx", "evidence matches the observed transaction");
        assert.equal(after.finalizedEvidence.destination, TESTNET_PAYER, "evidence matches the refund destination");
        assert.equal(after.finalizedEvidence.amountAtomic, 1_000_000_000, "evidence matches the refund amount");
        assert.equal(after.finalizedEvidence.networkName, "TESTNET", "evidence records TESTNET");
        assert.equal(after.finalizedEvidence.globalId, -3, "evidence records global ID -3");
    } finally {
        h.cleanup();
    }
}

async function testReconcileAmbiguousHoldsWithoutMatch() {
    const h = harness(1);
    try {
        const [obligation] = prepareObligations(h, 1);
        const calls = { sign: 0, broadcast: 0, reconcile: 0 };
        const signer = {
            signTransfer() {
                calls.sign += 1;
                return { type: "signed", payload: "payload" };
            }
        };
        const broadcaster = {
            broadcast() {
                calls.broadcast += 1;
                return { status: "UNKNOWN", reason: "timeout after send" };
            }
        };
        const finalityEvidenceProvider = {
            async getSettlementEvidence() { return makeSyntheticFinalityEvidence({ accountId: TESTNET_ROOM_WALLET, transactionId: "observed-outgoing-tx" }); }
        };
        const outgoingTransferProvider = {
            async getOutgoingTransfer() { return null; },
            async findOutgoingTransfer() {
                calls.reconcile += 1;
                return null;
            }
        };
        const provider = new TestnetOutgoingRefundProvider({
            globalId: -3,
            signer,
            broadcaster,
            finalityEvidenceProvider,
            outgoingTransferProvider
        });

        await h.coordinator.submitRefund(obligation.obligationId, { provider });
        assert.equal(h.store.get(obligation.obligationId).state, REFUND_STATE.SUBMISSION_UNKNOWN);
        const signBefore = calls.sign;
        const broadcastBefore = calls.broadcast;

        const resReconcile = await h.coordinator.reconcileAmbiguousSubmission(obligation.obligationId, { provider });
        assert.equal(resReconcile.outcome, "RECONCILIATION_REQUIRED", "no matching outgoing transfer holds for reconciliation");
        assert.equal(calls.sign, signBefore, "no signing during a held reconciliation");
        assert.equal(calls.broadcast, broadcastBefore, "no broadcast during a held reconciliation");
        const after = h.store.get(obligation.obligationId);
        assert.equal(after.state, REFUND_STATE.RECONCILIATION_REQUIRED, "held obligation is RECONCILIATION_REQUIRED");
        assert.ok(!after.finalizedEvidence, "held obligation records no finalized evidence");
        assert.equal(after.outgoingTransactionId, null, "held obligation records no outgoing transaction");
    } finally {
        h.cleanup();
    }
}

async function testRestartPreservesObligationsAndRecoveryWithoutDuplication() {
    const h = harness(1);
    try {
        const [obligation] = prepareObligations(h, 1);
        assert.equal(obligation.state, REFUND_STATE.PENDING);

        // Drive the obligation into an ambiguous, non-terminal state.
        const mocks = makeMocks({ ambiguousBroadcast: true });
        const provider = new TestnetOutgoingRefundProvider({
            globalId: -3,
            signer: mocks.signer,
            broadcaster: mocks.broadcaster,
            finalityEvidenceProvider: mocks.finalityEvidenceProvider,
            outgoingTransferProvider: mocks.outgoingTransferProvider
        });
        const res = await h.coordinator.submitRefund(obligation.obligationId, { provider });
        assert.equal(res.outcome, "SUBMISSION_UNKNOWN");
        assert.equal(h.store.get(obligation.obligationId).state, REFUND_STATE.SUBMISSION_UNKNOWN);

        // Simulated process restart: a fresh store instance over the same durable dataDir.
        const restartStore = new RefundObligationStore({ dataDir: join(h.root, "refunds") });
        restartStore.initialize();
        const restored = restartStore.get(obligation.obligationId);
        assert.ok(restored, "obligation survives a simulated restart");
        assert.equal(restored.obligationId, obligation.obligationId, "obligation identity is stable across restart");
        assert.equal(restored.state, REFUND_STATE.SUBMISSION_UNKNOWN, "non-terminal state survives restart");
        assert.equal(restartStore.size, 1, "restart creates no duplicate obligation");
        assert.equal(restartStore.listPending().length, 1, "restarted store still lists the pending obligation");

        // Recovery reports honest readiness and never submits or completes.
        const restartedCoordinator = new RefundLifecycleCoordinator({
            store: restartStore,
            intentStore: h.intentStore,
            ledgerStore: h.ledgerStore,
            nowProvider: () => NOW
        });
        const identityOnly = new TestnetRefundProvider({ globalId: -3 });
        const report = restartedCoordinator.initialize({
            providers: new Map([["TESTNET", identityOnly]])
        });
        assert.equal(report.length, 1, "recovery reports the surviving obligation");
        assert.equal(report[0].outcome, "PENDING_EXECUTION_DISABLED", "recovery reports disabled, never submits");
        assert.equal(report[0].state, REFUND_STATE.SUBMISSION_UNKNOWN);
        assert.equal(restartStore.listPending().length, 1, "obligation remains recoverable, never fabricated to COMPLETE");

        // A capable provider still does not resubmit or complete during recovery.
        const capableReport = restartedCoordinator.recover({
            providers: new Map([["TESTNET", provider]])
        });
        assert.equal(capableReport[0].outcome, "SUBMISSION_OUTCOME_UNKNOWN_HOLD", "capable recovery provider does not resubmit");
        assert.equal(restartStore.get(obligation.obligationId).state, REFUND_STATE.SUBMISSION_UNKNOWN, "still SUBMISSION_UNKNOWN after capable recovery");
    } finally {
        h.cleanup();
    }
}

async function testDurableUnknownBeforeBroadcastAndConcurrentDuplicateGuard() {
    const h = harness(1);
    let releaseSigner;
    try {
        const [obligation] = prepareObligations(h, 1);
        const mocks = makeMocks({});
        let startedResolve;
        const started = new Promise(resolve => { startedResolve = resolve; });
        const waitForRelease = new Promise(resolve => { releaseSigner = resolve; });
        const signer = {
            async signTransfer(descriptor) {
                // A restarted process must already see UNKNOWN before it
                // could possibly have signed or broadcast anything.
                assert.equal(h.store.get(obligation.obligationId).state,
                    REFUND_STATE.SUBMISSION_UNKNOWN);
                const restarted = new RefundObligationStore({
                    dataDir: join(h.root, "refunds")
                });
                restarted.initialize();
                assert.equal(restarted.get(obligation.obligationId).state,
                    REFUND_STATE.SUBMISSION_UNKNOWN);
                startedResolve();
                await waitForRelease;
                return mocks.signer.signTransfer(descriptor);
            }
        };
        const provider = new TestnetOutgoingRefundProvider({
            globalId: -3,
            signer,
            broadcaster: mocks.broadcaster,
            finalityEvidenceProvider: mocks.finalityEvidenceProvider,
            outgoingTransferProvider: mocks.outgoingTransferProvider
        });
        const first = h.coordinator.submitRefund(obligation.obligationId, { provider });
        await started;
        await assert.rejects(
            h.coordinator.submitRefund(obligation.obligationId, { provider }),
            /not awaiting submission/,
            "concurrent attempt cannot pass the PENDING gate"
        );
        assert.equal(mocks.calls.broadcast, 0);
        releaseSigner();
        assert.equal((await first).outcome, "SUBMITTED");
        assert.equal(mocks.calls.sign, 1);
        assert.equal(mocks.calls.broadcast, 1,
            "only one transfer may be broadcast");
    } finally {
        releaseSigner?.();
        h.cleanup();
    }
}

function syntheticInspectedRefund(signedTransfer, expected) {
    return {
        verified: true, evidenceSource: "decoded-signed-ton-boc",
        bocSha256: signedRefundBocHashOrNull(signedTransfer),
        networkName: expected.networkName, globalId: expected.globalId,
        idempotencyKey: expected.idempotencyKey, from: expected.from,
        messages: [{
            to: expected.to, amountAtomic: expected.amountAtomic,
            sendMode: 3, sendRemainingBalance: false, bounce: true
        }]
    };
}

function makePlannedSigner(mocks, overrides = {}) {
    return {
        ...mocks.signer,
        async signPlannedRefund(descriptor) {
            mocks.calls.sign++;
            assert.equal(descriptor.amountAtomic, "990000000",
                "fee-funded signer receives only the NET amount");
            assert.equal(descriptor.maxFeeAtomic, "10000000");
            return { ...descriptor, boc: makeNativeRefundV4Boc().toString("base64"), ...overrides };
        }
    };
}

async function testNetFeeRefundCompletesOnlyWithDurablePlanAndFinality() {
    const h = harness(1);
    try {
        const [obligation] = prepareObligations(h, 1);
        const planStore = new NativeGramRefundTransferPlanStore({ dataDir: h.root });
        const sourceWalletAddress = TESTNET_ROOM_WALLET;
        const plan = buildNativeGramRefundTransferPlan({
            obligation, sourceWalletAddress,
            feeQuote: {
                networkName: "TESTNET", globalId: -3,
                obligationId: obligation.obligationId,
                sourceWalletAddress,
                destinationAddress: obligation.refundDestination,
                paidAmountAtomic: String(obligation.amountAtomic),
                maxFeeAtomic: "10000000",
                finalized: true, estimateSource: "testnet-network-estimator"
            }
        });
        planStore.reserve(plan);
        const mocks = makeMocks({});
        mocks.outgoingTransferProvider.getOutgoingTransfer = async ({ sourceWalletAddress, transactionId }) => ({
            transactionId, sourceAddress: sourceWalletAddress,
            destinationAddress: TESTNET_PAYER,
            amountAtomic: 990_000_000
        });
        const provider = new TestnetOutgoingRefundProvider({
            globalId: -3,
            signer: makePlannedSigner(mocks), broadcaster: mocks.broadcaster,
            finalityEvidenceProvider: mocks.finalityEvidenceProvider,
            outgoingTransferProvider: mocks.outgoingTransferProvider,
            refundPlanStore: new NativeGramRefundTransferPlanStore({ dataDir: h.root }),
            signedTransferInspector: {
                async inspect({ signedTransfer, expected }) {
                    assert.equal(signedTransfer.amountAtomic, expected.amountAtomic);
                    assert.equal(expected.amountAtomic, "990000000");
                    return syntheticInspectedRefund(signedTransfer, expected); // mocked decoder, not TON BOC decoding
                },
                async verifyWalletV4Signature() { return true; } // synthetic test only
            }
        });
        assert.equal(provider.canExecute(), true, "durable net-fee refund is executable");
        assert.equal((await h.coordinator.submitRefund(obligation.obligationId, { provider })).outcome, "SUBMITTED");
        const result = await h.coordinator.finalizeRefund(obligation.obligationId, { provider });
        assert.equal(result.outcome, "COMPLETE");
        const completed = h.store.get(obligation.obligationId);
        assert.equal(completed.amountAtomic, 1_000_000_000);
        assert.equal(completed.finalizedEvidence.amountAtomic, 990_000_000);
        assert.equal(completed.finalizedEvidence.reservedFeeAtomic, "10000000");
        assert.equal(completed.finalizedEvidence.originalPaidAmountAtomic, "1000000000");
        const reopened = new RefundObligationStore({ dataDir: join(h.root, "refunds") });
        reopened.initialize();
        assert.equal(reopened.get(obligation.obligationId).state, REFUND_STATE.COMPLETE);
        await assert.rejects(
            h.coordinator.finalizeRefund(obligation.obligationId, { provider }),
            /not been submitted/
        );
    } finally {
        h.cleanup();
    }
}

async function testNetFeeRefundRejectsGrossAmountFinality() {
    const h = harness(1);
    try {
        const [obligation] = prepareObligations(h, 1);
        const planStore = new NativeGramRefundTransferPlanStore({ dataDir: h.root });
        planStore.reserve(buildNativeGramRefundTransferPlan({
            obligation, sourceWalletAddress: TESTNET_ROOM_WALLET,
            feeQuote: {
                networkName: "TESTNET", globalId: -3,
                obligationId: obligation.obligationId,
                sourceWalletAddress: TESTNET_ROOM_WALLET,
                destinationAddress: obligation.refundDestination,
                paidAmountAtomic: "1000000000", maxFeeAtomic: "10000000",
                finalized: true, estimateSource: "testnet-network-estimator"
            }
        }));
        const mocks = makeMocks({});
        // Mock returns gross 1 GRAM; the net plan requires 0.99.
        const provider = new TestnetOutgoingRefundProvider({
            globalId: -3, signer: makePlannedSigner(mocks),
            broadcaster: mocks.broadcaster,
            finalityEvidenceProvider: mocks.finalityEvidenceProvider,
            outgoingTransferProvider: mocks.outgoingTransferProvider,
            refundPlanStore: planStore,
            signedTransferInspector: {
                inspect: async ({ signedTransfer, expected }) =>
                    syntheticInspectedRefund(signedTransfer, expected), // mocked decoder
                verifyWalletV4Signature: async () => true // synthetic test only
            }
        });
        await h.coordinator.submitRefund(obligation.obligationId, { provider });
        const result = await h.coordinator.finalizeRefund(obligation.obligationId, { provider });
        assert.equal(result.outcome, "NOT_FINALIZED");
        assert.equal(h.store.get(obligation.obligationId).state, REFUND_STATE.SUBMITTED);
    } finally { h.cleanup(); }
}

async function testConfiguredPlanStoreForbidsGrossFallback() {
    const h = harness(1);
    try {
        const [obligation] = prepareObligations(h, 1);
        const mocks = makeMocks({});
        const provider = new TestnetOutgoingRefundProvider({
            globalId: -3, signer: mocks.signer,
            broadcaster: mocks.broadcaster,
            finalityEvidenceProvider: mocks.finalityEvidenceProvider,
            outgoingTransferProvider: mocks.outgoingTransferProvider,
            refundPlanStore: new NativeGramRefundTransferPlanStore({ dataDir: h.root })
        });
        assert.equal(provider.canExecute(), false,
            "legacy signer cannot execute when a durable plan store is configured");
        const result = await provider.signAndBroadcast({
            obligation, sourceWalletAddress: TESTNET_ROOM_WALLET, nowMs: NOW
        });
        assert.equal(result.outcome, "FAILED");
        assert.equal(mocks.calls.sign, 0);
        assert.equal(mocks.calls.broadcast, 0,
            "missing persisted fee plan cannot fall back to gross signing");
    } finally { h.cleanup(); }
}

async function testMissingPlanNeverFallsBackEvenWithBothSigners() {
    const h = harness(1);
    try {
        const [obligation] = prepareObligations(h, 1);
        const mocks = makeMocks({});
        const provider = new TestnetOutgoingRefundProvider({
            globalId: -3,
            signer: makePlannedSigner(mocks),
            broadcaster: mocks.broadcaster,
            finalityEvidenceProvider: mocks.finalityEvidenceProvider,
            outgoingTransferProvider: mocks.outgoingTransferProvider,
            refundPlanStore: new NativeGramRefundTransferPlanStore({ dataDir: h.root }),
            signedTransferInspector: {
                async inspect() { throw new Error("must not inspect without a plan"); },
                async verifyWalletV4Signature() { throw new Error("must not verify without a plan"); }
            }
        });
        assert.equal(provider.canExecute(), true, "both signer APIs are present");
        const result = await provider.signAndBroadcast({
            obligation, sourceWalletAddress: TESTNET_ROOM_WALLET, nowMs: NOW
        });
        assert.equal(result.outcome, "FAILED");
        assert.equal(mocks.calls.sign, 0, "neither signer may run without a reserved fee plan");
        assert.equal(mocks.calls.broadcast, 0, "missing plan must never reach the network");
    } finally { h.cleanup(); }
}

async function testPlannedSignerWithoutPlanStoreCannotFallBackToLegacyTransfer() {
    const h = harness(1);
    try {
        const [obligation] = prepareObligations(h, 1);
        const mocks = makeMocks({});
        const provider = new TestnetOutgoingRefundProvider({
            globalId: -3,
            signer: makePlannedSigner(mocks),
            broadcaster: mocks.broadcaster,
            finalityEvidenceProvider: mocks.finalityEvidenceProvider,
            outgoingTransferProvider: mocks.outgoingTransferProvider
        });
        assert.equal(provider.canExecute(), false, "planned signer requires durable plan storage");
        const result = await provider.signAndBroadcast({
            obligation, sourceWalletAddress: TESTNET_ROOM_WALLET, nowMs: NOW
        });
        assert.equal(result.outcome, "FAILED");
        assert.equal(mocks.calls.sign, 0, "no signer may run without a persisted fee plan");
        assert.equal(mocks.calls.broadcast, 0, "no network transfer without a plan");
    } finally { h.cleanup(); }
}

async function testPlannedRefundFailsClosedWithoutDedicatedSigner() {
    const h = harness(1);
    try {
        const [obligation] = prepareObligations(h, 1);
        const planStore = new NativeGramRefundTransferPlanStore({ dataDir: h.root });
        planStore.reserve(buildNativeGramRefundTransferPlan({
            obligation, sourceWalletAddress: TESTNET_ROOM_WALLET,
            feeQuote: {
                networkName: "TESTNET", globalId: -3,
                obligationId: obligation.obligationId,
                sourceWalletAddress: TESTNET_ROOM_WALLET,
                destinationAddress: obligation.refundDestination,
                paidAmountAtomic: "1000000000",
                maxFeeAtomic: "10000000", finalized: true,
                estimateSource: "testnet-network-estimator"
            }
        }));
        for (const signerModifier of [
            mocks => mocks.signer,
            mocks => makePlannedSigner(mocks, { amountAtomic: "1000000000" }),
            mocks => makePlannedSigner(mocks, { globalId: -239 }),
            mocks => makePlannedSigner(mocks, { sendRemainingBalance: true }),
            mocks => makePlannedSigner(mocks, { to: TESTNET_ROOM_WALLET }),
            mocks => makePlannedSigner(mocks, { idempotencyKey: "wrong-refund-key" })
        ]) {
            const mocks = makeMocks({});
            const provider = new TestnetOutgoingRefundProvider({
                globalId: -3, signer: signerModifier(mocks),
                broadcaster: mocks.broadcaster,
                finalityEvidenceProvider: mocks.finalityEvidenceProvider,
                outgoingTransferProvider: mocks.outgoingTransferProvider,
                refundPlanStore: planStore
            });
            const result = await provider.signAndBroadcast({
                obligation, sourceWalletAddress: TESTNET_ROOM_WALLET, nowMs: NOW
            });
            assert.equal(result.outcome, "FAILED");
            assert.equal(mocks.calls.broadcast, 0,
                "no gross, wrong-chain or send-all signed transfer reaches broadcast");
        }
    } finally { h.cleanup(); }
}

async function testSignedTransferInspectionIsMandatory() {
    const h = harness(1);
    try {
        const [obligation] = prepareObligations(h, 1);
        const planStore = new NativeGramRefundTransferPlanStore({ dataDir: h.root });
        planStore.reserve(buildNativeGramRefundTransferPlan({
            obligation, sourceWalletAddress: TESTNET_ROOM_WALLET,
            feeQuote: {
                networkName: "TESTNET", globalId: -3,
                obligationId: obligation.obligationId,
                sourceWalletAddress: TESTNET_ROOM_WALLET,
                destinationAddress: obligation.refundDestination,
                paidAmountAtomic: "1000000000", maxFeeAtomic: "10000000",
                finalized: true, estimateSource: "testnet-network-estimator"
            }
        }));
        for (const inspector of [
            null,
            { inspect: async () => ({ verified: false }), verifyWalletV4Signature: async () => true },
            { inspect: async () => { throw new Error("invalid signed BOC"); }, verifyWalletV4Signature: async () => true },
            { inspect: async ({ signedTransfer, expected }) => syntheticInspectedRefund(signedTransfer, expected), verifyWalletV4Signature: async () => false },
            { inspect: async ({ signedTransfer, expected }) => syntheticInspectedRefund(signedTransfer, expected), verifyWalletV4Signature: async () => "true" },
            { inspect: async ({ signedTransfer, expected }) => syntheticInspectedRefund(signedTransfer, expected), verifyWalletV4Signature: async () => null },
            { inspect: async ({ signedTransfer, expected }) => syntheticInspectedRefund(signedTransfer, expected), verifyWalletV4Signature: async () => { throw new Error("signature invalid"); } },
            { inspect: async ({ signedTransfer, expected }) => syntheticInspectedRefund(signedTransfer, expected) }
        ]) {
            const mocks = makeMocks({});
            const provider = new TestnetOutgoingRefundProvider({
                globalId: -3, signer: makePlannedSigner(mocks),
                broadcaster: mocks.broadcaster,
                finalityEvidenceProvider: mocks.finalityEvidenceProvider,
                outgoingTransferProvider: mocks.outgoingTransferProvider,
                refundPlanStore: planStore,
                signedTransferInspector: inspector
            });
            assert.equal(provider.canExecute(), Boolean(inspector?.verifyWalletV4Signature));
            const result = await provider.signAndBroadcast({
                obligation, sourceWalletAddress: TESTNET_ROOM_WALLET, nowMs: NOW
            });
            assert.equal(result.outcome, "FAILED");
            assert.equal(mocks.calls.broadcast, 0, "unverified signed bytes cannot broadcast");
        }
    } finally { h.cleanup(); }
}

async function main() {
    await testValidSubmission();
    await testNetFeeRefundCompletesOnlyWithDurablePlanAndFinality();
    await testNetFeeRefundRejectsGrossAmountFinality();
    await testPlannedRefundFailsClosedWithoutDedicatedSigner();
    await testConfiguredPlanStoreForbidsGrossFallback();
    await testMissingPlanNeverFallsBackEvenWithBothSigners();
    await testPlannedSignerWithoutPlanStoreCannotFallBackToLegacyTransfer();
    await testSignedTransferInspectionIsMandatory();
    await testRejections();
    await testAmbiguousNoBlindResubmit();
    await testSignerUnavailable();
    await testDurableUnknownBeforeBroadcastAndConcurrentDuplicateGuard();
    await testBroadcastFailureUnknown();
    await testFinalityMissing();
    await testConflictingEvidenceCannotComplete();
    await testNonFinalEvidenceCannotComplete();
    await testWrongTransactionIdentityCannotComplete();
    await testReconcileAmbiguousSubmissionToComplete();
    await testReconcileAmbiguousHoldsWithoutMatch();
    await testRestartPreservesObligationsAndRecoveryWithoutDuplication();
    await testRuntimeCapabilitiesAndNoAcceptanceFlip();
    console.log("Refund outgoing execution tests passed (deterministic, mocked)");
}

main().catch((err) => {
    console.error("FAIL:", err.stack || err);
    process.exit(1);
});
