import { createRefundObligationId, REFUND_NETWORK, REFUND_STATE, refundIdempotencyKey } from "./RefundObligation.js";
import { LEDGER_ENTRY_KIND } from "../ledger/LedgerConstants.js";
import { PAYMENT_INTENT_STATE } from "../PaymentIntentStatus.js";
import { deriveTonAddressIdentity } from "../incoming/TonAddressIdentity.js";

export const TON_TESTNET_GLOBAL_ID = -3;

export class RefundLifecycleError extends Error {
    constructor(message, details = {}) { super(message); this.name = "RefundLifecycleError"; this.code = "REFUND_LIFECYCLE_ERROR"; this.details = Object.freeze({ ...details }); }
}

/** Creates obligations only from settled intents that exactly back durable principal entries. */
export class RefundLifecycleCoordinator {
    constructor({ store, intentStore, ledgerStore, nowProvider = Date.now, logger = null, outgoingRefundProvider = null } = {}) {
        if (!store || typeof store.create !== "function" || typeof store.listPending !== "function") throw new RefundLifecycleError("durable refund store is required");
        this._store = store; this._intents = intentStore; this._ledger = ledgerStore; this._now = nowProvider; this._logger = logger;
        this._outgoingProvider = outgoingRefundProvider ?? null;
    }

    initialize({ providers = new Map() } = {}) {
        this._store.initialize();
        return this.recover({ providers });
    }

    prepareClosedRoom({ roomId, roomNumber, closureReason, status }) {
        if (!this._intents || typeof this._intents.listForRoom !== "function"
            || typeof this._intents.findByTransactionId !== "function"
            || !this._ledger || typeof this._ledger.listForRoom !== "function") {
            throw new RefundLifecycleError("authoritative payment and ledger stores are unavailable; refund preparation is blocked");
        }
        if (status !== "DESTROYED") throw new RefundLifecycleError("refund obligations may only be prepared after room destruction");
        if (!Number.isSafeInteger(roomNumber) || roomNumber < 1) throw new RefundLifecycleError("original roomNumber is required");
        const closed = this._store.recordClosedRoom({
            roomId, roomNumber, closureReason: closureReason ?? "unspecified",
            closedAtMs: this._now(), networkName: REFUND_NETWORK.TESTNET,
            globalId: TON_TESTNET_GLOBAL_ID
        }).context;
        const intents = this._intents.listForRoom(roomId);
        const byReference = new Map(intents.map((intent) => [intent.paymentReference, intent]));
        const principal = this._ledger.listForRoom(roomId).filter((entry) => entry.kind === LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL);
        if (principal.length > 3) throw new RefundLifecycleError("room has more than three confirmed principal records; manual reconciliation required", { roomId });
        if (principal.length === 0) return Object.freeze([]);
        if (intents.length !== 3) throw new RefundLifecycleError("refund evidence does not contain the three required payment intents", { roomId, intentCount: intents.length });
        if (principal.length === 3) return Object.freeze([]);
        const results = [];
        for (const entry of principal) {
            const reference = entry.metadata?.paymentReference;
            const intent = byReference.get(reference);
            const transactionId = entry.metadata?.transactionId;
            if (!intent || intent.state !== PAYMENT_INTENT_STATE.SETTLED || !transactionId
                || intent.transactionId !== transactionId || intent.roomId !== roomId
                || intent.playerId !== entry.playerId || intent.amountAtomic !== entry.amountAtomic
                || intent.network !== "testnet" || entry.network !== intent.network
                || entry.asset !== intent.asset || entry.metadata?.intentState !== PAYMENT_INTENT_STATE.SETTLED
                || entry.metadata?.source !== "SETTLED_PAYMENT_INTENT") {
                throw new RefundLifecycleError("confirmed incoming evidence is missing or inconsistent; manual reconciliation required", { roomId, entryId: entry.entryId });
            }
            try { deriveTonAddressIdentity(intent.expectedSender); }
            catch { throw new RefundLifecycleError("verified payer address is invalid; manual reconciliation required", { roomId, paymentIntentId: intent.paymentReference }); }
            const duplicateTransaction = this._intents.findByTransactionId(transactionId);
            if (!duplicateTransaction || duplicateTransaction.paymentReference !== intent.paymentReference) {
                throw new RefundLifecycleError("incoming transaction identity is ambiguous; manual reconciliation required", { roomId, transactionId });
            }
            const networkName = REFUND_NETWORK.TESTNET;
            const idempotencyKey = refundIdempotencyKey({ networkName, paymentIntentId: intent.paymentReference, incomingTransactionId: transactionId });
            const record = {
                schemaVersion: 1,
                obligationId: createRefundObligationId(idempotencyKey),
                idempotencyKey,
                networkName,
                globalId: TON_TESTNET_GLOBAL_ID,
                roomNumber: closed.roomNumber,
                roomId,
                playerId: intent.playerId,
                paymentIntentId: intent.paymentReference,
                incomingTransactionId: transactionId,
                amountAtomic: intent.amountAtomic,
                denomination: intent.asset,
                payerAddress: intent.expectedSender,
                refundDestination: intent.expectedSender,
                closureReason: closed.closureReason,
                createdAtMs: this._now(),
                state: REFUND_STATE.PENDING,
                attempts: [],
                outgoingTransactionId: null,
                finalizedEvidence: null,
                lastError: null
            };
            results.push(this._store.create(record));
        }
        this._logger?.info?.(`Refund obligations prepared | network=TESTNET | roomNumber=${roomNumber} | roomId=${roomId} | count=${results.length}`);
        return Object.freeze(results);
    }

    /** Reconcile a payment that became confirmed after room destruction. */
    prepareLateConfirmedPayments(roomId) {
        const closed = this._store.getClosedRoom(roomId);
        if (!closed) throw new RefundLifecycleError("late payment belongs to no durably closed room; manual reconciliation required", { roomId });
        return this.prepareClosedRoom({
            roomId,
            roomNumber: closed.roomNumber,
            closureReason: closed.closureReason,
            status: "DESTROYED"
        });
    }

    recover({ providers = new Map() } = {}) {
        const pending = this._store.listPending();
        const report = pending.map((obligation) => {
            const provider = providers.get(obligation.networkName);
            if (!provider) return Object.freeze({ obligationId: obligation.obligationId, networkName: obligation.networkName, roomNumber: obligation.roomNumber, state: obligation.state, outcome: "PENDING_PROVIDER_UNAVAILABLE" });
            if (provider.networkName !== obligation.networkName || provider.globalId !== obligation.globalId) {
                return Object.freeze({ obligationId: obligation.obligationId, networkName: obligation.networkName, roomNumber: obligation.roomNumber, state: obligation.state, outcome: "BLOCKED_NETWORK_MISMATCH" });
            }
            // Recovery NEVER submits, resubmits or completes a refund here; it
            // only reports an honest readiness/capability status per state.
            if (provider.canExecute?.() !== true) {
                return Object.freeze({ obligationId: obligation.obligationId, networkName: obligation.networkName, roomNumber: obligation.roomNumber, state: obligation.state, outcome: "PENDING_EXECUTION_DISABLED" });
            }
            switch (obligation.state) {
                case REFUND_STATE.SUBMISSION_UNKNOWN:
                    return Object.freeze({ obligationId: obligation.obligationId, networkName: obligation.networkName, roomNumber: obligation.roomNumber, state: obligation.state, outcome: "SUBMISSION_OUTCOME_UNKNOWN_HOLD" });
                case REFUND_STATE.SUBMITTED:
                    return Object.freeze({ obligationId: obligation.obligationId, networkName: obligation.networkName, roomNumber: obligation.roomNumber, state: obligation.state, outcome: "SUBMITTED_AWAITING_FINALITY" });
                case REFUND_STATE.RECONCILIATION_REQUIRED:
                    return Object.freeze({ obligationId: obligation.obligationId, networkName: obligation.networkName, roomNumber: obligation.roomNumber, state: obligation.state, outcome: "RECONCILIATION_REQUIRED" });
                default:
                    return Object.freeze({ obligationId: obligation.obligationId, networkName: obligation.networkName, roomNumber: obligation.roomNumber, state: obligation.state, outcome: "PENDING_AWAITING_SUBMISSION" });
            }
        });
        for (const item of report) this._logger?.warn?.(`Refund recovery pending | network=${item.networkName} | roomNumber=${item.roomNumber} | obligationId=${item.obligationId} | outcome=${item.outcome}`);
        return Object.freeze(report);
    }

    _resolveOutgoingProvider(provider) {
        const resolved = provider ?? this._outgoingProvider;
        if (!resolved) throw new RefundLifecycleError("no outgoing refund provider is configured");
        if (resolved.canExecute?.() !== true) throw new RefundLifecycleError("outgoing refund provider has no authorized Testnet signer");
        return resolved;
    }

    _assertProviderMatches(provider, obligation) {
        if (provider.networkName !== obligation.networkName || provider.globalId !== obligation.globalId) {
            throw new RefundLifecycleError("outgoing refund provider network does not match the obligation", {
                obligationId: obligation.obligationId,
                providerNetwork: provider.networkName,
                obligationNetwork: obligation.networkName
            });
        }
    }

    _attempt(obligation, state, { startedAtMs, completedAtMs, outgoingTransactionId = null, errorCode = null, attemptId = "" } = {}) {
        return Object.freeze({
            networkName: obligation.networkName,
            globalId: obligation.globalId,
            idempotencyKey: obligation.idempotencyKey,
            attemptId,
            state,
            startedAtMs,
            completedAtMs: completedAtMs ?? null,
            outgoingTransactionId,
            errorCode
        });
    }

    /**
     * Explicitly sign and broadcast ONE authorized refund. Only a PENDING
     * obligation may be submitted; a refund whose prior submission outcome is
     * UNKNOWN is never resubmitted here. No completion happens without later
     * independent finality verification.
     *
     * @returns {Promise<{ obligationId: string, outcome: string, outgoingTransactionId: string|null, reason: string|null }>}
     */
    async submitRefund(obligationId, { provider = null } = {}) {
        const outgoing = this._resolveOutgoingProvider(provider);
        const current = this._store.get(obligationId);
        if (!current) throw new RefundLifecycleError("refund obligation does not exist", { obligationId });
        this._assertProviderMatches(outgoing, current);
        if (current.state !== REFUND_STATE.PENDING) {
            throw new RefundLifecycleError(
                "refund is not awaiting submission; it must be reconciled, not resubmitted",
                { obligationId, state: current.state }
            );
        }
        const startedAtMs = this._now();
        let result;
        try {
            const sourceWalletAddress = outgoing.resolveSourceWallet
                ? outgoing.resolveSourceWallet({ obligation: current, intentStore: this._intents })
                : (() => { throw new RefundLifecycleError("provider cannot resolve the refund source wallet"); })();
            result = await outgoing.signAndBroadcast({ obligation: current, sourceWalletAddress, nowMs: startedAtMs });
        } catch (error) {
            // Authorization/provider failures fail closed: record and stay PENDING.
            const code = typeof error?.code === "string" ? error.code : "OUTGOING_REFUND_ERROR";
            const attempt = this._attempt(current, "FAILED", { startedAtMs, completedAtMs: this._now(), errorCode: code, attemptId: `${current.obligationId}:${startedAtMs}` });
            this._store.recordSubmissionAttempt(current.obligationId, { attempt, lastError: code });
            return Object.freeze({ obligationId: current.obligationId, outcome: "FAILED", outgoingTransactionId: null, reason: code });
        }

        if (result.outcome === "SUBMITTED") {
            const attemptStart = this._attempt(current, "SUBMISSION_UNKNOWN", { startedAtMs, completedAtMs: this._now(), errorCode: null, attemptId: `${current.obligationId}:${startedAtMs}` });
            this._store.markSubmissionUnknown(current.obligationId, { attempt: attemptStart });
            const attemptDone = this._attempt(current, "SUBMITTED", { startedAtMs, completedAtMs: this._now(), outgoingTransactionId: result.outgoingTransactionId, attemptId: `${current.obligationId}:${startedAtMs}` });
            this._store.markSubmitted(current.obligationId, { outgoingTransactionId: result.outgoingTransactionId, attempt: attemptDone });
            this._logger?.info?.(`Refund submitted | obligationId=${current.obligationId} | network=${current.networkName}`);
            return Object.freeze({ obligationId: current.obligationId, outcome: "SUBMITTED", outgoingTransactionId: result.outgoingTransactionId, reason: null });
        }
        if (result.outcome === "UNKNOWN") {
            const attempt = this._attempt(current, "SUBMISSION_UNKNOWN", { startedAtMs, completedAtMs: this._now(), errorCode: result.reason ?? null, attemptId: `${current.obligationId}:${startedAtMs}` });
            this._store.markSubmissionUnknown(current.obligationId, { attempt, lastError: result.reason ?? null });
            this._logger?.warn?.(`Refund submission outcome unknown | obligationId=${current.obligationId} | reason=${result.reason}`);
            return Object.freeze({ obligationId: current.obligationId, outcome: "SUBMISSION_UNKNOWN", outgoingTransactionId: null, reason: result.reason });
        }
        const attempt = this._attempt(current, "FAILED", { startedAtMs, completedAtMs: this._now(), errorCode: result.reason ?? null, attemptId: `${current.obligationId}:${startedAtMs}` });
        this._store.recordSubmissionAttempt(current.obligationId, { attempt, lastError: result.reason ?? null });
        return Object.freeze({ obligationId: current.obligationId, outcome: "FAILED", outgoingTransactionId: null, reason: result.reason });
    }

    /**
     * Independently observe and verify finality of a SUBMITTED refund, then
     * complete it ONLY with validated persisted finalized evidence. When
     * evidence is missing, insufficient or mismatched the obligation stays
     * SUBMITTED — it can never shortcut to COMPLETE.
     */
    async finalizeRefund(obligationId, { provider = null } = {}) {
        const outgoing = this._resolveOutgoingProvider(provider);
        const current = this._store.get(obligationId);
        if (!current) throw new RefundLifecycleError("refund obligation does not exist", { obligationId });
        this._assertProviderMatches(outgoing, current);
        if (current.state !== REFUND_STATE.SUBMITTED) {
            throw new RefundLifecycleError("refund has not been submitted and awaits a submission, not finalization", { obligationId, state: current.state });
        }
        const sourceWalletAddress = outgoing.resolveSourceWallet({ obligation: current, intentStore: this._intents });
        const verification = await outgoing.observeAndVerifyFinality({
            obligation: current, sourceWalletAddress, outgoingTransactionId: current.outgoingTransactionId, nowMs: this._now()
        });
        if (!verification.verified) {
            this._logger?.warn?.(`Refund finality not verified | obligationId=${current.obligationId} | reason=${verification.reason}`);
            return Object.freeze({ obligationId: current.obligationId, outcome: "NOT_FINALIZED", reason: verification.reason });
        }
        const attempt = this._attempt(current, "COMPLETE", { startedAtMs: this._now(), completedAtMs: this._now(), outgoingTransactionId: current.outgoingTransactionId, attemptId: `${current.obligationId}:complete` });
        const completed = this._store.markComplete(current.obligationId, { finalizedEvidence: verification.finalizedEvidence, attempt });
        this._logger?.info?.(`Refund completed from validated finalized evidence | obligationId=${current.obligationId} | network=${current.networkName}`);
        return Object.freeze({ obligationId: current.obligationId, outcome: "COMPLETE", outgoingTransactionId: completed.outgoingTransactionId, reason: null });
    }

    /**
     * Resolve an AMBIGUOUS submission (outcome UNKNOWN) by independently
     * observing the source wallet — never by resubmitting. If the matching
     * finalized outgoing transfer is found the obligation is completed;
     * otherwise it is held for manual reconciliation.
     */
    async reconcileAmbiguousSubmission(obligationId, { provider = null } = {}) {
        const outgoing = this._resolveOutgoingProvider(provider);
        const current = this._store.get(obligationId);
        if (!current) throw new RefundLifecycleError("refund obligation does not exist", { obligationId });
        this._assertProviderMatches(outgoing, current);
        if (current.state !== REFUND_STATE.SUBMISSION_UNKNOWN) {
            throw new RefundLifecycleError("only an ambiguous submission may be reconciled", { obligationId, state: current.state });
        }
        const sourceWalletAddress = outgoing.resolveSourceWallet({ obligation: current, intentStore: this._intents });
        const verification = await outgoing.reconcileAmbiguousSubmission({ obligation: current, sourceWalletAddress, nowMs: this._now() });
        if (verification.verified) {
            const attempt = this._attempt(current, "SUBMITTED", { startedAtMs: this._now(), completedAtMs: this._now(), outgoingTransactionId: verification.finalizedEvidence.transactionId, attemptId: `${current.obligationId}:reconcile` });
            this._store.markSubmitted(current.obligationId, { outgoingTransactionId: verification.finalizedEvidence.transactionId, attempt });
            const completed = this._store.markComplete(current.obligationId, { finalizedEvidence: verification.finalizedEvidence });
            this._logger?.info?.(`Ambiguous refund resolved and completed from observed finalized evidence | obligationId=${current.obligationId}`);
            return Object.freeze({ obligationId: current.obligationId, outcome: "COMPLETE", outgoingTransactionId: completed.outgoingTransactionId, reason: null });
        }
        const attempt = this._attempt(current, "RECONCILIATION_REQUIRED", { startedAtMs: this._now(), completedAtMs: this._now(), errorCode: verification.reason, attemptId: `${current.obligationId}:reconcile` });
        this._store.markReconciliationRequired(current.obligationId, { attempt, lastError: verification.reason });
        this._logger?.warn?.(`Ambiguous refund could not be resolved; held for reconciliation | obligationId=${current.obligationId} | reason=${verification.reason}`);
        return Object.freeze({ obligationId: current.obligationId, outcome: "RECONCILIATION_REQUIRED", reason: verification.reason });
    }
}

/** Testnet identity-only adapter; deliberately has no transfer capability. */
export class TestnetRefundProvider {
    constructor({ globalId } = {}) {
        this.networkName = REFUND_NETWORK.TESTNET;
        this.globalId = globalId;
        if (globalId !== TON_TESTNET_GLOBAL_ID) throw new RefundLifecycleError("Testnet provider requires verified TON global ID -3");
    }
    async verifyNetwork() { return Object.freeze({ networkName: this.networkName, globalId: this.globalId }); }
    async submitRefund() { throw new RefundLifecycleError("outgoing refund execution is disabled: no authorized Testnet transfer provider exists"); }
}
