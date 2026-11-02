import { createHash } from "node:crypto";
import { MAINNET_GLOBAL_ID } from "../config/MainnetRuntimeConfig.js";
import { mainnetAddressIdentity } from "./MainnetAddress.js";

const COVERAGE_SOURCE = "FINAL_FORENSIC_HISTORY_COVERAGE";

function sameAddress(left, right) {
    try { return mainnetAddressIdentity(left) === mainnetAddressIdentity(right); }
    catch { return false; }
}

function safeAtomic(value) {
    try {
        const amount = BigInt(value);
        return amount > 0n && amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
    } catch { return null; }
}

function fingerprint(record) {
    const stable = {
        transactionId: record.transactionId,
        providerTransactionId: record.providerTransactionId,
        accountId: record.accountId,
        sourceAddress: record.sourceAddress,
        destinationAddress: record.destinationAddress,
        amountAtomic: record.amountAtomic,
        asset: record.asset,
        transactionTime: record.transactionTime,
        paymentReference: record.paymentReference,
        malformedComment: record.malformedComment
    };
    return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

/** Bounded Mainnet counterpart of Testnet historical receipt recovery. */
export class MainnetHistoricalIncomingReceiptReconciler {
    constructor({ incomingLedger, financialLedger, client, outgoingObserver,
        independentVerifier, walletPool, refundLifecycle, nowProvider = Date.now,
        maxCandidatesPerPass = 3, historyLimit = 1000 } = {}) {
        if (incomingLedger?.network !== "mainnet" || incomingLedger?.globalId !== MAINNET_GLOBAL_ID
            || typeof incomingLedger.listRoomIntents !== "function"
            || typeof incomingLedger.listAllIntents !== "function"
            || typeof incomingLedger.listReceipts !== "function"
            || typeof incomingLedger.listObservations !== "function"
            || typeof incomingLedger.getReceipt !== "function"
            || typeof incomingLedger.recordTransfer !== "function"
            || financialLedger?.network !== "mainnet" || financialLedger?.globalId !== MAINNET_GLOBAL_ID
            || typeof financialLedger.listClosedRooms !== "function"
            || typeof financialLedger.getOutcome !== "function"
            || typeof financialLedger.getHistoryCoverage !== "function"
            || typeof financialLedger.recordHistoryCoverage !== "function"
            || typeof financialLedger.hasPage5Started !== "function"
            || client?.network !== "mainnet" || client?.globalId !== MAINNET_GLOBAL_ID
            || typeof client.listIncomingTransactions !== "function"
            || typeof outgoingObserver?.findOutgoingTransfer !== "function"
            || typeof outgoingObserver?.verifyIndexedRecipientCredit !== "function"
            || typeof independentVerifier?.verifyTransfer !== "function"
            || typeof walletPool?.resolveReservationOwnerAt !== "function"
            || typeof refundLifecycle?.prepareClosedRoom !== "function"
            || typeof nowProvider !== "function"
            || !Number.isSafeInteger(maxCandidatesPerPass) || maxCandidatesPerPass < 1 || maxCandidatesPerPass > 3
            || !Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > 1000) {
            throw new Error("MAINNET_HISTORICAL_RECEIPT_RECONCILER_CONFIG_INVALID");
        }
        Object.assign(this, { incomingLedger, financialLedger, client, outgoingObserver,
            independentVerifier, walletPool, refundLifecycle, nowProvider, maxCandidatesPerPass, historyLimit });
        this.cursor = 0;
        this.running = false;
        this.stopped = false;
    }

    stop() { this.stopped = true; }

    async runPass() {
        if (this.stopped) return { status: "STOPPED" };
        if (this.running) return { status: "ALREADY_RUNNING" };
        this.running = true;
        try {
            const rooms = this.financialLedger.listClosedRooms();
            if (!rooms.length) return { status: "NO_CLOSED_ROOMS" };
            const room = rooms[this.cursor++ % rooms.length];
            return await this.recoverRoom(room.roomId);
        } finally {
            this.running = false;
        }
    }

    async recoverRoom(roomId) {
        if (this.stopped) return { roomId, status: "STOPPED" };
        const closed = this.financialLedger.getOutcome(roomId);
        if (closed?.kind !== "REFUND") return { roomId, status: "ROOM_NOT_CLOSED" };
        // A stale/refund outcome must never make a played room eligible for a refund.
        if (this.financialLedger.hasPage5Started(roomId)) return { roomId, status: "PAGE5_ALREADY_STARTED" };
        const intents = this.incomingLedger.listRoomIntents(roomId);
        if (intents.length === 0) return { roomId, status: "NO_INTENTS" };
        const startedAt = this.nowProvider();
        const floorMs = Math.min(...intents.map(intent => intent.createdAt));
        const ceilingMs = startedAt;
        const prior = this.financialLedger.getHistoryCoverage(roomId);

        if (intents.length !== 3 || !Number.isSafeInteger(startedAt) || startedAt < floorMs) {
            this._record(roomId, { completedAt: this.nowProvider(), ceilingMs,
                resultWindowComplete: false, providerError: "ROOM_INTENTS_OR_TIME_INVALID",
                candidateCount: 0, checkedCount: 0, pendingCount: 1,
                verifiedTransactionIds: prior?.verifiedTransactionIds ?? [], candidateCursor: 0 });
            return { roomId, status: "HISTORY_INCOMPLETE" };
        }

        const wallet = intents[0].destinationWalletAddress;
        if (intents.some(intent => intent.network !== "mainnet" || intent.globalId !== MAINNET_GLOBAL_ID
            || intent.destinationWalletId !== intents[0].destinationWalletId
            || !sameAddress(intent.destinationWalletAddress, wallet))) {
            this._record(roomId, { completedAt: this.nowProvider(), ceilingMs,
                resultWindowComplete: false, providerError: "ROOM_WALLET_IDENTITY_CONFLICT",
                candidateCount: 0, checkedCount: 0, pendingCount: 1,
                verifiedTransactionIds: prior?.verifiedTransactionIds ?? [], candidateCursor: 0 });
            return { roomId, status: "HISTORY_INCOMPLETE" };
        }

        let batch;
        try {
            batch = await this.client.listIncomingTransactions({ account: wallet,
                floorMs, ceilingMs, limit: this.historyLimit });
        } catch (error) {
            this._record(roomId, { completedAt: this.nowProvider(), ceilingMs,
                resultWindowComplete: false,
                providerError: String(error?.code ?? "PROVIDER_UNAVAILABLE").slice(0, 120),
                candidateCount: 0, checkedCount: 0, pendingCount: 1,
                verifiedTransactionIds: prior?.verifiedTransactionIds ?? [], candidateCursor: 0 });
            return { roomId, status: "HISTORY_PROVIDER_UNAVAILABLE" };
        }

        const records = Array.isArray(batch?.records) ? batch.records : [];
        const malformedCandidates = Number.isSafeInteger(batch?.malformedIncomingCandidateCount)
            ? Math.max(0, batch.malformedIncomingCandidateCount) : 0;
        if (batch?.resultWindowComplete !== true || records.length > this.historyLimit) {
            this._record(roomId, { completedAt: this.nowProvider(), ceilingMs,
                resultWindowComplete: false, providerError: "INCOMPLETE_RESULT_WINDOW",
                candidateCount: records.length, checkedCount: 0,
                pendingCount: Math.max(1, records.length),
                verifiedTransactionIds: prior?.verifiedTransactionIds ?? [], candidateCursor: 0 });
            return { roomId, status: "HISTORY_INCOMPLETE" };
        }
        if (malformedCandidates > 0) {
            this._record(roomId, { completedAt: this.nowProvider(), ceilingMs,
                resultWindowComplete: false, providerError: "MALFORMED_INCOMING_CANDIDATE",
                candidateCount: records.length + malformedCandidates, checkedCount: 0,
                pendingCount: malformedCandidates,
                verifiedTransactionIds: prior?.verifiedTransactionIds ?? [], candidateCursor: 0 });
            return { roomId, status: "HISTORY_INCOMPLETE" };
        }

        const transactionIds = records.map(record => record?.transactionId);
        if (transactionIds.some(id => typeof id !== "string" || !id)
            || new Set(transactionIds).size !== transactionIds.length) {
            this._record(roomId, { completedAt: this.nowProvider(), ceilingMs,
                resultWindowComplete: false, providerError: "DUPLICATE_OR_INVALID_HISTORY_IDENTITY",
                candidateCount: records.length, checkedCount: 0, pendingCount: Math.max(1, records.length),
                verifiedTransactionIds: prior?.verifiedTransactionIds ?? [], candidateCursor: 0 });
            return { roomId, status: "HISTORY_INCOMPLETE" };
        }

        const candidates = records.filter(record => this._isCandidate(record, intents, floorMs, ceilingMs));
        const candidateIds = new Set(candidates.map(record => record.transactionId));
        const priorVerified = new Set((prior?.verifiedTransactionIds ?? []).filter(id => candidateIds.has(id)));
        const unverified = candidates.filter(record => !priorVerified.has(record.transactionId));
        const start = unverified.length ? (prior?.candidateCursor ?? 0) % unverified.length : 0;
        const attemptedCount = Math.min(this.maxCandidatesPerPass, unverified.length);
        const verified = new Set(priorVerified);
        let failed = 0;
        for (let offset = 0; offset < attemptedCount; offset++) {
            if (this.stopped) break;
            const record = unverified[(start + offset) % unverified.length];
            try {
                const captured = await this._verifyAndCapture(record, roomId, intents, floorMs);
                if (captured) {
                    // Do not mark the history candidate complete until the existing
                    // refund lifecycle has persisted all eligible obligations.
                    this.refundLifecycle.prepareClosedRoom({ roomId,
                        roomNumber: closed.roomNumber, closureReason: closed.closureReason,
                        status: "DESTROYED", prePage5: true });
                    verified.add(record.transactionId);
                } else failed++;
            } catch {
                failed++;
            }
        }

        const receiptById = new Map(this.incomingLedger.listReceipts(roomId)
            .map(receipt => [receipt.transactionId, receipt]));
        const pendingRecords = candidates.filter(record => !verified.has(record.transactionId)
            || !["CONFIRMED", "EXTRA_PAYMENT"].includes(receiptById.get(record.transactionId)?.status));
        const pendingCount = pendingRecords.length + malformedCandidates;
        const nextCursor = unverified.length ? (start + attemptedCount) % unverified.length : 0;
        this._record(roomId, { completedAt: this.nowProvider(), ceilingMs,
            resultWindowComplete: true, providerError: failed > 0 ? "CANDIDATE_VERIFICATION_PENDING" : null,
            candidateCount: candidates.length + malformedCandidates,
            checkedCount: verified.size, pendingCount,
            verifiedTransactionIds: [...verified].filter(id => candidates.some(r => r.transactionId === id)).sort(),
            candidateCursor: nextCursor });
        return { roomId, status: pendingCount === 0 ? "HISTORY_CHECKED" : "HISTORY_PENDING",
            candidateCount: candidates.length, checkedCount: attemptedCount, pendingCount };
    }

    _isCandidate(record, intents, floorMs, ceilingMs) {
        return record?.network === "mainnet" && record.globalId === MAINNET_GLOBAL_ID
            && record.asset === "TON" && Number.isSafeInteger(record.transactionTime)
            && record.transactionTime >= floorMs && record.transactionTime <= ceilingMs
            && sameAddress(record.destinationAddress, intents[0].destinationWalletAddress)
            && sameAddress(record.accountId, record.destinationAddress)
            && typeof record.providerTransactionId === "string" && !!record.providerTransactionId
            && safeAtomic(record.amountAtomic) !== null;
    }

    _resolveIntent(record, roomId, intents) {
        if (record.malformedComment || record.paymentReference && record.hasComment !== true
            || record.hasComment === true && !record.paymentReference) return null;
        const pool = this.incomingLedger.listAllIntents();
        const candidates = intents.filter(intent => intent.roomId === roomId
            && intent.network === "mainnet" && intent.globalId === MAINNET_GLOBAL_ID
            && intent.asset === "TON"
            && intent.createdAt <= record.transactionTime
            && sameAddress(intent.destinationWalletAddress, record.destinationAddress)
            && sameAddress(intent.expectedSender, record.sourceAddress)
            && intent.amountAtomic === record.amountAtomic
            && (record.paymentReference ? intent.paymentReference === record.paymentReference : true));
        if (!record.paymentReference && record.hasComment !== false) return null;
        if (candidates.length !== 1) return null;
        const intent = candidates[0];
        if (record.paymentReference) {
            const referenceOwners = pool.filter(item => item.paymentReference === record.paymentReference
                && item.destinationWalletId === intent.destinationWalletId
                && item.createdAt <= record.transactionTime
                && sameAddress(item.destinationWalletAddress, record.destinationAddress)
                && sameAddress(item.expectedSender, record.sourceAddress));
            if (referenceOwners.length !== 1 || referenceOwners[0].roomId !== roomId) return null;
        }
        const owner = this.walletPool.resolveReservationOwnerAt({
            walletId: intent.destinationWalletId, transactionTime: record.transactionTime
        });
        if (owner?.status === "OWNED") return owner.roomId === roomId ? intent : null;
        if (owner?.status === "UNKNOWN" && record.paymentReference) {
            const exactOwners = pool.filter(item => item.destinationWalletId === intent.destinationWalletId
                && item.paymentReference === record.paymentReference
                && item.createdAt <= record.transactionTime
                && sameAddress(item.destinationWalletAddress, record.destinationAddress)
                && sameAddress(item.expectedSender, record.sourceAddress));
            return exactOwners.length === 1 && exactOwners[0].roomId === roomId ? intent : null;
        }
        return null;
    }

    async _verifyAndCapture(record, roomId, intents, floorMs) {
        const intent = this._resolveIntent(record, roomId, intents);
        if (!intent || this.financialLedger.hasPage5Started(roomId)) return false;
        const amountAtomic = safeAtomic(record.amountAtomic);
        const query = { sourceWalletAddress: record.sourceAddress,
            destinationIdentity: record.destinationAddress, amountAtomic, minCreatedAtMs: floorMs };
        const outgoing = await this.outgoingObserver.findOutgoingTransfer(query);
        if (!outgoing?.transactionId || outgoing.ambiguous) return false;
        const indexed = await this.outgoingObserver.verifyIndexedRecipientCredit({
            ...query, transactionId: outgoing.transactionId
        });
        if (indexed?.status !== "MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED"
            || indexed.globalId !== MAINNET_GLOBAL_ID
            || indexed.sourceFinality !== "finalized" || indexed.recipientFinality !== "finalized"
            || indexed.sourceTransactionId !== outgoing.transactionId
            || indexed.recipientTransactionId !== record.providerTransactionId
            || typeof indexed.messageHash !== "string" || !indexed.messageHash
            || indexed.amountAtomic !== amountAtomic
            || !sameAddress(indexed.sourceWalletAddress, record.sourceAddress)
            || !sameAddress(indexed.destinationAddress, record.destinationAddress)) return false;
        const independent = await this.independentVerifier.verifyTransfer({
            sourceTransactionId: indexed.sourceTransactionId,
            recipientTransactionId: indexed.recipientTransactionId,
            messageHash: indexed.messageHash,
            sourceWalletAddress: record.sourceAddress,
            destinationAddress: record.destinationAddress,
            amountAtomic
        });
        if (independent?.status !== "INDEPENDENT_INDEXED_CREDIT_OBSERVED"
            || independent.provider !== "tonapi-mainnet"
            || independent.network !== "mainnet" || independent.globalId !== MAINNET_GLOBAL_ID
            || independent.sourceTransactionId !== indexed.sourceTransactionId
            || independent.recipientTransactionId !== indexed.recipientTransactionId
            || independent.messageHash !== indexed.messageHash
            || independent.amountAtomic !== amountAtomic
            || !sameAddress(independent.sourceWalletAddress, record.sourceAddress)
            || !sameAddress(independent.destinationAddress, record.destinationAddress)) return false;

        const priorObservation = this.incomingLedger.listObservations(roomId)
            .find(item => item.transactionId === record.transactionId);
        const priorReceipt = this.incomingLedger.getReceipt(record.transactionId);
        if (priorObservation && (priorObservation.roomId !== roomId
            || priorObservation.payloadFingerprint !== fingerprint(record))) return false;
        if (priorReceipt && priorReceipt.roomId !== roomId) return false;

        const currentIntent = this.incomingLedger.getIntent(intent.paymentReference);
        if (!currentIntent || currentIntent.roomId !== roomId) return false;
        const status = currentIntent.state === "SETTLED"
            && currentIntent.confirmedTransactionId !== record.transactionId
            ? "EXTRA_PAYMENT" : "CONFIRMED";
        const receipt = Object.freeze({
            network: "mainnet", globalId: MAINNET_GLOBAL_ID, roomId,
            transactionId: record.transactionId,
            providerTransactionId: record.providerTransactionId,
            paymentReference: intent.paymentReference, playerId: intent.playerId,
            status, reason: status === "EXTRA_PAYMENT" ? "PAYMENT_ALREADY_SETTLED" : null,
            amountAtomic: record.amountAtomic, sourceAddress: record.sourceAddress,
            destinationAddress: record.destinationAddress, transactionTime: record.transactionTime,
            asset: "TON", masterchainHeadSeqno: null, updatedAt: this.nowProvider()
        });
        const observation = Object.freeze({
            network: "mainnet", globalId: MAINNET_GLOBAL_ID, roomId,
            transactionId: record.transactionId,
            providerTransactionId: record.providerTransactionId,
            accountId: record.accountId, sourceAddress: record.sourceAddress,
            destinationAddress: record.destinationAddress, amountAtomic: record.amountAtomic,
            asset: record.asset, transactionTime: record.transactionTime,
            payloadFingerprint: fingerprint(record), observedAt: this.nowProvider()
        });
        this.incomingLedger.recordTransfer({ observation, receipt,
            settleReference: status === "CONFIRMED" ? intent.paymentReference : null });
        const saved = this.incomingLedger.getReceipt(record.transactionId);
        return saved?.roomId === roomId && ["CONFIRMED", "EXTRA_PAYMENT"].includes(saved.status);
    }

    _record(roomId, record) {
        return this.financialLedger.recordHistoryCoverage({
            roomId, source: COVERAGE_SOURCE, ...record
        });
    }
}
