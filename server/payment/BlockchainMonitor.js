import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { canonicalizeTonWalletAddress } from "../models/TonWalletAddress.js";

/**
 * P6.6 — Immutable audit ledger for entry-payment blockchain events.
 */
export class EntryPaymentAuditLedger {

    constructor() {

        // roomId → frozen entry[]
        this._entriesByRoom = new Map();

    }

    append(roomId, entry) {

        if (!roomId || !entry) {

            return null;

        }

        const list = this._entriesByRoom.get(roomId) ?? [];

        const frozen = Object.freeze({
            ...entry,
            recordedAt: entry.recordedAt ?? Date.now()
        });

        list.push(frozen);

        this._entriesByRoom.set(roomId, list);

        return frozen;

    }

    list(roomId) {

        return Object.freeze([...(this._entriesByRoom.get(roomId) ?? [])]);

    }

    clearRoom(roomId) {

        this._entriesByRoom.delete(roomId);

    }

    clearAll() {

        this._entriesByRoom.clear();

    }

}

/**
 * Normalize GRM amounts for comparison (2 decimal places).
 */
export function amountsMatch(expected, actual) {

    const left = Number(expected);

    const right = Number(actual);

    if (!Number.isFinite(left) || !Number.isFinite(right)) {

        return false;

    }

    return Math.round(left * 100) === Math.round(right * 100);

}

/**
 * Extract structured payment fields from a TonCenter transaction-like object.
 */
export function parseDepositCandidate(tx) {

    if (!tx || typeof tx !== "object") {

        return null;

    }

    const inMsg = tx.in_msg ?? tx.inMessage ?? null;

    if (!inMsg) {

        return null;

    }

    const sender = canonicalizeTonWalletAddress(
        inMsg.source
        ?? inMsg.sender
        ?? inMsg.from
        ?? null
    );

    const destination = canonicalizeTonWalletAddress(
        inMsg.destination
        ?? inMsg.recipient
        ?? inMsg.to
        ?? null
    );

    const comment = typeof inMsg.message === "string"
        ? inMsg.message
        : (
            typeof inMsg.comment === "string"
                ? inMsg.comment
                : (
                    typeof inMsg.msg_data?.text === "string"
                        ? inMsg.msg_data.text
                        : ""
                )
        );

    const amountRaw = inMsg.value
        ?? inMsg.amount
        ?? inMsg.jetton_amount
        ?? inMsg.jettonAmount
        ?? null;

    let amountGram = null;

    if (amountRaw != null) {

        const asNumber = Number(amountRaw);

        if (Number.isFinite(asNumber)) {

            // TonCenter value is nanotons; jetton monitors may pass GRM directly.
            amountGram = inMsg.amountIsGram === true
                || inMsg.currency === "GRM"
                ? asNumber
                : asNumber / 1e9;

        }

    }

    if (inMsg.grmAmount != null && Number.isFinite(Number(inMsg.grmAmount))) {

        amountGram = Number(inMsg.grmAmount);

    }

    const txHash = tx.transaction_id?.hash
        ?? tx.txHash
        ?? tx.hash
        ?? null;

    return {
        sender,
        destination,
        comment,
        amountGram,
        txHash,
        lt: tx.transaction_id?.lt ?? tx.lt ?? null,
        raw: tx
    };

}

/**
 * P6.6 — Observes TON deposits for one Game Contract escrow.
 * Reports events only; never mutates gameplay.
 */
export class BlockchainMonitor {

    constructor({
        logger,
        eventBus,
        transport,
        auditLedger = null,
        pollIntervalMs = 2000,
        emitEvent = null,
        eventTypes = null
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._transport = transport;

        this._auditLedger = auditLedger;

        this._pollIntervalMs = pollIntervalMs;

        this._emitEvent = emitEvent;

        this._eventTypes = eventTypes ?? {
            PAYMENT_BLOCKCHAIN_CONFIRMED: EVENT_TYPES.PAYMENT_BLOCKCHAIN_CONFIRMED,
            PAYMENT_BLOCKCHAIN_REJECTED: EVENT_TYPES.PAYMENT_BLOCKCHAIN_REJECTED
        };

        // watchKey → watch descriptor
        this._watches = new Map();

        // roomId → Set(txHash) already processed
        this._seenTxByRoom = new Map();

        // roomId → Set(paymentReference) already confirmed
        this._confirmedRefsByRoom = new Map();

        this._timers = new Map();

        this._initialized = false;

    }

    initialize() {

        this._initialized = true;

    }

    shutdown() {

        for (const roomId of [...this._timers.keys()]) {

            this.stopRoom(roomId);

        }

        this._watches.clear();

        this._seenTxByRoom.clear();

        this._confirmedRefsByRoom.clear();

        this._initialized = false;

    }

    /**
     * Watch one player's expected deposit into the game escrow.
     */
    watchPayment({
        roomId,
        gameId,
        playerId,
        contractAddress,
        paymentReference,
        expectedGram,
        expectedWallet,
        paymentDeadline = null
    }) {

        if (!this._initialized) {

            throw new Error("BlockchainMonitor is not initialized");

        }

        const key = this._watchKey(roomId, playerId);

        this._watches.set(key, {
            roomId,
            gameId,
            playerId,
            contractAddress: canonicalizeTonWalletAddress(contractAddress)
                ?? contractAddress,
            paymentReference,
            expectedGram: Number(expectedGram),
            expectedWallet: canonicalizeTonWalletAddress(expectedWallet),
            paymentDeadline,
            startedAt: Date.now()
        });

        this._ensurePoll(roomId);

        this._audit(roomId, {
            type: "WATCH_STARTED",
            gameId,
            playerId,
            contractAddress,
            paymentReference,
            expectedGram,
            expectedWallet
        });

        return key;

    }

    unwatchPayment(roomId, playerId) {

        const key = this._watchKey(roomId, playerId);

        this._watches.delete(key);

        const remaining = [...this._watches.values()].some(
            (watch) => watch.roomId === roomId
        );

        if (!remaining) {

            this._clearPoll(roomId);

        }

    }

    stopRoom(roomId) {

        for (const [key, watch] of [...this._watches.entries()]) {

            if (watch.roomId === roomId) {

                this._watches.delete(key);

            }

        }

        this._clearPoll(roomId);

        this._seenTxByRoom.delete(roomId);

        this._confirmedRefsByRoom.delete(roomId);

        // P6.7 — audit trail is immutable; do not clear on watch stop.

    }

    /**
     * Test / push path: ingest one transport transaction for a room contract.
     */
    async ingestTransaction(roomId, tx) {

        const watches = [...this._watches.values()].filter(
            (watch) => watch.roomId === roomId
        );

        const deposit = parseDepositCandidate(tx);

        const txHash = deposit?.txHash ? String(deposit.txHash) : null;

        if (txHash) {

            const seen = this._seenTxByRoom.get(roomId) ?? new Set();

            if (seen.has(txHash)) {

                this._audit(roomId, {
                    type: "DUPLICATE_PAYMENT",
                    txHash,
                    sender: deposit?.sender ?? null,
                    amount: deposit?.amountGram ?? null,
                    reason: "duplicate_payment"
                });

                return;

            }

        }

        if (watches.length === 0) {

            return;

        }

        await this._evaluateTransaction(watches[0].contractAddress, tx, watches);

    }

    _ensurePoll(roomId) {

        if (this._timers.has(roomId)) {

            return;

        }

        const timerId = setInterval(() => {

            void this._pollRoom(roomId);

        }, this._pollIntervalMs);

        this._timers.set(roomId, timerId);

        void this._pollRoom(roomId);

    }

    _clearPoll(roomId) {

        const timerId = this._timers.get(roomId);

        if (timerId) {

            clearInterval(timerId);

            this._timers.delete(roomId);

        }

    }

    async _pollRoom(roomId) {

        const watches = [...this._watches.values()].filter(
            (watch) => watch.roomId === roomId
        );

        if (watches.length === 0) {

            this._clearPoll(roomId);

            return;

        }

        const contractAddress = watches[0].contractAddress;

        let transactions = [];

        try {

            transactions = await this._transport.getTransactions(
                contractAddress,
                { limit: 30 }
            );

        } catch (error) {

            this._logger?.warn?.(
                `BlockchainMonitor poll failed | roomId=${roomId} | `
                    + `${error?.message ?? error}`
            );

            return;

        }

        for (const tx of transactions ?? []) {

            await this._evaluateTransaction(contractAddress, tx, watches);

        }

        const now = Date.now();

        for (const watch of watches) {

            if (
                Number.isFinite(watch.paymentDeadline)
                && now > watch.paymentDeadline
            ) {

                this._audit(roomId, {
                    type: "PAYMENT_EXPIRED",
                    playerId: watch.playerId,
                    paymentReference: watch.paymentReference,
                    reason: "expired_payment"
                });

                this._emit("PAYMENT_BLOCKCHAIN_REJECTED", {
                    roomId,
                    gameId: watch.gameId,
                    playerId: watch.playerId,
                    reason: "expired_payment"
                });

                this.unwatchPayment(roomId, watch.playerId);

            }

        }

    }

    async _evaluateTransaction(contractAddress, tx, watches) {

        const deposit = parseDepositCandidate(tx);

        if (!deposit) {

            return;

        }

        const roomId = watches[0]?.roomId;

        const txHash = deposit.txHash
            ? String(deposit.txHash)
            : null;

        if (txHash && roomId) {

            const seen = this._seenTxByRoom.get(roomId) ?? new Set();

            if (seen.has(txHash)) {

                this._audit(roomId, {
                    type: "DUPLICATE_PAYMENT",
                    txHash,
                    sender: deposit.sender,
                    amount: deposit.amountGram,
                    reason: "duplicate_payment"
                });

                return;

            }

        }

        const destination = canonicalizeTonWalletAddress(deposit.destination)
            ?? deposit.destination;

        const normalizedContract = canonicalizeTonWalletAddress(contractAddress)
            ?? contractAddress;

        if (
            destination
            && normalizedContract
            && destination !== normalizedContract
        ) {

            this._markSeen(roomId, txHash);

            this._audit(roomId, {
                type: "INVALID_PAYMENT",
                txHash,
                reason: "wrong_contract",
                sender: deposit.sender,
                amount: deposit.amountGram
            });

            return;

        }

        const matchingWatch = watches.find((watch) => (
            Boolean(deposit.comment?.includes(watch.paymentReference))
        ));

        if (!matchingWatch) {

            const confirmedRefs = this._confirmedRefsByRoom.get(roomId) ?? new Set();

            const duplicateRef = [...confirmedRefs].find(
                (reference) => deposit.comment?.includes(reference)
            );

            this._markSeen(roomId, txHash);

            if (duplicateRef) {

                this._audit(roomId, {
                    type: "DUPLICATE_PAYMENT",
                    txHash,
                    paymentReference: duplicateRef,
                    sender: deposit.sender,
                    amount: deposit.amountGram,
                    reason: "duplicate_payment"
                });

                return;

            }

            this._audit(roomId, {
                type: "INVALID_PAYMENT",
                txHash,
                reason: "unknown_payment_reference",
                sender: deposit.sender,
                amount: deposit.amountGram,
                comment: deposit.comment
            });

            return;

        }

        if (
            matchingWatch.expectedWallet
            && deposit.sender
            && deposit.sender !== matchingWatch.expectedWallet
        ) {

            this._markSeen(roomId, txHash);

            this._audit(roomId, {
                type: "INVALID_PAYMENT",
                txHash,
                playerId: matchingWatch.playerId,
                reason: "wrong_sender",
                sender: deposit.sender,
                expectedWallet: matchingWatch.expectedWallet,
                amount: deposit.amountGram
            });

            this._emit("PAYMENT_BLOCKCHAIN_REJECTED", {
                roomId,
                gameId: matchingWatch.gameId,
                playerId: matchingWatch.playerId,
                reason: "wrong_sender",
                txHash
            });

            return;

        }

        if (!amountsMatch(matchingWatch.expectedGram, deposit.amountGram)) {

            this._markSeen(roomId, txHash);

            this._audit(roomId, {
                type: "INVALID_PAYMENT",
                txHash,
                playerId: matchingWatch.playerId,
                reason: "insufficient_amount",
                sender: deposit.sender,
                amount: deposit.amountGram,
                expectedGram: matchingWatch.expectedGram
            });

            this._emit("PAYMENT_BLOCKCHAIN_REJECTED", {
                roomId,
                gameId: matchingWatch.gameId,
                playerId: matchingWatch.playerId,
                reason: "insufficient_amount",
                txHash
            });

            return;

        }

        this._markSeen(roomId, txHash);

        const confirmedRefs = this._confirmedRefsByRoom.get(roomId) ?? new Set();

        confirmedRefs.add(matchingWatch.paymentReference);

        this._confirmedRefsByRoom.set(roomId, confirmedRefs);

        this._audit(roomId, {
            type: "PAYMENT_CONFIRMED",
            txHash,
            playerId: matchingWatch.playerId,
            sender: deposit.sender,
            amount: deposit.amountGram,
            paymentReference: matchingWatch.paymentReference,
            contractAddress: matchingWatch.contractAddress,
            confirmationTime: Date.now()
        });

        this._emit("PAYMENT_BLOCKCHAIN_CONFIRMED", {
            roomId,
            gameId: matchingWatch.gameId,
            playerId: matchingWatch.playerId,
            txHash,
            sender: deposit.sender,
            amount: deposit.amountGram,
            paymentReference: matchingWatch.paymentReference,
            contractAddress: matchingWatch.contractAddress,
            confirmedAt: Date.now()
        });

        this.unwatchPayment(roomId, matchingWatch.playerId);

    }

    _markSeen(roomId, txHash) {

        if (!roomId || !txHash) {

            return;

        }

        const seen = this._seenTxByRoom.get(roomId) ?? new Set();

        seen.add(String(txHash));

        this._seenTxByRoom.set(roomId, seen);

    }

    _watchKey(roomId, playerId) {

        return `${roomId}::${playerId}`;

    }

    _audit(roomId, entry) {

        if (!roomId) {

            return;

        }

        this._auditLedger?.append(roomId, entry);

    }

    _emit(typeName, payload) {

        const type = this._eventTypes?.[typeName] ?? typeName;

        if (this._emitEvent) {

            this._emitEvent(type, payload);

            return;

        }

        if (this._eventBus) {

            this._eventBus.emit({
                source: EVENT_SOURCES.BLOCKCHAIN_MONITOR,
                type,
                payload
            });

        }

    }

}
