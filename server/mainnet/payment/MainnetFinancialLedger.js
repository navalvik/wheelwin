import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 20;

function waitForLockRetry() {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
}

function readStateFile(file) {
    if (!existsSync(file)) return clone(EMPTY);
    try {
        const state = JSON.parse(readFileSync(file, "utf8"));
        state.historyCoverage ??= [];
        return state;
    } catch {
        throw new Error("MAINNET_FINANCIAL_LEDGER_CORRUPT");
    }
}

function acquireFileLock(lockFile) {
    const startedAt = Date.now();
    for (;;) {
        try {
            const fd = openSync(lockFile, "wx", 0o600);
            try {
                writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");
                fsyncSync(fd);
            } catch (error) {
                closeSync(fd);
                try { unlinkSync(lockFile); } catch { /* retain the original failure */ }
                throw error;
            }
            return fd;
        } catch (error) {
            if (error?.code !== "EEXIST") throw error;
            let lockStat;
            let owner;
            try {
                lockStat = statSync(lockFile);
                owner = JSON.parse(readFileSync(lockFile, "utf8"));
            } catch { /* A writer may be creating the lock file. */ }
            if (lockStat && Number.isInteger(owner?.pid) && owner.pid > 0) {
                let ownerAlive = true;
                try { process.kill(owner.pid, 0); }
                catch (probeError) { ownerAlive = probeError?.code === "EPERM"; }
                if (!ownerAlive) {
                    try {
                        const current = statSync(lockFile);
                        const sameLock = current.ino === lockStat.ino
                            && current.mtimeMs === lockStat.mtimeMs;
                        if (sameLock) unlinkSync(lockFile);
                    } catch { /* Another process already recovered the stale lock. */ }
                    continue;
                }
            }
            if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
                throw new Error("MAINNET_FINANCIAL_LEDGER_LOCK_TIMEOUT");
            }
            waitForLockRetry();
        }
    }
}

function withFileLock(lockFile, action) {
    const fd = acquireFileLock(lockFile);
    try { return action(); }
    finally {
        closeSync(fd);
        try { unlinkSync(lockFile); } catch (error) {
            if (error?.code !== "ENOENT") throw error;
        }
    }
}

function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function mergeImmutableRecord(left, right, identityFields, conflictCode) {
    for (const field of identityFields) {
        if (!sameJson(left[field], right[field])) throw new Error(conflictCode);
    }
    return { ...left, ...right };
}

function valueAtPath(record, path) {
    return path.split(".").reduce((value, key) => value?.[key], record);
}

function latestRecord(left, right, identityFields, timestampFields, conflictCode) {
    mergeImmutableRecord(left, right, identityFields, conflictCode);
    if (sameJson(left, right)) return left;
    const leftTime = Math.max(0, ...timestampFields.map(field => Number(valueAtPath(left, field) ?? 0)));
    const rightTime = Math.max(0, ...timestampFields.map(field => Number(valueAtPath(right, field) ?? 0)));
    if (leftTime === rightTime) throw new Error(conflictCode);
    return leftTime > rightTime ? left : right;
}

function mergePayout(left, right) {
    const identityFields = ["payoutId", "roomId", "roomNumber", "sourceWalletAddress",
        "principalAtomic", "allocation"];
    mergeImmutableRecord(left, right, identityFields, "MAINNET_LEDGER_CONCURRENT_PAYOUT_CONFLICT");
    const merged = { ...left };
    for (const role of ["winner", "owner"]) {
        const a = left[role];
        const b = right[role];
        for (const field of ["recipientId", "address", "amountAtomic"]) {
            if (a[field] !== b[field]) throw new Error("MAINNET_LEDGER_CONCURRENT_PAYOUT_CONFLICT");
        }
        if (a.transactionId && b.transactionId && a.transactionId !== b.transactionId) {
            throw new Error("MAINNET_LEDGER_CONCURRENT_PAYOUT_CONFLICT");
        }
        if (sameJson(a, b)) { merged[role] = a; continue; }
        if (a.state === "CONFIRMED" && b.state === "CONFIRMED" && a.transactionId !== b.transactionId) {
            throw new Error("MAINNET_LEDGER_CONCURRENT_PAYOUT_CONFLICT");
        }
        const rank = state => ({ PENDING: 0, UNPAID_INSUFFICIENT_GAS: 1,
            SUBMISSION_UNKNOWN: 2, SUBMITTED: 3, CONFIRMED: 4 })[state] ?? -1;
        if ([a.state, b.state].includes("PENDING")
            && [a.state, b.state].includes("UNPAID_INSUFFICIENT_GAS")) {
            const pending = a.state === "PENDING" ? a : b;
            const unpaid = a.state === "UNPAID_INSUFFICIENT_GAS" ? a : b;
            merged[role] = Number.isSafeInteger(pending.updatedAtMs)
                && (!Number.isSafeInteger(unpaid.updatedAtMs)
                    || pending.updatedAtMs >= unpaid.updatedAtMs)
                ? pending : unpaid;
            continue;
        }
        if ([a.state, b.state].includes("SUBMISSION_UNKNOWN")
            && [a.state, b.state].includes("UNPAID_INSUFFICIENT_GAS")) {
            const unknown = a.state === "SUBMISSION_UNKNOWN" ? a : b;
            const unpaid = a.state === "UNPAID_INSUFFICIENT_GAS" ? a : b;
            merged[role] = Number(unknown.updatedAtMs ?? unknown.attemptedAtMs ?? 0)
                > Number(unpaid.updatedAtMs ?? unpaid.attemptedAtMs ?? 0) ? unknown : unpaid;
            continue;
        }
        const aRank = rank(a.state);
        const bRank = rank(b.state);
        if (aRank !== bRank) { merged[role] = aRank > bRank ? a : b; continue; }
        merged[role] = latestRecord(a, b, ["recipientId", "address", "amountAtomic", "state", "transactionId"],
            ["updatedAtMs", "attemptedAtMs", "submittedAtMs", "finalizedEvidence.observedAtMs"],
            "MAINNET_LEDGER_CONCURRENT_PAYOUT_CONFLICT");
    }
    merged.state = merged.winner.state === "CONFIRMED" && merged.owner.state === "CONFIRMED"
        ? "COMPLETE" : merged.owner.state === "UNPAID_INSUFFICIENT_GAS" ? "PARTIAL_OWNER_UNPAID" : "PENDING";
    merged.createdAtMs = Math.min(Number(left.createdAtMs ?? 0), Number(right.createdAtMs ?? 0));
    return merged;
}

function mergeRows(currentRows, proposedRows, keyOf, mergeRow, conflictCode) {
    const result = new Map(currentRows.map(row => [keyOf(row), row]));
    for (const row of proposedRows) {
        const key = keyOf(row);
        const prior = result.get(key);
        if (!prior) { result.set(key, row); continue; }
        try { result.set(key, mergeRow(prior, row)); }
        catch (error) {
            if (error?.message?.startsWith("MAINNET_LEDGER_CONCURRENT_")) throw error;
            throw new Error(conflictCode);
        }
    }
    return [...result.values()];
}

function mergeLedgerSnapshots(current, proposed) {
    const outcomes = mergeRows(current.outcomes, proposed.outcomes, row => row.roomId,
        (left, right) => latestRecord(left, right,
            ["roomId", "kind", "roomNumber", "closureReason"], ["closedAtMs", "createdAtMs"],
            "MAINNET_LEDGER_CONCURRENT_OUTCOME_CONFLICT"),
        "MAINNET_LEDGER_CONCURRENT_OUTCOME_CONFLICT");
    const refunds = mergeRows(current.refunds, proposed.refunds, row => row.obligationId,
        (left, right) => {
            mergeImmutableRecord(left, right, ["obligationId", "idempotencyKey", "network",
                "globalId", "roomId", "roomNumber", "playerId", "paymentIntentId", "incomingTransactionId",
                "amountAtomic", "denomination", "payerAddress", "refundDestination", "sourceWalletAddress",
                "closureReason"], "MAINNET_LEDGER_CONCURRENT_REFUND_CONFLICT");
            for (const field of ["transferAmountAtomic", "gasChargeAtomic", "outgoingTransactionId"]) {
                if (left[field] !== null && left[field] !== undefined
                    && right[field] !== null && right[field] !== undefined
                    && left[field] !== right[field]) {
                    throw new Error("MAINNET_LEDGER_CONCURRENT_REFUND_CONFLICT");
                }
            }
            const rank = { PENDING: 0, SUBMISSION_UNKNOWN: 1, SUBMITTED: 2, COMPLETE: 3 };
            if ((rank[left.state] ?? -1) !== (rank[right.state] ?? -1)) {
                return (rank[left.state] ?? -1) > (rank[right.state] ?? -1) ? left : right;
            }
            return latestRecord(left, right, ["obligationId", "state", "outgoingTransactionId",
                "transferAmountAtomic", "gasChargeAtomic"], ["attemptedAtMs", "submittedAtMs",
                "finalizedEvidence.observedAtMs"], "MAINNET_LEDGER_CONCURRENT_REFUND_CONFLICT");
        }, "MAINNET_LEDGER_CONCURRENT_REFUND_CONFLICT");
    const payouts = mergeRows(current.payouts, proposed.payouts, row => row.payoutId, mergePayout,
        "MAINNET_LEDGER_CONCURRENT_PAYOUT_CONFLICT");
    const historyCoverage = mergeRows(current.historyCoverage ?? [], proposed.historyCoverage ?? [],
        row => row.roomId, (left, right) => {
            // Coverage is a replaceable observation, not a financial
            // obligation. The lock provides a total write order when provider
            // clocks have the same millisecond, so the later committed record
            // is the authoritative latest check.
            return left.completedAt > right.completedAt ? left : right;
        }, "MAINNET_LEDGER_CONCURRENT_HISTORY_CONFLICT");
    return { schemaVersion: 1, network: "mainnet", globalId: MAINNET_GLOBAL_ID,
        outcomes, refunds, payouts,
        page5StartedRooms: [...new Set([...(current.page5StartedRooms ?? []),
            ...(proposed.page5StartedRooms ?? [])])], historyCoverage };
}

export class MainnetFinancialLedger {
    constructor({ config, nowProvider = Date.now } = {}) {
        if (config?.network !== "mainnet" || config?.globalId !== MAINNET_GLOBAL_ID
            || typeof config?.dataDir !== "string" || !config.dataDir || typeof nowProvider !== "function") {
            throw new Error("MAINNET_FINANCIAL_LEDGER_CONFIG_INVALID");
        }
        this.network = "mainnet";
        this.globalId = MAINNET_GLOBAL_ID;
        this._file = join(config.dataDir, "financial-lifecycle", "state.json");
        this._lockFile = `${this._file}.lock`;
        this._now = nowProvider;
        this._state = clone(EMPTY);
        this._initialized = false;
    }

    initialize() {
        if (this._initialized) return this;
        mkdirSync(join(this._file, ".."), { recursive: true });
        this._state = readStateFile(this._file);
        this._validate(this._state);
        this._initialized = true;
        if (!existsSync(this._file)) withFileLock(this._lockFile, () => {
            if (!existsSync(this._file)) this._persist(readStateFile(this._file), true);
            else this._state = readStateFile(this._file);
        });
        return this;
    }

    recordClosedRoom({ roomId, roomNumber, closureReason, prePage5 = true } = {}) {
        this._assertReady();
        this._refresh();
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
        this._refresh();
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
        this._refresh();
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
                && intent?.state === "SETTLED"
                && intent.confirmedTransactionId === receipt.transactionId;
            const additionalPayment = receipt.status === "EXTRA_PAYMENT"
                && intent?.confirmedTransactionId !== receipt.transactionId;
            if (!intent || !observation || duplicateTransactionBinding
                || receipt.network !== "mainnet" || receipt.globalId !== MAINNET_GLOBAL_ID
                || receipt.roomId !== roomId || receipt.asset !== "TON"
                || intent.network !== "mainnet" || intent.globalId !== MAINNET_GLOBAL_ID
                || intent.roomId !== roomId
                || (!principalPayment && !additionalPayment)
                || intent.playerId !== receipt.playerId
                || (principalPayment && intent.amountAtomic !== receipt.amountAtomic)
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
                    || prior.amountAtomic !== Number(BigInt(receipt.amountAtomic))
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
            const amountAtomic = Number(BigInt(receipt.amountAtomic));
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
        this._refresh();
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
        this._refresh();
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

    /**
     * Restore a payout whose two transfers are already independently finalized.
     * The complete record is committed in one ledger transaction, so live
     * executors never observe a temporary PENDING leg that could be resent.
     */
    recordConfirmedPayout({ payoutId, roomId, roomNumber, sourceWalletAddress, principalAtomic,
        winner, owner, createdAtMs = this._now(), verificationProviders } = {}) {
        this._assertReady();
        this._refresh();
        if (typeof payoutId !== "string" || !/^payout_[A-Za-z0-9_-]{1,64}$/.test(payoutId)
            || typeof roomId !== "string" || !roomId || !Number.isSafeInteger(roomNumber) || roomNumber < 1
            || typeof sourceWalletAddress !== "string" || !Number.isSafeInteger(createdAtMs) || createdAtMs <= 0
            || !Array.isArray(verificationProviders)
            || !["toncenter-mainnet", "tonapi-mainnet"].every(provider => verificationProviders.includes(provider))
            || !winner?.recipientId || !winner?.address || !owner?.recipientId || !owner?.address) {
            throw new Error("MAINNET_CONFIRMED_PAYOUT_INPUT_INVALID");
        }
        const allocation = calculateMainnetPayout(principalAtomic);
        const validateLeg = (role, input, amountAtomic) => {
            const evidence = input.finalizedEvidence;
            if (input.state !== "CONFIRMED" || typeof input.transactionId !== "string" || !input.transactionId
                || input.amountAtomic !== amountAtomic
                || !evidence || evidence.network !== "mainnet" || evidence.globalId !== MAINNET_GLOBAL_ID
                || evidence.transactionId !== input.transactionId || evidence.amountAtomic !== amountAtomic
                || evidence.destination !== input.address || evidence.finalized !== true
                || evidence.independentProvider !== "tonapi-mainnet"
                || !Number.isSafeInteger(evidence.observedAtMs) || evidence.observedAtMs < createdAtMs
                || !Number.isSafeInteger(evidence.actualFeeAtomic) || evidence.actualFeeAtomic < 0
                || typeof evidence.recipientTransactionId !== "string" || !evidence.recipientTransactionId
                || typeof evidence.messageHash !== "string" || !evidence.messageHash) {
                throw new Error(`MAINNET_CONFIRMED_PAYOUT_${role.toUpperCase()}_EVIDENCE_INVALID`);
            }
            mainnetAddressIdentity(input.address);
            return { recipientId: input.recipientId, address: input.address, amountAtomic,
                state: "CONFIRMED", transactionId: input.transactionId,
                finalizedEvidence: { ...evidence }, updatedAtMs: evidence.observedAtMs };
        };
        const winnerLeg = validateLeg("winner", winner, allocation.winnerAtomic);
        const ownerLeg = validateLeg("owner", owner, allocation.ownerAtomic);
        mainnetAddressIdentity(sourceWalletAddress);

        const outcome = this._state.outcomes.find(item => item.roomId === roomId);
        if (outcome?.kind === "REFUND") throw new Error("MAINNET_ROOM_ALREADY_HAS_REFUND_OUTCOME");
        const previous = this._state.payouts.find(item => item.roomId === roomId);
        if (previous && (previous.payoutId !== payoutId || previous.principalAtomic !== principalAtomic
            || previous.roomNumber !== roomNumber || previous.sourceWalletAddress !== sourceWalletAddress
            || previous.winner.address !== winnerLeg.address || previous.owner.address !== ownerLeg.address
            || previous.winner.recipientId !== winnerLeg.recipientId
            || previous.owner.recipientId !== ownerLeg.recipientId)) {
            throw new Error("MAINNET_PAYOUT_IDENTITY_CONFLICT");
        }
        const payout = { payoutId, roomId, roomNumber, sourceWalletAddress, principalAtomic, allocation,
            winner: winnerLeg, owner: ownerLeg, state: "COMPLETE", createdAtMs };
        this._validatePayout(payout);
        this._commit({ ...this._state,
            outcomes: outcome ? this._state.outcomes : [...this._state.outcomes,
                { roomId, roomNumber, kind: "PAYOUT", createdAtMs }],
            payouts: previous
                ? this._state.payouts.map(item => item.roomId === roomId ? payout : item)
                : [...this._state.payouts, payout]
        });
        return Object.freeze({ ...payout, winner: Object.freeze({ ...winnerLeg }),
            owner: Object.freeze({ ...ownerLeg }), replay: Boolean(previous) });
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
        this._refresh();
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
        this._refresh();
        if (!new Set(["winner", "owner"]).has(role)) throw new Error("MAINNET_PAYOUT_ROLE_INVALID");
        const current = this.getPayout(payoutId);
        if (!current) throw new Error("MAINNET_PAYOUT_NOT_FOUND");
        const leg = current[role];
        const nextLeg = { ...leg, ...patch, updatedAtMs: this._now() };
        if (nextLeg.amountAtomic !== leg.amountAtomic || nextLeg.address !== leg.address
            || nextLeg.recipientId !== leg.recipientId || !PAYOUT_STATES.has(nextLeg.state)) {
            throw new Error("MAINNET_PAYOUT_LEG_IDENTITY_OR_STATE_INVALID");
        }
        const allowed = {
            PENDING: role === "owner"
                ? ["SUBMISSION_UNKNOWN", "UNPAID_INSUFFICIENT_GAS"]
                : ["SUBMISSION_UNKNOWN"],
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
        const payoutRooms = new Set();
        for (const item of state.payouts) {
            this._validatePayout(item);
            if (payouts.has(item.payoutId)) throw new Error("MAINNET_PAYOUT_DUPLICATE");
            if (payoutRooms.has(item.roomId)) throw new Error("MAINNET_PAYOUT_ROOM_DUPLICATE");
            payouts.add(item.payoutId);
            payoutRooms.add(item.roomId);
        }
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

    _commit(state) {
        this._validate(state);
        withFileLock(this._lockFile, () => {
            const current = readStateFile(this._file);
            this._validate(current);
            const merged = mergeLedgerSnapshots(current, state);
            this._validate(merged);
            this._persist(merged);
        });
    }
    _persist(state, exclusive = false) { durableWriteJson(this._file, state, { exclusive }); this._state = state; }
    _refresh() {
        withFileLock(this._lockFile, () => {
            const current = readStateFile(this._file);
            this._validate(current);
            this._state = current;
        });
    }
    _assertReady() { if (!this._initialized) throw new Error("MAINNET_FINANCIAL_LEDGER_NOT_INITIALIZED"); }
}
