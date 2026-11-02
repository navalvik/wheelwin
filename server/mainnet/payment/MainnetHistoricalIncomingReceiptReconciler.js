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

/** Bounded read-only closed-room history check for the shared final archive gate. */
export class MainnetHistoricalIncomingReceiptReconciler {
    constructor({ incomingLedger, financialLedger, client, outgoingObserver,
        independentVerifier, walletPool, nowProvider = Date.now,
        maxCandidatesPerPass = 3, historyLimit = 1000 } = {}) {
        if (incomingLedger?.network !== "mainnet" || incomingLedger?.globalId !== MAINNET_GLOBAL_ID
            || typeof incomingLedger.listRoomIntents !== "function"
            || typeof incomingLedger.listAllIntents !== "function"
            || typeof incomingLedger.listReceipts !== "function"
            || financialLedger?.network !== "mainnet" || financialLedger?.globalId !== MAINNET_GLOBAL_ID
            || typeof financialLedger.listClosedRooms !== "function"
            || typeof financialLedger.getOutcome !== "function"
            || typeof financialLedger.getHistoryCoverage !== "function"
            || typeof financialLedger.recordHistoryCoverage !== "function"
            || client?.network !== "mainnet" || client?.globalId !== MAINNET_GLOBAL_ID
            || typeof client.listIncomingTransactions !== "function"
            || typeof outgoingObserver?.findOutgoingTransfer !== "function"
            || typeof outgoingObserver?.verifyIndexedRecipientCredit !== "function"
            || typeof independentVerifier?.verifyTransfer !== "function"
            || typeof walletPool?.resolveReservationOwnerAt !== "function"
            || typeof nowProvider !== "function"
            || !Number.isSafeInteger(maxCandidatesPerPass) || maxCandidatesPerPass < 1 || maxCandidatesPerPass > 10
            || !Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > 1000) {
            throw new Error("MAINNET_HISTORICAL_RECEIPT_RECONCILER_CONFIG_INVALID");
        }
        Object.assign(this, { incomingLedger, financialLedger, client, outgoingObserver,
            independentVerifier, walletPool, nowProvider, maxCandidatesPerPass, historyLimit });
        this.cursor = 0;
        this.running = false;
    }

    async runPass() {
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
        const closed = this.financialLedger.getOutcome(roomId);
        if (closed?.kind !== "REFUND") return { roomId, status: "ROOM_NOT_CLOSED" };
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

        const currentIds = new Set(transactionIds);
        const verified = new Set((prior?.verifiedTransactionIds ?? []).filter(id => currentIds.has(id)));
        const candidates = records.filter(record => !verified.has(record.transactionId));
        const start = candidates.length ? (prior?.candidateCursor ?? 0) % candidates.length : 0;
        const attemptedCount = Math.min(this.maxCandidatesPerPass, candidates.length);
        for (let offset = 0; offset < attemptedCount; offset++) {
            const record = candidates[(start + offset) % candidates.length];
            if (await this._verifyCandidate(record, roomId, intents, floorMs, ceilingMs)) {
                verified.add(record.transactionId);
            }
        }

        const receipts = this.incomingLedger.listReceipts(roomId);
        const receiptByTransactionId = new Map(receipts.map(receipt => [receipt.transactionId, receipt]));
        let unaccounted = 0;
        for (const record of records) {
            const receipt = receiptByTransactionId.get(record.transactionId);
            if (receipt?.status !== "CONFIRMED"
                || receipt.network !== "mainnet" || receipt.globalId !== MAINNET_GLOBAL_ID
                || receipt.roomId !== roomId) unaccounted++;
        }
        const recordIds = new Set(transactionIds);
        const missingSettledIntents = intents.filter(intent => intent.state === "SETTLED"
            && !recordIds.has(intent.confirmedTransactionId)).length;
        const checkedCount = verified.size;
        const pendingCount = Math.max(0, records.length - checkedCount)
            + unaccounted + missingSettledIntents;
        const nextCursor = candidates.length ? (start + attemptedCount) % candidates.length : 0;
        this._record(roomId, { completedAt: this.nowProvider(), ceilingMs,
            resultWindowComplete: true, providerError: null,
            candidateCount: records.length, checkedCount, pendingCount,
            verifiedTransactionIds: [...verified].sort(), candidateCursor: nextCursor });
        return { roomId, status: pendingCount === 0 ? "HISTORY_CHECKED" : "HISTORY_PENDING",
            candidateCount: records.length, checkedCount, pendingCount };
    }

    async _verifyCandidate(record, roomId, intents, floorMs, ceilingMs) {
        if (!record || record.network !== "mainnet" || record.globalId !== MAINNET_GLOBAL_ID
            || record.asset !== "TON" || !Number.isSafeInteger(record.transactionTime)
            || record.transactionTime < floorMs || record.transactionTime > ceilingMs
            || !sameAddress(record.destinationAddress, intents[0].destinationWalletAddress)) return false;
        const amountAtomic = safeAtomic(record.amountAtomic);
        if (amountAtomic === null) return false;

        const owners = this.incomingLedger.listAllIntents();
        const referenceOwners = record.paymentReference
            ? owners.filter(intent => intent.destinationWalletId === intents[0].destinationWalletId
                && intent.paymentReference === record.paymentReference
                && intent.createdAt <= record.transactionTime
                && sameAddress(intent.destinationWalletAddress, record.destinationAddress)
                && sameAddress(intent.expectedSender, record.sourceAddress)) : [];
        const referenceRoomIds = [...new Set(referenceOwners.map(intent => intent.roomId))];
        const exactReferenceRoom = referenceRoomIds.length === 1 ? referenceRoomIds[0] : null;
        const ownership = this.walletPool.resolveReservationOwnerAt({
            walletId: intents[0].destinationWalletId, transactionTime: record.transactionTime
        });
        if (ownership?.status === "AMBIGUOUS"
            || ownership?.status === "OWNED" && ownership.roomId !== roomId
            || ownership?.status === "UNKNOWN" && exactReferenceRoom !== roomId
            || ownership?.status !== "OWNED" && ownership?.status !== "UNKNOWN") return false;
        if (ownership.status === "UNKNOWN" && exactReferenceRoom !== roomId) return false;

        const receipt = this.incomingLedger.getReceipt(record.transactionId);
        if (!receipt || receipt.status !== "CONFIRMED" || receipt.roomId !== roomId
            || receipt.network !== "mainnet" || receipt.globalId !== MAINNET_GLOBAL_ID
            || receipt.asset !== "TON" || receipt.transactionId !== record.transactionId
            || receipt.providerTransactionId !== record.providerTransactionId
            || (record.paymentReference ?? null) !== null
                && receipt.paymentReference !== record.paymentReference
            || receipt.amountAtomic !== record.amountAtomic
            || !sameAddress(receipt.sourceAddress, record.sourceAddress)
            || !sameAddress(receipt.destinationAddress, record.destinationAddress)) return false;
        const intent = intents.find(item => item.paymentReference === receipt.paymentReference);
        if (!intent || intent.state !== "SETTLED" || intent.confirmedTransactionId !== record.transactionId
            || intent.playerId !== receipt.playerId || intent.amountAtomic !== record.amountAtomic
            || !sameAddress(intent.expectedSender, record.sourceAddress)
            || !sameAddress(intent.destinationWalletAddress, record.destinationAddress)) return false;

        try {
            const query = { sourceWalletAddress: record.sourceAddress,
                destinationIdentity: record.destinationAddress, amountAtomic, minCreatedAtMs: floorMs };
            const outgoing = await this.outgoingObserver.findOutgoingTransfer(query);
            if (!outgoing?.transactionId || outgoing.ambiguous) return false;
            const indexed = await this.outgoingObserver.verifyIndexedRecipientCredit({
                ...query, transactionId: outgoing.transactionId
            });
            if (indexed?.status !== "MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED"
                || indexed.globalId !== MAINNET_GLOBAL_ID
                || indexed.sourceTransactionId !== outgoing.transactionId
                || indexed.recipientTransactionId !== record.providerTransactionId
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
            return independent?.status === "INDEPENDENT_INDEXED_CREDIT_OBSERVED"
                && independent.provider === "tonapi-mainnet"
                && independent.network === "mainnet" && independent.globalId === MAINNET_GLOBAL_ID
                && independent.sourceTransactionId === indexed.sourceTransactionId
                && independent.recipientTransactionId === indexed.recipientTransactionId
                && independent.messageHash === indexed.messageHash
                && independent.amountAtomic === amountAtomic
                && sameAddress(independent.sourceWalletAddress, record.sourceAddress)
                && sameAddress(independent.destinationAddress, record.destinationAddress);
        } catch {
            return false;
        }
    }

    _record(roomId, record) {
        return this.financialLedger.recordHistoryCoverage({
            roomId, source: COVERAGE_SOURCE, ...record
        });
    }
}
