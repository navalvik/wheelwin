import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { durableWriteJson } from "../../payment/DurableJson.js";
import { createRefundObligationId, refundIdempotencyKey } from "../../payment/refund/RefundObligation.js";
import { MAINNET_GLOBAL_ID } from "../config/MainnetRuntimeConfig.js";
import { mainnetAddressIdentity } from "./MainnetAddress.js";
import { calculateMainnetPayout } from "./MainnetPayoutPolicy.js";

const EMPTY = Object.freeze({ schemaVersion: 1, network: "mainnet", globalId: MAINNET_GLOBAL_ID,
    outcomes: [], refunds: [], payouts: [], page5StartedRooms: [], historyCoverage: [] });
const REFUND_STATES = new Set(["PENDING", "SUBMISSION_UNKNOWN", "SUBMITTED", "COMPLETE"]);
const PAYOUT_STATES = new Set(["PENDING", "SUBMISSION_UNKNOWN", "SUBMITTED", "CONFIRMED", "UNPAID_INSUFFICIENT_GAS"]);
const clone = (value) => JSON.parse(JSON.stringify(value));

export class MainnetFinancialLedger {
    constructor({ config, nowProvider = Date.now } = {}) {
        if (config?.network !== "mainnet" || config?.globalId !== MAINNET_GLOBAL_ID
            || typeof config?.dataDir !== "string" || !config.dataDir || typeof nowProvider !== "function") {
            throw new Error("MAINNET_FINANCIAL_LEDGER_CONFIG_INVALID");
        }
        this.network = "mainnet";
        this.globalId = MAINNET_GLOBAL_ID;
        this._file = join(config.dataDir, "financial-lifecycle", "state.json");
        this._now = nowProvider;
        this._state = clone(EMPTY);
        this._initialized = false;
    }

    initialize() {
        if (this._initialized) return this;
        mkdirSync(join(this._file, ".."), { recursive: true });
        if (existsSync(this._file)) {
            try {
                this._state = JSON.parse(readFileSync(this._file, "utf8"));
                this._state.historyCoverage ??= [];
            }
            catch { throw new Error("MAINNET_FINANCIAL_LEDGER_CORRUPT"); }
        }
        this._validate(this._state);
        this._initialized = true;
        if (!existsSync(this._file)) this._persist(this._state, true);
        return this;
    }

    recordClosedRoom({ roomId, roomNumber, closureReason, prePage5 = true } = {}) {
        this._assertReady();
        if (typeof roomId !== "string" || !roomId.trim() || !Number.isSafeInteger(roomNumber)
            || roomNumber < 1 || typeof closureReason !== "string" || !closureReason.trim()
            || prePage5 !== true) throw new Error("MAINNET_CLOSED_ROOM_IDENTITY_INVALID");
        const previous = this._state.outcomes.find((entry) => entry.roomId === roomId);
        if (previous?.kind === "PAYOUT") throw new Error("MAINNET_ROOM_ALREADY_HAS_PAYOUT_OUTCOME");
        if (previous) {
            if (previous.kind !== "REFUND" || previous.roomNumber !== roomNumber
                || previous.closureReason !== closureReason.trim()) {
                throw new Error("MAINNET_CLOSED_ROOM_CONTEXT_CONFLICT");
            }
            return Object.freeze({ ...previous, replay: true });
        }
        const record = { roomId: roomId.trim(), roomNumber, closureReason: closureReason.trim(),
            kind: "REFUND", closedAtMs: this._now() };
        this._commit({ ...this._state, outcomes: [...this._state.outcomes, record] });
        return Object.freeze({ ...record, replay: false });
    }

    getOutcome(roomId) {
        this._assertReady();
        const outcome = this._state.outcomes.find(entry => entry.roomId === roomId);
        return outcome ? Object.freeze({ ...outcome }) : null;
    }

    listClosedRooms() {
        this._assertReady();
        return Object.freeze(this._state.outcomes.filter(entry => entry.kind === "REFUND")
            .map(entry => Object.freeze({ ...entry })));
    }

    /** Replace the latest read-only archive-history check for one closed room. */
    recordHistoryCoverage(record) {
        this._assertReady();
        if (!record || typeof record.roomId !== "string" || !record.roomId
            || record.source !== "FINAL_FORENSIC_HISTORY_COVERAGE"
            || !Number.isSafeInteger(record.completedAt) || record.completedAt <= 0
            || typeof record.resultWindowComplete !== "boolean"
            || !(record.providerError === null || typeof record.providerError === "string")
            || !Number.isSafeInteger(record.candidateCount) || record.candidateCount < 0
            || !Number.isSafeInteger(record.checkedCount) || record.checkedCount < 0
            || !Number.isSafeInteger(record.pendingCount) || record.pendingCount < 0
            || record.candidateCursor !== undefined
                && (!Number.isSafeInteger(record.candidateCursor) || record.candidateCursor < 0)
            || !Array.isArray(record.verifiedTransactionIds)
            || record.verifiedTransactionIds.some(id => typeof id !== "string" || !id)
            || new Set(record.verifiedTransactionIds).size !== record.verifiedTransactionIds.length) {
            throw new Error("MAINNET_HISTORY_COVERAGE_RECORD_INVALID");
        }
        const historyCoverage = [
            ...(this._state.historyCoverage ?? []).filter(item => item.roomId !== record.roomId),
            { ...record, verifiedTransactionIds: [...record.verifiedTransactionIds] }
        ];
        this._commit({ ...this._state, historyCoverage });
        return Object.freeze({ ...record, verifiedTransactionIds: Object.freeze([...record.verifiedTransactionIds]) });
    }

    getHistoryCoverage(roomId) {
        this._assertReady();
        const record = (this._state.historyCoverage ?? []).find(item => item.roomId === roomId);
        return record ? Object.freeze({ ...record,
            verifiedTransactionIds: Object.freeze([...(record.verifiedTransactionIds ?? [])]) }) : null;
    }

    hasPayoutOutcome(roomId) {
        return this.getOutcome(roomId)?.kind === "PAYOUT";
    }

    prepareRefunds({ roomId, roomNumber, closureReason, incomingLedger, prePage5 = true } = {}) {
        this._assertReady();
        if (!incomingLedger || incomingLedger.network !== "mainnet" || incomingLedger.globalId !== MAINNET_GLOBAL_ID
            || typeof incomingLedger.listReceipts !== "function"
            || typeof incomingLedger.listRoomIntents !== "function"
            || typeof incomingLedger.listObservations !== "function") {
            throw new Error("MAINNET_REFUND_SOURCE_LEDGER_INVALID");
        }
        this.recordClosedRoom({ roomId, roomNumber, closureReason, prePage5 });
        const roomReceipts = incomingLedger.listReceipts(roomId);
        const confirmedReceipts = roomReceipts.filter((item) => item.status === "CONFIRMED");
        if (confirmedReceipts.length > 3) {
            throw new Error("MAINNET_REFUND_TOO_MANY_CONFIRMED_PAYMENTS");
        }
        const refundReceipts = roomReceipts.filter((item) => item.status === "CONFIRMED"
            || item.status === "EXTRA_PAYMENT");
        if (refundReceipts.length === 0) return Object.freeze([]);
        const intents = incomingLedger.listRoomIntents(roomId);
        if (intents.length !== 3) throw new Error("MAINNET_REFUND_THREE_INTENTS_REQUIRED");
        const observations = incomingLedger.listObservations(roomId);
        const made = [];
        for (const receipt of refundReceipts) {
            const intent = intents.find((item) => item.paymentReference === receipt.paymentReference);
            const observation = observations.find(item => item.transactionId === receipt.transactionId);
            const duplicateTransactionBinding = intents.some(item => item.confirmedTransactionId === receipt.transactionId
                && item.paymentReference !== receipt.paymentReference);
            const principalPayment = receipt.status === "CONFIRMED"
                && intent?.confirmedTransactionId === receipt.transactionId;
            const additionalConfirmedPayment = receipt.status === "EXTRA_PAYMENT"
                && receipt.reason === "PAYMENT_ALREADY_SETTLED"
                && intent?.state === "SETTLED"
                && intent.confirmedTransactionId !== receipt.transactionId;
            if (!intent || !observation || duplicateTransactionBinding
                || receipt.network !== "mainnet" || receipt.globalId !== MAINNET_GLOBAL_ID
                || receipt.roomId !== roomId || receipt.asset !== "TON"
                || intent.network !== "mainnet" || intent.globalId !== MAINNET_GLOBAL_ID
                || intent.roomId !== roomId || intent.state !== "SETTLED"
                || (!principalPayment && !additionalConfirmedPayment)
                || intent.playerId !== receipt.playerId || intent.amountAtomic !== receipt.amountAtomic
                || intent.asset !== receipt.asset
                || observation.network !== "mainnet" || observation.globalId !== MAINNET_GLOBAL_ID
                || observation.roomId !== roomId || observation.asset !== "TON"
                || observation.transactionTime !== receipt.transactionTime
                || observation.amountAtomic !== receipt.amountAtomic
                || (receipt.status === "CONFIRMED" && receipt.reason !== null)
                || !mainnetAddressIdentity(intent.expectedSender)
                || !mainnetAddressIdentity(intent.destinationWalletAddress)
                || mainnetAddressIdentity(receipt.sourceAddress) !== mainnetAddressIdentity(intent.expectedSender)
                || mainnetAddressIdentity(receipt.destinationAddress) !== mainnetAddressIdentity(intent.destinationWalletAddress)
                || mainnetAddressIdentity(observation.sourceAddress) !== mainnetAddressIdentity(receipt.sourceAddress)
                || mainnetAddressIdentity(observation.destinationAddress) !== mainnetAddressIdentity(receipt.destinationAddress)) {
                throw new Error("MAINNET_REFUND_PAYMENT_EVIDENCE_CONFLICT");
            }
            const idempotencyKey = refundIdempotencyKey({ networkName: "MAINNET",
                paymentIntentId: intent.paymentReference, incomingTransactionId: receipt.transactionId });
            const id = createRefundObligationId(idempotencyKey);
            const prior = this._state.refunds.find((item) => item.obligationId === id);
            if (prior) {
                if (prior.idempotencyKey !== idempotencyKey || prior.roomId !== roomId
                    || prior.roomNumber !== roomNumber || prior.playerId !== intent.playerId
                    || prior.paymentIntentId !== intent.paymentReference
                    || prior.incomingTransactionId !== receipt.transactionId
                    || prior.network !== "mainnet" || prior.globalId !== MAINNET_GLOBAL_ID
                    || prior.amountAtomic !== Number(BigInt(intent.amountAtomic))
                    || prior.denomination !== intent.asset
                    || prior.payerAddress !== intent.expectedSender
                    || prior.refundDestination !== intent.expectedSender
                    || prior.sourceWalletAddress !== intent.destinationWalletAddress
                    || prior.closureReason !== closureReason) {
                    throw new Error("MAINNET_REFUND_OBLIGATION_IDENTITY_CONFLICT");
                }
                made.push(Object.freeze({ ...prior, replay: true }));
                continue;
            }
            const amountAtomic = Number(BigInt(intent.amountAtomic));
            if (!Number.isSafeInteger(amountAtomic) || amountAtomic <= 0) throw new Error("MAINNET_REFUND_AMOUNT_OVERFLOW");
            const obligation = { obligationId: id, idempotencyKey,
                network: "mainnet", globalId: MAINNET_GLOBAL_ID, roomId, roomNumber, playerId: intent.playerId,
                paymentIntentId: intent.paymentReference, incomingTransactionId: receipt.transactionId,
                amountAtomic: Number(BigInt(receipt.amountAtomic)), denomination: "TON",
                payerAddress: intent.expectedSender, refundDestination: intent.expectedSender,
                sourceWalletAddress: intent.destinationWalletAddress,
                closureReason, createdAtMs: this._now(), state: "PENDING", transferAmountAtomic: null,
                gasChargeAtomic: null, outgoingTransactionId: null, finalizedEvidence: null };
            this._validateRefund(obligation);
            made.push(Object.freeze({ ...obligation, replay: false }));
            this._commit({ ...this._state, refunds: [...this._state.refunds, obligation] });
        }
        return Object.freeze(made);
    }

    getRefund(id) {
        this._assertReady();
        const item = this._state.refunds.find((entry) => entry.obligationId === id);
        return item ? Object.freeze({ ...item, finalizedEvidence: item.finalizedEvidence && Object.freeze({ ...item.finalizedEvidence }) }) : null;
    }
    listRefunds(roomId = null) { this._assertReady(); return Object.freeze(this._state.refunds.filter(x => roomId === null || x.roomId === roomId).map(x => Object.freeze({ ...x }))); }
    listPendingRefunds() { return this.listRefunds().filter(x => x.state !== "COMPLETE"); }

    updateRefund(id, patch) {
        this._assertReady();
        const current = this.getRefund(id);
        if (!current) throw new Error("MAINNET_REFUND_NOT_FOUND");
        const next = { ...current, ...patch };
        for (const field of ["obligationId", "idempotencyKey", "network", "globalId", "roomId", "roomNumber",
            "playerId", "paymentIntentId", "incomingTransactionId", "amountAtomic", "payerAddress",
            "refundDestination", "sourceWalletAddress", "createdAtMs"]) {
            if (next[field] !== current[field]) throw new Error("MAINNET_REFUND_IDENTITY_IMMUTABLE");
        }
        if (!REFUND_STATES.has(next.state)) throw new Error("MAINNET_REFUND_STATE_INVALID");
        const refundTransitions = {
            PENDING: ["SUBMISSION_UNKNOWN"],
            SUBMISSION_UNKNOWN: ["SUBMITTED", "COMPLETE"],
            SUBMITTED: ["COMPLETE"],
            COMPLETE: []
        };
        if (next.state !== current.state && !refundTransitions[current.state]?.includes(next.state)) {
            throw new Error("MAINNET_REFUND_STATE_TRANSITION_INVALID");
        }
        if (current.transferAmountAtomic !== null && (next.transferAmountAtomic !== current.transferAmountAtomic
            || next.gasChargeAtomic !== current.gasChargeAtomic)) throw new Error("MAINNET_REFUND_PLAN_IMMUTABLE");
        if (next.state === "COMPLETE" && (!next.finalizedEvidence
            || next.finalizedEvidence.network !== "mainnet" || next.finalizedEvidence.globalId !== MAINNET_GLOBAL_ID
            || next.finalizedEvidence.transactionId !== next.outgoingTransactionId
            || next.finalizedEvidence.amountAtomic !== next.transferAmountAtomic
            || next.finalizedEvidence.destination !== next.refundDestination
            || next.finalizedEvidence.finalized !== true)) throw new Error("MAINNET_REFUND_FINALITY_EVIDENCE_INVALID");
        this._validateRefund(next);
        const refunds = this._state.refunds.map(x => x.obligationId === id ? next : x);
        this._commit({ ...this._state, refunds });
        return Object.freeze({ ...next });
    }

    createPayout({ payoutId, roomId, roomNumber, sourceWalletAddress, principalAtomic, winner, owner } = {}) {
        this._assertReady();
        if (typeof payoutId !== "string" || !/^payout_[A-Za-z0-9_-]{1,64}$/.test(payoutId)
            || typeof roomId !== "string" || !roomId || !Number.isSafeInteger(roomNumber) || roomNumber < 1
            || typeof sourceWalletAddress !== "string"
            || !winner?.recipientId || !owner?.recipientId || !winner?.address || !owner?.address) {
            throw new Error("MAINNET_PAYOUT_INPUT_INVALID");
        }
        const outcome = this._state.outcomes.find(x => x.roomId === roomId);
        if (outcome?.kind === "REFUND") throw new Error("MAINNET_ROOM_ALREADY_HAS_REFUND_OUTCOME");
        const duplicate = this._state.payouts.find(x => x.payoutId === payoutId);
        if (duplicate) {
            if (duplicate.roomId !== roomId || duplicate.principalAtomic !== principalAtomic
                || duplicate.roomNumber !== roomNumber || duplicate.sourceWalletAddress !== sourceWalletAddress
                || duplicate.winner.address !== winner.address || duplicate.owner.address !== owner.address
                || duplicate.winner.recipientId !== winner.recipientId || duplicate.owner.recipientId !== owner.recipientId) {
                throw new Error("MAINNET_PAYOUT_IDENTITY_CONFLICT");
            }
            return Object.freeze({ ...duplicate, replay: true });
        }
        if (this._state.payouts.some(x => x.roomId === roomId)) throw new Error("MAINNET_ROOM_PAYOUT_ALREADY_PLANNED");
        const allocation = calculateMainnetPayout(principalAtomic);
        mainnetAddressIdentity(sourceWalletAddress);
        const payout = { payoutId, roomId, roomNumber, sourceWalletAddress, principalAtomic, allocation,
            winner: { recipientId: winner.recipientId, address: winner.address, amountAtomic: allocation.winnerAtomic, state: "PENDING", transactionId: null },
            owner: { recipientId: owner.recipientId, address: owner.address, amountAtomic: allocation.ownerAtomic, state: "PENDING", transactionId: null },
            state: "PENDING", createdAtMs: this._now() };
        mainnetAddressIdentity(winner.address); mainnetAddressIdentity(owner.address);
        this._validatePayout(payout);
        this._commit({ ...this._state, outcomes: [...this._state.outcomes, { roomId, roomNumber, kind: "PAYOUT", createdAtMs: this._now() }],
            payouts: [...this._state.payouts, payout] });
        return Object.freeze({ ...payout, replay: false });
    }

    getPayout(payoutId) {
        this._assertReady();
        const item = this._state.payouts.find(x => x.payoutId === payoutId);
        return item ? Object.freeze({ ...item, allocation: Object.freeze({ ...item.allocation }),
            winner: Object.freeze({ ...item.winner }), owner: Object.freeze({ ...item.owner }) }) : null;
    }
    listPayouts() { this._assertReady(); return Object.freeze(this._state.payouts.map(x => Object.freeze({ ...x }))); }

    /** Persist the irreversible Page5 boundary so later room cleanup cannot refund a played game. */
    recordPage5Started(roomId) {
        this._assertReady();
        if (typeof roomId !== "string" || !roomId.trim()) throw new Error("MAINNET_PAGE5_ROOM_ID_INVALID");
        const started = this._state.page5StartedRooms ?? [];
        if (started.includes(roomId)) return Object.freeze({ roomId, replay: true });
        this._commit({ ...this._state, page5StartedRooms: [...started, roomId] });
        return Object.freeze({ roomId, replay: false });
    }

    hasPage5Started(roomId) {
        this._assertReady();
        return (this._state.page5StartedRooms ?? []).includes(roomId);
    }

    updatePayoutLeg(payoutId, role, patch) {
        this._assertReady();
        if (!new Set(["winner", "owner"]).has(role)) throw new Error("MAINNET_PAYOUT_ROLE_INVALID");
        const current = this.getPayout(payoutId);
        if (!current) throw new Error("MAINNET_PAYOUT_NOT_FOUND");
        const leg = current[role];
        const nextLeg = { ...leg, ...patch };
        if (nextLeg.amountAtomic !== leg.amountAtomic || nextLeg.address !== leg.address
            || nextLeg.recipientId !== leg.recipientId || !PAYOUT_STATES.has(nextLeg.state)) {
            throw new Error("MAINNET_PAYOUT_LEG_IDENTITY_OR_STATE_INVALID");
        }
        const allowed = {
            PENDING: ["SUBMISSION_UNKNOWN"],
            SUBMISSION_UNKNOWN: ["SUBMITTED", "CONFIRMED", "UNPAID_INSUFFICIENT_GAS"],
            SUBMITTED: ["CONFIRMED"],
            UNPAID_INSUFFICIENT_GAS: ["PENDING"],
            CONFIRMED: []
        };
        if (nextLeg.state !== leg.state && !allowed[leg.state]?.includes(nextLeg.state)) {
            throw new Error("MAINNET_PAYOUT_LEG_TRANSITION_INVALID");
        }
        if (leg.transactionId && nextLeg.transactionId !== leg.transactionId) throw new Error("MAINNET_PAYOUT_TRANSACTION_IMMUTABLE");
        const payout = { ...current, [role]: nextLeg };
        payout.state = payout.winner.state === "CONFIRMED" && payout.owner.state === "CONFIRMED"
            ? "COMPLETE" : payout.owner.state === "UNPAID_INSUFFICIENT_GAS" ? "PARTIAL_OWNER_UNPAID" : "PENDING";
        const payouts = this._state.payouts.map(x => x.payoutId === payoutId ? payout : x);
        this._commit({ ...this._state, payouts });
        return Object.freeze({ ...payout });
    }

    countOpenObligations(roomId) {
        this._assertReady();
        const refunds = this._state.refunds.filter(x => x.roomId === roomId && x.state !== "COMPLETE").length;
        const payouts = this._state.payouts.filter(x => x.roomId === roomId)
            .reduce((count, payout) => count + [payout.winner, payout.owner].filter(x => x.state !== "CONFIRMED").length, 0);
        return refunds + payouts;
    }

    /** Mainnet owner-gas exception: leave debt in the ledger, but do not mark the wallet quarantined. */
    countWalletBlockingObligations(roomId) {
        this._assertReady();
        const refunds = this._state.refunds.filter(x => x.roomId === roomId && x.state !== "COMPLETE").length;
        const payouts = this._state.payouts.filter(x => x.roomId === roomId)
            .reduce((count, payout) => count + [payout.winner, payout.owner].filter(x =>
                x.state !== "CONFIRMED" && !(x === payout.owner && x.state === "UNPAID_INSUFFICIENT_GAS")
            ).length, 0);
        return refunds + payouts;
    }

    _validateRefund(x) {
        if (!x || x.network !== "mainnet" || x.globalId !== MAINNET_GLOBAL_ID
            || !REFUND_STATES.has(x.state) || !Number.isSafeInteger(x.amountAtomic) || x.amountAtomic <= 0
            || x.denomination !== "TON" || x.payerAddress !== x.refundDestination
            || !Number.isSafeInteger(x.createdAtMs) || !x.roomId || !x.playerId) throw new Error("MAINNET_REFUND_RECORD_INVALID");
        mainnetAddressIdentity(x.refundDestination); mainnetAddressIdentity(x.sourceWalletAddress);
    }

    _validatePayout(x) {
        const a = calculateMainnetPayout(x.principalAtomic);
        if (!x || !x.payoutId || !x.roomId || x.allocation?.winnerAtomic !== a.winnerAtomic
            || x.allocation?.ownerAtomic !== a.ownerAtomic || x.allocation?.reserveAtomic !== a.reserveAtomic
            || x.winner?.amountAtomic !== a.winnerAtomic || x.owner?.amountAtomic !== a.ownerAtomic
            || !["PENDING", "PARTIAL_OWNER_UNPAID", "COMPLETE"].includes(x.state)
            || !PAYOUT_STATES.has(x.winner?.state) || !PAYOUT_STATES.has(x.owner?.state)) throw new Error("MAINNET_PAYOUT_RECORD_INVALID");
        mainnetAddressIdentity(x.sourceWalletAddress); mainnetAddressIdentity(x.winner.address); mainnetAddressIdentity(x.owner.address);
    }

    _validate(state) {
        if (!state || state.schemaVersion !== 1 || state.network !== "mainnet" || state.globalId !== MAINNET_GLOBAL_ID
            || !Array.isArray(state.outcomes) || !Array.isArray(state.refunds) || !Array.isArray(state.payouts)
            || (state.page5StartedRooms !== undefined && !Array.isArray(state.page5StartedRooms))
            || (state.historyCoverage !== undefined && !Array.isArray(state.historyCoverage))) {
            throw new Error("MAINNET_FINANCIAL_LEDGER_IDENTITY_INVALID");
        }
        const started = state.page5StartedRooms ?? [];
        if (started.some(roomId => typeof roomId !== "string" || !roomId.trim())
            || new Set(started).size !== started.length) {
            throw new Error("MAINNET_PAGE5_STATE_INVALID");
        }
        const refundIds = new Set();
        for (const item of state.refunds) { this._validateRefund(item); if (refundIds.has(item.obligationId)) throw new Error("MAINNET_REFUND_DUPLICATE"); refundIds.add(item.obligationId); }
        const payouts = new Set();
        for (const item of state.payouts) { this._validatePayout(item); if (payouts.has(item.payoutId)) throw new Error("MAINNET_PAYOUT_DUPLICATE"); payouts.add(item.payoutId); }
        const coverageRooms = new Set();
        for (const item of state.historyCoverage ?? []) {
            if (!item || typeof item.roomId !== "string" || !item.roomId
                || item.source !== "FINAL_FORENSIC_HISTORY_COVERAGE"
                || !Number.isSafeInteger(item.completedAt) || item.completedAt <= 0
                || typeof item.resultWindowComplete !== "boolean"
                || !(item.providerError === null || typeof item.providerError === "string")
                || !Number.isSafeInteger(item.candidateCount) || item.candidateCount < 0
                || !Number.isSafeInteger(item.checkedCount) || item.checkedCount < 0
                || !Number.isSafeInteger(item.pendingCount) || item.pendingCount < 0
                || item.candidateCursor !== undefined
                    && (!Number.isSafeInteger(item.candidateCursor) || item.candidateCursor < 0)
                || !Array.isArray(item.verifiedTransactionIds)
                || item.verifiedTransactionIds.some(id => typeof id !== "string" || !id)
                || new Set(item.verifiedTransactionIds).size !== item.verifiedTransactionIds.length
                || coverageRooms.has(item.roomId)) {
                throw new Error("MAINNET_HISTORY_COVERAGE_RECORD_INVALID");
            }
            coverageRooms.add(item.roomId);
        }
    }

    _commit(state) { this._validate(state); this._persist(state); }
    _persist(state, exclusive = false) { durableWriteJson(this._file, state, { exclusive }); this._state = state; }
    _assertReady() { if (!this._initialized) throw new Error("MAINNET_FINANCIAL_LEDGER_NOT_INITIALIZED"); }
}
