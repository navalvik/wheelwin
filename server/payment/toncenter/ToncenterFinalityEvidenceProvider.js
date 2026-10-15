/**
 * Read-only, Testnet-only TON Center Streaming API v2 finality evidence.
 *
 * A session is opened before the v3 transaction snapshot. SSE is never
 * reconnected: stream termination, malformed data, or a protocol gap makes
 * that session unusable. Streaming API v2 does not replay historical events.
 */
import { PaymentConfigurationError, PaymentValidationError } from "../PaymentErrors.js";
import { TonPaymentSettlementEvidenceProvider, TON_TESTNET_GLOBAL_ID } from "../incoming/TonPaymentSettlementEvidence.js";
import { tonAddressIdentitiesEqual } from "../incoming/TonAddressIdentity.js";
import { TONCENTER_TESTNET_BASE_URL } from "./ToncenterConstants.js";
import { ToncenterTransactionsClient } from "./ToncenterTransactionsClient.js";

const sessionStates = new WeakMap();

function blockOf(value) {
    const block = value?.block_ref;
    if (!block || !Number.isSafeInteger(block.workchain)
        || typeof block.shard !== "string" || block.shard.trim() === ""
        || !Number.isSafeInteger(block.seqno) || block.seqno < 0) return null;
    return Object.freeze({ workchain: block.workchain, shard: block.shard, seqno: block.seqno });
}

function sameBlock(left, right) {
    return left.workchain === right.workchain
        && left.shard === right.shard && left.seqno === right.seqno;
}

/** Yield parsed SSE data payloads; comments and non-data fields are ignored. */
async function* readSseData(reader) {
    const decoder = new TextDecoder();
    let buffered = "";
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffered.search(/\r?\n\r?\n/)) !== -1) {
            const frame = buffered.slice(0, boundary);
            const separator = buffered.slice(boundary).match(/^\r?\n\r?\n/)[0];
            buffered = buffered.slice(boundary + separator.length);
            const data = frame.split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).replace(/^ /, ""));
            if (data.length) yield data.join("\n");
            else if (frame.split(/\r?\n/).some((line) => line.startsWith(":"))) yield null;
        }
    }
    buffered += decoder.decode();
    if (buffered.trim() !== "") {
        const data = buffered.split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""));
        if (data.length) yield data.join("\n");
        else if (buffered.split(/\r?\n/).some((line) => line.startsWith(":"))) yield null;
    }
}

export class ToncenterFinalityEvidenceProvider extends TonPaymentSettlementEvidenceProvider {
    constructor({ client, nowProvider = Date.now, evidenceWaitMs = 10_000, streamSilenceTimeoutMs = 45_000 } = {}) {
        super();
        if (!(client instanceof ToncenterTransactionsClient)) {
            throw new PaymentConfigurationError("client must be a ToncenterTransactionsClient instance");
        }
        let base;
        try { base = new URL(client.baseUrl); } catch {}
        if (!base || base.origin !== TONCENTER_TESTNET_BASE_URL || base.pathname !== "/") {
            throw new PaymentConfigurationError("finality provider is restricted to the TON Center Testnet endpoint");
        }
        if (typeof nowProvider !== "function") throw new PaymentConfigurationError("nowProvider must be a function");
        if (!Number.isSafeInteger(evidenceWaitMs) || evidenceWaitMs < 1) {
            throw new PaymentConfigurationError("evidenceWaitMs must be a positive integer");
        }
        if (!Number.isSafeInteger(streamSilenceTimeoutMs) || streamSilenceTimeoutMs < 1) {
            throw new PaymentConfigurationError("streamSilenceTimeoutMs must be a positive integer");
        }
        this._client = client;
        this._now = nowProvider;
        this._evidenceWaitMs = evidenceWaitMs;
        this._streamSilenceTimeoutMs = streamSilenceTimeoutMs;
    }

    /** Validate identity and establish the SSE subscription before observation begins. */
    async beginObservation({ accountId }) {
        if (typeof accountId !== "string" || accountId.trim() === "") {
            throw new PaymentValidationError("accountId must be a non-empty string");
        }
        const masterchain = await this._client.getMasterchainInfo();
        if (!Number.isSafeInteger(masterchain?.last?.global_id)
            || masterchain.last.global_id !== TON_TESTNET_GLOBAL_ID
            || !Number.isSafeInteger(masterchain?.last?.seqno)
            || masterchain.last.seqno < 0) {
            throw new PaymentValidationError("TON Center masterchain identity is not verified as Testnet");
        }

        const controller = new AbortController();
        const response = await this._client.openFinalizedTransactionsStream({
            account: accountId.trim(), signal: controller.signal
        });
        const reader = response.body.getReader();
        const messages = readSseData(reader)[Symbol.asyncIterator]();
        let subscribed = false;
        try {
            while (!subscribed) {
                let timer;
                const next = await Promise.race([
                    messages.next(),
                    new Promise((resolve) => {
                        timer = setTimeout(() => resolve({ timeout: true }), this._streamSilenceTimeoutMs);
                    })
                ]);
                clearTimeout(timer);
                if (next?.timeout) throw new PaymentValidationError("SSE subscription acknowledgement timed out");
                if (next.done) break;
                let payload;
                try { payload = JSON.parse(next.value); } catch { continue; }
                if (payload?.status === "subscribed") subscribed = true;
                else throw new PaymentValidationError("SSE stream emitted data before subscription acknowledgement");
            }
        } catch (error) {
            controller.abort();
            try { await reader.cancel(); } catch {}
            throw error;
        }
        if (!subscribed) {
            controller.abort();
            throw new PaymentValidationError("SSE stream ended before subscription acknowledgement");
        }

        const session = Object.freeze({});
        const state = {
            accountId: accountId.trim(),
            globalId: masterchain.last.global_id,
            identityObservedAtMs: this._now(),
            controller,
            reader,
            messages,
            streamSilenceTimeoutMs: this._streamSilenceTimeoutMs,
            valid: true,
            closed: false,
            evidence: new Map(),
            waiters: new Map(),
            pump: null
        };
        sessionStates.set(session, state);
        state.pump = this._pump(state);
        return session;
    }

    async _pump(state) {
        try {
            while (state.valid && !state.closed) {
                let timer;
                const timeout = new Promise((resolve) => {
                    timer = setTimeout(() => resolve({ timeout: true }), state.streamSilenceTimeoutMs);
                });
                const next = await Promise.race([state.messages.next(), timeout]);
                clearTimeout(timer);
                if (next?.timeout) { this._invalidate(state); return; }
                if (next.done) break;
                if (next.value === null) continue;
                let event;
                try { event = JSON.parse(next.value); } catch {
                    this._invalidate(state); return;
                }
                if (!event || typeof event !== "object" || Array.isArray(event)) {
                    this._invalidate(state); return;
                }
                // Ignore documented non-transaction event groups. This
                // subscription requested only transactions, so their presence
                // signals a protocol mismatch and invalidates the window.
                if (event.type !== "transactions" || event.finality !== "finalized"
                    || !Array.isArray(event.transactions)) {
                    this._invalidate(state); return;
                }
                for (const transaction of event.transactions) {
                    if (!transaction || typeof transaction !== "object") {
                        this._invalidate(state); return;
                    }
                    let accountMatches = false;
                    try { accountMatches = tonAddressIdentitiesEqual(state.accountId, transaction.account); } catch {}
                    if (!accountMatches) continue;
                    if (typeof transaction.hash !== "string" || transaction.hash.trim() === "") {
                        this._invalidate(state); return;
                    }
                    const block = blockOf(transaction);
                    if (!block || !Number.isSafeInteger(transaction.mc_block_seqno)
                        || transaction.mc_block_seqno < 0) {
                        this._invalidate(state); return;
                    }
                    const txId = transaction.hash;
                    const prior = state.evidence.get(txId);
                    if (prior && !sameBlock(prior.block, block)) {
                        this._invalidate(state); return;
                    }
                    const evidence = Object.freeze({
                        networkIdentity: Object.freeze({
                            network: "testnet", globalId: state.globalId,
                            source: "toncenter-masterchain-info",
                            observedAtMs: state.identityObservedAtMs
                        }),
                        transactionInclusion: Object.freeze({
                            transactionId: txId, accountId: state.accountId, block
                        }),
                        finality: Object.freeze({
                            status: "finalized", source: "toncenter-streaming-v2",
                            transactionId: txId, accountId: state.accountId, block,
                            masterchainSeqno: transaction.mc_block_seqno,
                            observedAtMs: this._now()
                        })
                    });
                    state.evidence.set(txId, evidence);
                    const waiters = state.waiters.get(txId) ?? [];
                    state.waiters.delete(txId);
                    for (const waiter of waiters) waiter.resolve(evidence);
                }
            }
        } catch {
            if (!state.closed) this._invalidate(state);
            return;
        }
        if (!state.closed) this._invalidate(state);
    }

    _invalidate(state) {
        state.valid = false;
        if (!state.closed) {
            state.controller.abort();
            state.reader.cancel().catch(() => {});
        }
        for (const list of state.waiters.values()) {
            for (const waiter of list) waiter.resolve(null);
        }
        state.waiters.clear();
    }

    /** Return evidence only from this session's post-ack finalized event. */
    async getSettlementEvidence({ accountId, providerTransactionId, observationSession } = {}) {
        const state = sessionStates.get(observationSession);
        if (!state || !state.valid || state.closed
            || typeof accountId !== "string"
            || !tonAddressIdentitiesEqual(state.accountId, accountId)
            || typeof providerTransactionId !== "string") return null;
        if (state.evidence.has(providerTransactionId)) return state.evidence.get(providerTransactionId);
        return new Promise((resolve) => {
            const waiter = { resolve };
            const current = state.waiters.get(providerTransactionId) ?? [];
            current.push(waiter);
            state.waiters.set(providerTransactionId, current);
            const timer = setTimeout(() => {
                const list = state.waiters.get(providerTransactionId) ?? [];
                state.waiters.set(providerTransactionId, list.filter((item) => item !== waiter));
                resolve(null);
            }, this._evidenceWaitMs);
            const finish = waiter.resolve;
            waiter.resolve = (value) => { clearTimeout(timer); finish(value); };
        });
    }

    /** Used by the coordinator's private evidence gate after the observation returns. */
    isObservationValid(session) {
        const state = sessionStates.get(session);
        return state?.valid === true;
    }

    async endObservation(session) {
        const state = sessionStates.get(session);
        if (!state || state.closed) return;
        state.closed = true;
        state.controller.abort();
        for (const list of state.waiters.values()) {
            for (const waiter of list) waiter.resolve(null);
        }
        state.waiters.clear();
        try { await state.reader.cancel(); } catch {}
        await state.pump;
    }
}
