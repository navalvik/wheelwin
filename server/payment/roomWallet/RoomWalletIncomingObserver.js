/**
 * Room Wallet incoming payment observation and attribution.
 *
 * Discovers inbound TON transfers to configured Room Wallet addresses,
 * attributes them to exactly one in-progress payment-session participant,
 * and feeds the existing PAYMENT_TRANSACTION_DETECTED /
 * PAYMENT_TRANSACTION_CONFIRMED lifecycle.
 *
 * Does not replace PaymentSessionManager, BlockchainMonitor, DepositMonitor,
 * GameEscrow, or Room Wallet settlement.
 */

import { EVENT_SOURCES } from "../../events/EventSources.js";
import { EVENT_TYPES } from "../../events/EventTypes.js";
import { canonicalizeTonWalletAddress } from "../../models/TonWalletAddress.js";
import {
    amountsMatch,
    isFailedTonTransaction,
    parseDepositCandidate
} from "../BlockchainMonitor.js";
import { PAYMENT_PARTICIPANT_STATUS } from "../../models/PaymentSession.js";
import {
    DuplicateRecordError,
    RecordNotFoundError
} from "../../persistence/TonFinancialPersistenceErrors.js";
import { tryNormalizeRoomNumber } from "./RoomWalletRegistry.js";

export const ROOM_WALLET_INCOMING_TX_PAGE_LIMIT = 32;

export const ROOM_WALLET_INCOMING_OBSERVATION_PREFIX = "rwin";

export const ROOM_WALLET_INCOMING_REJECTION_REASONS = Object.freeze({
    MALFORMED_TRANSACTION: "malformed_transaction",
    MISSING_SENDER: "missing_sender",
    MISSING_DESTINATION: "missing_destination",
    MISSING_TRANSACTION_HASH: "missing_transaction_hash",
    INVALID_AMOUNT: "invalid_amount",
    FAILED_TRANSACTION: "failed_transaction",
    WRONG_DESTINATION: "wrong_destination",
    UNKNOWN_SENDER: "unknown_sender",
    AMBIGUOUS_ATTRIBUTION: "ambiguous_attribution",
    WRONG_AMOUNT: "wrong_amount",
    EXPIRED_PAYMENT_CONTEXT: "expired_payment_context",
    DUPLICATE_TRANSACTION: "duplicate_transaction",
    PERSISTENCE_UNAVAILABLE: "persistence_unavailable",
    PERSISTENCE_FAILURE: "persistence_failure",
    TRANSPORT_FAILURE: "transport_failure"
});

export const ROOM_WALLET_INCOMING_STATUS = Object.freeze({
    ACCEPTED: "ACCEPTED",
    REJECTED: "REJECTED"
});

/**
 * parseDepositCandidate converts TonCenter nanotons to Gram via / 1e9
 * unless the inbound message is already tagged as Gram.
 * This helper makes that convention explicit for tests.
 */
export function nanotonToGram(nanoton) {
    const value = Number(nanoton);

    if (!Number.isFinite(value)) {
        return null;
    }

    return value / 1e9;
}

export function buildRoomWalletIncomingObservationId(destination, transactionHash) {
    const dest = canonicalizeTonWalletAddress(destination) ?? String(destination ?? "").trim();
    const hash = String(transactionHash ?? "").trim();

    if (!dest || !hash) {
        return null;
    }

    return `${ROOM_WALLET_INCOMING_OBSERVATION_PREFIX}__${dest}__${hash}`;
}

export function resolveAuthoritativeRoomNumber({
    roomNumber = null,
    roomId = null,
    roomManager = null,
    session = null
} = {}) {
    const explicit = tryNormalizeRoomNumber(roomNumber)
        ?? tryNormalizeRoomNumber(session?.roomNumber);

    if (explicit != null) {
        return explicit;
    }

    if (!roomManager || roomId == null || roomId === "") {
        return null;
    }

    if (typeof roomManager.resolveRoomNumber === "function") {
        const resolved = tryNormalizeRoomNumber(roomManager.resolveRoomNumber(roomId));

        if (resolved != null) {
            return resolved;
        }
    }

    const room = typeof roomManager.getRoom === "function"
        ? roomManager.getRoom(roomId)
        : null;

    return tryNormalizeRoomNumber(room?.roomNumber);
}

export function resolveIntendedRoomWalletAddress(context, registry) {
    if (!registry) {
        return null;
    }

    const identity = context && typeof context === "object" && !Array.isArray(context)
        ? context
        : { roomId: context };

    const roomNumber = resolveAuthoritativeRoomNumber(identity);

    if (roomNumber == null) {
        return null;
    }

    const record = typeof registry.get === "function" ? registry.get(roomNumber) : null;

    return canonicalizeTonWalletAddress(record?.address) ?? record?.address ?? null;
}

export function listConfiguredRoomWalletAddresses(registry) {
    const listed = typeof registry?.list === "function" ? registry.list() : [];
    const addresses = [];
    const seen = new Set();

    for (const entry of listed) {
        const canonical = canonicalizeTonWalletAddress(entry?.address) ?? String(entry?.address ?? "").trim();

        if (!canonical || seen.has(canonical)) {
            continue;
        }

        seen.add(canonical);
        addresses.push(canonical);
    }

    return Object.freeze(addresses);
}

export class RoomWalletIncomingObserver {
    constructor({
        logger = null,
        eventBus = null,
        paymentSessionManager = null,
        financialPersistence = null,
        registry = null,
        roomManager = null,
        transport = null,
        tonService = null,
        auditLedger = null,
        network = null,
        now = () => Date.now()
    } = {}) {
        this._logger = logger;
        this._eventBus = eventBus;
        this._paymentSessionManager = paymentSessionManager;
        this._financialPersistence = financialPersistence;
        this._registry = registry;
        this._roomManager = roomManager;
        this._transport = transport;
        this._tonService = tonService;
        this._auditLedger = auditLedger;
        this._network = network;
        this._now = now;
        this._stopped = false;
    }

    stop() {
        this._stopped = true;
    }

    shutdown() {
        this.stop();
    }

    async poll() {
        if (this._stopped) {
            return Object.freeze({ polled: 0, processed: 0 });
        }

        const addresses = listConfiguredRoomWalletAddresses(this._registry);

        if (addresses.length === 0) {
            return Object.freeze({ polled: 0, processed: 0 });
        }

        let processed = 0;

        for (const address of addresses) {
            let transactions;

            try {
                transactions = await this._fetchTransactions(address);
            } catch (error) {
                this._log(
                    "error",
                    `Room Wallet incoming transport failure | address=${address} | `
                        + `${error?.message ?? error}`
                );
                continue;
            }

            for (const tx of transactions ?? []) {
                this.processTransaction(tx, address);
                processed += 1;
            }
        }

        return Object.freeze({
            polled: addresses.length,
            processed
        });
    }

    processTransaction(tx, watchedAddress = null) {
        if (this._stopped) {
            return this._result(ROOM_WALLET_INCOMING_REJECTION_REASONS.MALFORMED_TRANSACTION, {
                credited: false
            });
        }

        if (isFailedTonTransaction(tx)) {
            return this._rejectTransient(
                ROOM_WALLET_INCOMING_REJECTION_REASONS.FAILED_TRANSACTION,
                { tx }
            );
        }

        const deposit = parseDepositCandidate(tx);

        if (!deposit) {
            return this._rejectTransient(
                ROOM_WALLET_INCOMING_REJECTION_REASONS.MALFORMED_TRANSACTION,
                { tx }
            );
        }

        const destination = canonicalizeTonWalletAddress(deposit.destination)
            ?? canonicalizeTonWalletAddress(watchedAddress);
        const sender = canonicalizeTonWalletAddress(deposit.sender);
        const txHash = typeof deposit.txHash === "string" && deposit.txHash.trim()
            ? deposit.txHash.trim()
            : null;
        const amountGram = Number.isFinite(Number(deposit.amountGram))
            ? Number(deposit.amountGram)
            : null;

        if (!txHash) {
            return this._rejectTransient(
                ROOM_WALLET_INCOMING_REJECTION_REASONS.MISSING_TRANSACTION_HASH,
                { deposit }
            );
        }

        if (!destination) {
            return this._rejectTransient(
                ROOM_WALLET_INCOMING_REJECTION_REASONS.MISSING_DESTINATION,
                { deposit, txHash }
            );
        }

        if (!sender) {
            return this._rejectTransient(
                ROOM_WALLET_INCOMING_REJECTION_REASONS.MISSING_SENDER,
                { deposit, txHash, destination }
            );
        }

        if (amountGram == null || amountGram <= 0) {
            return this._rejectTransient(
                ROOM_WALLET_INCOMING_REJECTION_REASONS.INVALID_AMOUNT,
                { deposit, txHash, destination, sender }
            );
        }

        const watchedCanonical = canonicalizeTonWalletAddress(watchedAddress);

        if (watchedCanonical && destination !== watchedCanonical) {
            return this._rejectTerminal(
                ROOM_WALLET_INCOMING_REJECTION_REASONS.WRONG_DESTINATION,
                {
                    destination,
                    sender,
                    txHash,
                    amountGram,
                    comment: deposit.comment,
                    lt: deposit.lt
                }
            );
        }

        const configured = listConfiguredRoomWalletAddresses(this._registry);

        if (!configured.includes(destination)) {
            return this._rejectTerminal(
                ROOM_WALLET_INCOMING_REJECTION_REASONS.WRONG_DESTINATION,
                {
                    destination,
                    sender,
                    txHash,
                    amountGram,
                    comment: deposit.comment,
                    lt: deposit.lt
                }
            );
        }

        const observationId = buildRoomWalletIncomingObservationId(destination, txHash);

        if (this._hasObservation(observationId)) {
            return this._result(ROOM_WALLET_INCOMING_REJECTION_REASONS.DUPLICATE_TRANSACTION, {
                credited: false,
                observationId,
                txHash,
                destination,
                duplicate: true
            });
        }

        const attribution = this._attribute(destination, sender);

        if (attribution.reason === ROOM_WALLET_INCOMING_REJECTION_REASONS.UNKNOWN_SENDER) {
            return this._rejectTransient(
                ROOM_WALLET_INCOMING_REJECTION_REASONS.UNKNOWN_SENDER,
                { destination, sender, txHash, amountGram }
            );
        }

        if (attribution.reason) {
            return this._rejectTerminal(attribution.reason, {
                destination,
                sender,
                txHash,
                amountGram,
                comment: deposit.comment,
                lt: deposit.lt,
                roomId: attribution.roomId ?? null,
                gameId: attribution.gameId ?? null,
                playerId: attribution.playerId ?? null,
                matches: attribution.matches ?? null
            });
        }

        const { session, participant } = attribution;

        if (!amountsMatch(participant.requiredGram, amountGram)) {
            return this._rejectTerminal(
                ROOM_WALLET_INCOMING_REJECTION_REASONS.WRONG_AMOUNT,
                {
                    destination,
                    sender,
                    txHash,
                    amountGram,
                    expectedGram: participant.requiredGram,
                    comment: deposit.comment,
                    lt: deposit.lt,
                    roomId: session.roomId,
                    roomNumber: session.roomNumber ?? null,
                    gameId: session.gameId,
                    playerId: participant.playerId,
                    paymentReference: participant.paymentReference,
                    paymentSessionId: session.paymentSessionId
                }
            );
        }

        const accepted = this._persistObservation({
            observationId,
            status: ROOM_WALLET_INCOMING_STATUS.ACCEPTED,
            destination,
            sender,
            txHash,
            amountGram,
            expectedGram: participant.requiredGram,
            comment: deposit.comment,
            lt: deposit.lt,
            roomId: session.roomId,
            roomNumber: session.roomNumber ?? null,
            gameId: session.gameId,
            playerId: participant.playerId,
            paymentReference: participant.paymentReference,
            paymentSessionId: session.paymentSessionId,
            walletSessionId: participant.walletSessionId
        });

        if (accepted.duplicate) {
            return this._result(ROOM_WALLET_INCOMING_REJECTION_REASONS.DUPLICATE_TRANSACTION, {
                credited: false,
                observationId,
                txHash,
                destination,
                duplicate: true
            });
        }

        if (!accepted.ok) {
            return this._result(accepted.reason, {
                credited: false,
                observationId,
                txHash,
                destination
            });
        }

        const payload = this._paymentPayload({
            session,
            participant,
            destination,
            sender,
            txHash,
            amountGram,
            comment: deposit.comment,
            lt: deposit.lt
        });

        this._audit(session.roomId, {
            type: "ROOM_WALLET_PAYMENT_CONFIRMED",
            txHash,
            playerId: participant.playerId,
            sender,
            amount: amountGram,
            destination,
            paymentReference: participant.paymentReference
        });

        this._emit(EVENT_TYPES.PAYMENT_TRANSACTION_DETECTED, payload, `rwin-detected:${txHash}`);
        this._emit(EVENT_TYPES.PAYMENT_TRANSACTION_CONFIRMED, payload, `rwin-confirmed:${txHash}`);

        this._log(
            "info",
            `Room Wallet incoming payment credited | roomId=${session.roomId} | `
                + `gameId=${session.gameId} | playerId=${participant.playerId} | tx=${txHash}`
        );

        return this._result(null, {
            credited: true,
            observationId,
            txHash,
            destination,
            roomId: session.roomId,
            roomNumber: session.roomNumber ?? null,
            gameId: session.gameId,
            playerId: participant.playerId
        });
    }

    _attribute(destination, sender) {
        const sessions = this._listInProgressSessions();
        const senderMatches = [];
        const destMatches = [];
        const expiredMatches = [];
        const now = this._now();

        for (const session of sessions) {
            const intended = resolveIntendedRoomWalletAddress({
                roomId: session.roomId,
                roomNumber: session.roomNumber,
                roomManager: this._roomManager,
                session
            }, this._registry);

            for (const participant of session.participants ?? []) {
                const wallet = canonicalizeTonWalletAddress(participant.wallet);

                if (!wallet || wallet !== sender) {
                    continue;
                }

                if (participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED) {
                    continue;
                }

                const match = { session, participant, intended };

                senderMatches.push(match);

                if (intended && intended === destination) {
                    if (session.paymentDeadline && now > session.paymentDeadline) {
                        expiredMatches.push(match);
                    } else {
                        destMatches.push(match);
                    }
                }
            }
        }

        if (destMatches.length === 1) {
            return destMatches[0];
        }

        if (destMatches.length > 1) {
            return {
                reason: ROOM_WALLET_INCOMING_REJECTION_REASONS.AMBIGUOUS_ATTRIBUTION,
                matches: destMatches.map((match) => ({
                    roomId: match.session.roomId,
                    roomNumber: match.session.roomNumber ?? null,
                    gameId: match.session.gameId,
                    playerId: match.participant.playerId
                }))
            };
        }

        if (expiredMatches.length > 0 && destMatches.length === 0) {
            const first = expiredMatches[0];
            return {
                reason: ROOM_WALLET_INCOMING_REJECTION_REASONS.EXPIRED_PAYMENT_CONTEXT,
                roomId: first.session.roomId,
                gameId: first.session.gameId,
                playerId: first.participant.playerId
            };
        }

        if (senderMatches.length > 0) {
            const first = senderMatches[0];
            return {
                reason: ROOM_WALLET_INCOMING_REJECTION_REASONS.WRONG_DESTINATION,
                roomId: first.session.roomId,
                gameId: first.session.gameId,
                playerId: first.participant.playerId
            };
        }

        return {
            reason: ROOM_WALLET_INCOMING_REJECTION_REASONS.UNKNOWN_SENDER
        };
    }

    _listInProgressSessions() {
        const manager = this._paymentSessionManager;

        if (!manager || typeof manager.listSessionRoomIds !== "function") {
            return [];
        }

        const sessions = [];

        for (const roomId of manager.listSessionRoomIds()) {
            const session = manager.getSession(roomId);

            if (session && typeof session.isInProgress === "function" && session.isInProgress()) {
                sessions.push(session);
            }
        }

        return sessions;
    }

    _paymentPayload({
        session,
        participant,
        destination,
        sender,
        txHash,
        amountGram,
        comment,
        lt
    }) {
        return {
            transactionId: txHash,
            txHash,
            roomWalletAddress: destination,
            destination,
            network: session.network ?? this._network,
            timestamp: this._now(),
            correlationId: session.correlationId ?? null,
            roomId: session.roomId,
            roomNumber: session.roomNumber ?? null,
            gameId: session.gameId,
            playerId: participant.playerId,
            paymentReference: participant.paymentReference,
            walletSessionId: participant.walletSessionId,
            amount: amountGram,
            amountGram,
            expectedGram: participant.requiredGram,
            sender,
            lt,
            comment: comment ?? ""
        };
    }

    _hasObservation(observationId) {
        if (!observationId || !this._financialPersistence) {
            return false;
        }

        try {
            this._financialPersistence.loadAuditRecord(observationId);
            return true;
        } catch (error) {
            if (error instanceof RecordNotFoundError || error?.name === "RecordNotFoundError") {
                return false;
            }

            throw error;
        }
    }

    _persistObservation(fields) {
        if (!this._financialPersistence) {
            this._log(
                "error",
                `Room Wallet incoming persistence unavailable | tx=${fields.txHash}`
            );
            return {
                ok: false,
                reason: ROOM_WALLET_INCOMING_REJECTION_REASONS.PERSISTENCE_UNAVAILABLE
            };
        }

        try {
            this._financialPersistence.createAuditRecord(
                {
                    kind: "ROOM_WALLET_INCOMING_OBSERVATION",
                    observationId: fields.observationId,
                    destination: fields.destination,
                    sender: fields.sender,
                    amountGram: fields.amountGram,
                    expectedGram: fields.expectedGram ?? null,
                    transactionHash: fields.txHash,
                    lt: fields.lt ?? null,
                    comment: fields.comment ?? "",
                    status: fields.status,
                    rejectionReason: fields.rejectionReason ?? null,
                    roomId: fields.roomId ?? null,
                    roomNumber: fields.roomNumber ?? null,
                    gameId: fields.gameId ?? null,
                    playerId: fields.playerId ?? null,
                    paymentReference: fields.paymentReference ?? null,
                    paymentSessionId: fields.paymentSessionId ?? null,
                    walletSessionId: fields.walletSessionId ?? null
                },
                {
                    auditId: fields.observationId,
                    roomId: fields.roomId ?? null,
                    roomNumber: fields.roomNumber ?? null,
                    gameId: fields.gameId ?? null,
                    status: fields.status,
                    tonNetwork: this._network
                }
            );

            return { ok: true, duplicate: false };
        } catch (error) {
            if (error instanceof DuplicateRecordError || error?.name === "DuplicateRecordError") {
                return { ok: false, duplicate: true };
            }

            this._log(
                "error",
                `Room Wallet incoming persistence failure | tx=${fields.txHash} | `
                    + `${error?.message ?? error}`
            );

            return {
                ok: false,
                reason: ROOM_WALLET_INCOMING_REJECTION_REASONS.PERSISTENCE_FAILURE
            };
        }
    }

    _rejectTransient(reason, extra = {}) {
        this._log("warn", `Room Wallet incoming rejected | reason=${reason}`);
        return this._result(reason, { credited: false, ...extra });
    }

    _rejectTerminal(reason, fields) {
        const observationId = buildRoomWalletIncomingObservationId(
            fields.destination,
            fields.txHash
        );

        if (observationId && !this._hasObservation(observationId)) {
            const persisted = this._persistObservation({
                ...fields,
                observationId,
                status: ROOM_WALLET_INCOMING_STATUS.REJECTED,
                rejectionReason: reason
            });

            if (persisted.reason === ROOM_WALLET_INCOMING_REJECTION_REASONS.PERSISTENCE_FAILURE) {
                return this._result(persisted.reason, {
                    credited: false,
                    observationId,
                    txHash: fields.txHash
                });
            }
        }

        if (fields.roomId && fields.playerId) {
            this._emit(EVENT_TYPES.PAYMENT_BLOCKCHAIN_REJECTED, {
                roomId: fields.roomId,
                gameId: fields.gameId ?? null,
                playerId: fields.playerId,
                reason,
                txHash: fields.txHash,
                sender: fields.sender ?? null,
                amount: fields.amountGram ?? null
            });
        }

        this._audit(fields.roomId, {
            type: "ROOM_WALLET_PAYMENT_REJECTED",
            txHash: fields.txHash,
            reason,
            sender: fields.sender,
            amount: fields.amountGram,
            destination: fields.destination,
            playerId: fields.playerId ?? null
        });

        this._log("warn", `Room Wallet incoming rejected | reason=${reason} | tx=${fields.txHash}`);

        return this._result(reason, {
            credited: false,
            observationId,
            txHash: fields.txHash,
            destination: fields.destination,
            roomId: fields.roomId ?? null,
            playerId: fields.playerId ?? null
        });
    }

    async _fetchTransactions(address) {
        const query = {
            limit: ROOM_WALLET_INCOMING_TX_PAGE_LIMIT,
            archival: true
        };

        if (this._tonService?.getTransactions) {
            return this._tonService.getTransactions(address, query);
        }

        if (this._transport?.getTransactions) {
            return this._transport.getTransactions(address, query);
        }

        throw new Error("No TON transport available");
    }

    _emit(type, payload, _dedupeKey = null) {
        if (!this._eventBus) {
            return;
        }

        this._eventBus.emit({
            source: EVENT_SOURCES.ROOM_WALLET_INCOMING_OBSERVER,
            type,
            payload: {
                network: this._network,
                timestamp: this._now(),
                ...payload
            }
        });
    }

    _audit(roomId, entry) {
        if (!this._auditLedger || !roomId) {
            return;
        }

        this._auditLedger.append(roomId, {
            ...entry,
            recordedAt: this._now()
        });
    }

    _log(level, message) {
        const logger = this._logger;

        if (!logger) {
            return;
        }

        if (typeof logger[level] === "function") {
            logger[level](message);
            return;
        }

        logger.info?.(message);
    }

    _result(reason, extra) {
        return Object.freeze({
            reason,
            ...extra
        });
    }
}
