import { randomUUID } from "node:crypto";

import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_CONTRACT_STATUS } from "../models/GameContract.js";
import {
    PAYMENT_CONFIRMATION_STATUS,
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS,
    PaymentParticipant,
    PaymentSession
} from "../models/PaymentSession.js";
import { amountsMatch } from "../payment/BlockchainMonitor.js";
import { calculateRequiredGram } from "../payment/calculateRequiredGram.js";
import { TON_FINANCIAL_RECORD_TYPES } from "../persistence/TonFinancialPersistence.js";
import { WALLET_SESSION_STATUS } from "../session/WalletSessionStates.js";
import {
    DuplicatePaymentError,
    PaymentSessionAlreadyExistsError,
    PaymentValidationError,
    UnexpectedPaymentError
} from "./PaymentSessionManagerErrors.js";

const DEFAULT_PAYMENT_SESSION_DURATION_MS = 5 * 60 * 1000;

const PAYMENT_READY_CONTRACT_STATUSES = new Set([
    GAME_CONTRACT_STATUS.DEPLOYED,
    GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS
]);

/**
 * P6.3 / T2.7 — Authoritative Payment Session manager.
 *
 * Owns payment orchestration only. Never communicates with TON directly.
 */
export class PaymentSessionManager {

    constructor({
        logger,
        eventBus,
        playerManager,
        roomManager,
        roomConfig = null,
        gameplayContextResolver = null,
        sessionWalletStore = null,
        sessionWalletStoreForWatch = null,
        walletManager = null,
        gameContractManager = null,
        blockchainMonitor = null,
        financialPersistence = null,
        tonNetwork = null,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._playerManager = playerManager;

        this._roomManager = roomManager;

        this._gameplayContextResolver = gameplayContextResolver;

        this._sessionWalletStore = sessionWalletStore
            ?? sessionWalletStoreForWatch;

        this._walletManager = walletManager;

        this._gameContractManager = gameContractManager;

        this._blockchainMonitor = blockchainMonitor;

        this._financialPersistence = financialPersistence;

        this._tonNetwork = tonNetwork ?? null;

        this._durationMs = Number.isFinite(roomConfig?.paymentSessionDurationMs)
            && roomConfig.paymentSessionDurationMs > 0
            ? roomConfig.paymentSessionDurationMs
            : DEFAULT_PAYMENT_SESSION_DURATION_MS;

        this._devMode = devMode;

        this._sessionsByRoom = new Map();

        this._roomByGameId = new Map();

        this._expiryTimers = new Map();

        this._confirmedTxHashes = new Set();

        this._lastConfirmationAt = null;

        this._handlers = [];

        this._initialized = false;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.PAYMENT_CONNECTION_READY,
            (envelope) => this._handlePaymentConnectionReady(envelope.payload)
        );

        this._subscribe(
            EVENT_TYPES.GAME_CONTRACT_READY_FOR_PAYMENTS,
            (envelope) => this._handleContractReadyForPayments(envelope.payload)
        );

        this._subscribe(
            EVENT_TYPES.CONTRACT_DEPLOYMENT_CONFIRMED,
            (envelope) => this._handleContractDeploymentConfirmed(envelope.payload)
        );

        this._subscribe(
            EVENT_TYPES.GAME_CONTRACT_DEPLOY_FAILED,
            (envelope) => {
                this.failSession(
                    envelope.payload?.roomId,
                    envelope.payload?.reason ?? "deploy_failed"
                );
            }
        );

        this._subscribe(
            EVENT_TYPES.PAYMENT_TRANSACTION_DETECTED,
            (envelope) => this._handlePaymentTransactionDetected(envelope.payload)
        );

        this._subscribe(
            EVENT_TYPES.PAYMENT_TRANSACTION_CONFIRMED,
            (envelope) => this._handlePaymentTransactionConfirmed(envelope.payload)
        );

        this._subscribe(
            EVENT_TYPES.TRANSACTION_FAILED,
            (envelope) => this._handleTransactionFailed(envelope.payload)
        );

        this._subscribe(
            EVENT_TYPES.PAYMENT_BLOCKCHAIN_CONFIRMED,
            (envelope) => this._handleBlockchainConfirmed(envelope.payload)
        );

        this._subscribe(
            EVENT_TYPES.PAYMENT_BLOCKCHAIN_REJECTED,
            (envelope) => this._handleBlockchainRejected(envelope.payload)
        );

        this._subscribe(
            EVENT_TYPES.ROOM_DESTROYED,
            (envelope) => this.destroySession(envelope.payload?.roomId)
        );

        this._subscribe(
            EVENT_TYPES.SESSION_FINISHED,
            (envelope) => this.destroySession(envelope.payload?.roomId)
        );

        this._subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            () => this._reset()
        );

        this._initialized = true;

    }

    shutdown() {

        this._reset();

        for (const subscription of this._handlers) {

            this._eventBus.unsubscribe(subscription.event, subscription.handler);

        }

        this._handlers = [];

        this._initialized = false;

    }

    getSession(roomId) {

        return this._sessionsByRoom.get(roomId) ?? null;

    }

    listSessionRoomIds() {

        return [...this._sessionsByRoom.keys()];

    }

    getActiveSessionCount() {

        let count = 0;

        for (const session of this._sessionsByRoom.values()) {

            if (session.isInProgress()) {

                count += 1;

            }

        }

        return count;

    }

    getSessionByGameId(gameId) {

        if (!gameId) {

            return null;

        }

        const roomId = this._roomByGameId.get(gameId);

        return roomId ? this.getSession(roomId) : null;

    }

    getDurationMs() {

        return this._durationMs;

    }

    /**
     * T2.7 — Authoritative payment session creation.
     */
    createPaymentSession(roomId, {
        gameId = null,
        contractId = null,
        contractAddress = null,
        network = null,
        paymentDeadline = null,
        correlationId = null
    } = {}) {

        this._assertInitialized();

            if (!roomId) {

                throw new PaymentValidationError("roomId is required");

            }

            if (this._sessionsByRoom.has(roomId)) {

                throw new PaymentSessionAlreadyExistsError(roomId, gameId);

            }

            const room = this._roomManager.getRoom(roomId);

            if (!room) {

                throw new PaymentValidationError(`Room not found | roomId=${roomId}`);

            }

            const resolvedGameId = gameId
                ?? this._gameplayContextResolver?.resolveGameIdByRoomId?.(roomId)
                ?? null;

            if (!resolvedGameId) {

                throw new PaymentValidationError(`Game not found | roomId=${roomId}`);

            }

            if (this._roomByGameId.has(resolvedGameId)) {

                throw new PaymentSessionAlreadyExistsError(roomId, resolvedGameId);

            }

            const contract = this._resolveContract(roomId, contractId);

            if (contract) {

                this._assertContractReadyForPayments(contract);

                if (contract.gameStartedAt != null) {

                    throw new PaymentValidationError(
                        "Cannot create payment session after game started",
                        { roomId, gameId: resolvedGameId }
                    );

                }

            }

            const createdAt = Date.now();

            const deadline = paymentDeadline ?? createdAt + this._durationMs;

            const activeNetwork = network
                ?? contract?.tonNetwork
                ?? this._tonNetwork
                ?? null;

            const participants = [];
            const walletSessions = [];

            for (const playerId of room.players) {

                const identity = this._playerManager.getIdentity(playerId);

                const requiredGram = calculateRequiredGram(
                    identity?.baseStake,
                    identity?.sectorCount ?? 1
                );

                const walletSession = this._resolveWalletSession(roomId, playerId);

                if (walletSession && walletSession.status !== WALLET_SESSION_STATUS.VERIFIED) {

                    throw new PaymentValidationError(
                        `Wallet not verified | playerId=${playerId}`,
                        { playerId, walletStatus: walletSession.status }
                    );

                }

                const walletAddress = walletSession?.walletAddress
                    ?? this._sessionWalletStore?.getWallet?.(roomId, playerId)
                    ?? null;

                if (!walletAddress) {

                    throw new PaymentValidationError(
                        `Wallet missing | playerId=${playerId}`,
                        { playerId }
                    );

                }

                participants.push(new PaymentParticipant({
                    playerId,
                    requiredGram: requiredGram ?? 0,
                    wallet: walletAddress,
                    walletSessionId: walletSession?.walletSessionId ?? null,
                    status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED
                }));

                walletSessions.push(Object.freeze({
                    playerId,
                    walletSessionId: walletSession?.walletSessionId ?? null,
                    walletAddress,
                    status: walletSession?.status ?? WALLET_SESSION_STATUS.VERIFIED
                }));

            }

            const session = new PaymentSession({
                paymentSessionId: `pay_${randomUUID()}`,
                roomId,
                gameId: resolvedGameId,
                contractId: contract?.contractId ?? contractId ?? null,
                network: activeNetwork,
                participants,
                walletSessions,
                createdAt,
                updatedAt: createdAt,
                expiresAt: deadline,
                paymentDeadline: deadline,
                status: PAYMENT_SESSION_STATUS.CREATED,
                correlationId: correlationId ?? randomUUID()
            });

            session.transitionTo(PAYMENT_SESSION_STATUS.WAITING_FOR_PAYMENTS);

            this._indexSession(session);

            this._persistSession(session, "create");

            this._scheduleExpiry(session);

            this._emitDomain(EVENT_TYPES.PAYMENT_SESSION_CREATED, session);

            if (contractAddress || contract?.contractAddress) {

                this._activatePaymentRequests(session, {
                    contractAddress: contractAddress ?? contract.contractAddress,
                    paymentDeadline: deadline
                });

            }

            this._log(
                `CREATED | roomId=${roomId} | gameId=${resolvedGameId} | `
                    + `paymentSessionId=${session.paymentSessionId}`
            );

            return session;

    }

    /**
     * P6.3 legacy — idempotent create used by lobby flow.
     */
    createAndRequest(roomId, { gameId = null } = {}) {

        this._assertInitialized();

        if (!roomId) {

            return null;

        }

        if (this._sessionsByRoom.has(roomId)) {

            return this._sessionsByRoom.get(roomId);

        }

        try {

            return this.createPaymentSession(roomId, { gameId });

        } catch (error) {

            if (error instanceof PaymentSessionAlreadyExistsError) {

                return this._sessionsByRoom.get(roomId) ?? null;

            }

            this._logger.error(
                `PaymentSession create failed | roomId=${roomId} | `
                    + `${error?.message ?? error}`
            );

            return null;

        }

    }

    issueDeployedPaymentRequests(roomId, {
        contractAddress,
        paymentDeadline = null
    } = {}) {

        this._assertInitialized();

        const session = this._sessionsByRoom.get(roomId);

        if (!session || !session.isInProgress()) {

            return null;

        }

        if (!contractAddress) {

            return null;

        }

        return this._activatePaymentRequests(session, {
            contractAddress,
            paymentDeadline
        });

    }

    restorePaymentSessions() {

        this._assertInitialized();

        if (!this._financialPersistence) {

            return Object.freeze({
                restored: 0,
                recovered: 0,
                rewatched: 0
            });

        }

        const records = this._financialPersistence.listActive(
            TON_FINANCIAL_RECORD_TYPES.PAYMENT_SESSION
        );

        let restored = 0;

        let recovered = 0;

        let rewatched = 0;

        for (const record of records) {

            try {

                const session = PaymentSession.fromRecord(record);

                if (this._sessionsByRoom.has(session.roomId)) {

                    continue;

                }

                if (session.isTerminal()) {

                    continue;

                }

                if (!session.isInProgress() && session.status !== PAYMENT_SESSION_STATUS.RECOVERED) {

                    session.status = PAYMENT_SESSION_STATUS.RECOVERED;

                }

                if (session.status === PAYMENT_SESSION_STATUS.RECOVERED) {

                    recovered += 1;

                }

                this._indexSession(session);

                if (session.paymentDeadline && session.paymentDeadline > Date.now()) {

                    this._scheduleExpiry(session);

                }

                const contract = this._resolveContract(session.roomId, session.contractId);

                if (contract?.contractAddress && session.isInProgress()) {

                    rewatched += this._registerBlockchainWatches(session, contract.contractAddress);

                }

                this._emitDomain(EVENT_TYPES.PAYMENT_SESSION_RECOVERED, session);

                restored += 1;

            } catch (error) {

                this._logger.error(
                    `PaymentSession restore skipped | id=${record?.recordId} | `
                        + `${error?.message ?? error}`
                );

            }

        }

        this._log(
            `RESTORE | restored=${restored} | recovered=${recovered} | rewatched=${rewatched}`
        );

        return Object.freeze({ restored, recovered, rewatched });

    }

    health() {

        this._assertInitialized();

        let activeSessions = 0;

        let completedSessions = 0;

        let pendingPayments = 0;

        let failedPayments = 0;

        let recoveredSessions = 0;

        for (const session of this._sessionsByRoom.values()) {

            if (session.isInProgress()) {

                activeSessions += 1;

                pendingPayments += session.participants.length - session.confirmedCount();

            }

            if (session.status === PAYMENT_SESSION_STATUS.FULLY_PAID) {

                completedSessions += 1;

            }

            if (
                session.status === PAYMENT_SESSION_STATUS.PAYMENT_FAILED
                || session.status === PAYMENT_SESSION_STATUS.PAYMENT_TIMEOUT
            ) {

                failedPayments += 1;

            }

            if (session.status === PAYMENT_SESSION_STATUS.RECOVERED) {

                recoveredSessions += 1;

            }

        }

        return Object.freeze({
            activeSessions,
            completedSessions,
            pendingPayments,
            failedPayments,
            recoveredSessions,
            lastConfirmation: this._lastConfirmationAt,
            network: this._tonNetwork
        });

    }

    getDashboardSnapshot(roomId = null) {

        this._assertInitialized();

        const sessions = roomId
            ? [this.getSession(roomId)].filter(Boolean)
            : [...this._sessionsByRoom.values()];

        return Object.freeze({
            roomId,
            health: this.health(),
            sessions: Object.freeze(
                sessions.map((session) => session.toDashboardSnapshot())
            )
        });

    }

    submitPlayerConfirmation(roomId, playerId) {

        this._assertInitialized();

        const session = this._sessionsByRoom.get(roomId);

        if (!session || !session.isInProgress()) {

            return null;

        }

        const participant = session.findParticipant(playerId);

        if (!participant) {

            return null;

        }

        if (
            participant.status !== PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION
        ) {

            return session;

        }

        participant.status = PAYMENT_PARTICIPANT_STATUS.PAYMENT_SUBMITTED;

        this._persistSession(session, "update");

        this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

        participant.status = PAYMENT_PARTICIPANT_STATUS.BLOCKCHAIN_PENDING;

        this._persistSession(session, "update");

        this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

        this._registerPlayerWatch(session, participant);

        this._log(`BLOCKCHAIN_PENDING | roomId=${roomId} | playerId=${playerId}`);

        return session;

    }

    confirmBlockchainPayment(roomId, playerId, {
        txHash = null,
        amount = null,
        sender = null
    } = {}) {

        this._assertInitialized();

            const session = this._sessionsByRoom.get(roomId);

            if (!session || !session.isInProgress()) {

                return null;

            }

            const participant = session.findParticipant(playerId);

            if (!participant) {

                return null;

            }

        if (txHash) {

            const txKey = `${session.paymentSessionId}:${txHash}`;

            if (this._confirmedTxHashes.has(txKey)) {

                throw new DuplicatePaymentError(
                    session.paymentSessionId,
                    playerId,
                    txHash
                );

            }

        }

        if (participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED) {

            return session;

        }

        if (txHash) {

            this._confirmedTxHashes.add(`${session.paymentSessionId}:${txHash}`);

        }

        if (
            participant.status !== PAYMENT_PARTICIPANT_STATUS.BLOCKCHAIN_PENDING
            && participant.status !== PAYMENT_PARTICIPANT_STATUS.PAYMENT_SUBMITTED
            && participant.status !== PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION
            && participant.status !== PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED
        ) {

            return session;

        }

            if (amount != null) {

                participant.paidAmount = Number(amount);

            }

            if (txHash) {

                participant.txHash = txHash;

            }

            participant.confirmationStatus = PAYMENT_CONFIRMATION_STATUS.CONFIRMED;

            participant.confirmedAt = Date.now();

            participant.status = PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED;

            session.addReceivedPayment({
                playerId,
                walletAddress: sender ?? participant.wallet,
                amount: participant.paidAmount || participant.requiredGram,
                transactionHash: txHash,
                status: PAYMENT_CONFIRMATION_STATUS.CONFIRMED
            });

            this._lastConfirmationAt = Date.now();

            this._persistSession(session, "update");

            this._emitDomain(EVENT_TYPES.PAYMENT_CONFIRMED, session, {
                playerId,
                walletAddress: participant.wallet,
                transactionHash: txHash
            });

            this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

            this._blockchainMonitor?.unwatchPayment?.(roomId, playerId);

        return this._maybeCompleteSession(session);

    }

    reportPlayerCancel(roomId, playerId) {

        this._assertInitialized();

        const session = this._sessionsByRoom.get(roomId);

        if (!session || !session.isInProgress()) {

            return null;

        }

        const participant = session.findParticipant(playerId);

        if (!participant) {

            return null;

        }

        if (
            participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_SUBMITTED
            || participant.status === PAYMENT_PARTICIPANT_STATUS.BLOCKCHAIN_PENDING
        ) {

            this._blockchainMonitor?.unwatchPayment?.(roomId, playerId);

            participant.status = PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION;

            participant.txHash = null;

            this._persistSession(session, "update");

            this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

        }

        return session;

    }

    failSession(roomId, reason = "payment_failed") {

        const session = this._sessionsByRoom.get(roomId);

        if (!session) {

            return null;

        }

        if (session.isTerminal()) {

            return session;

        }

        this._clearExpiry(roomId);

        this._blockchainMonitor?.stopRoom?.(roomId);

        if (reason === "payment_timeout") {

            session.markTimedOut();

            this._emitDomain(EVENT_TYPES.PAYMENT_TIMEOUT, session, { reason });

        } else {

            session.markFailed();

        }

        this._persistSession(session, "update");

        this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

        this._emit(EVENT_TYPES.PAYMENT_SESSION_FAILED, {
            ...session.toSnapshot(),
            reason
        });

        this._log(`FAILED | roomId=${roomId} | reason=${reason}`);

        return session;

    }

    destroySession(roomId) {

        if (!roomId) {

            return;

        }

        this._clearExpiry(roomId);

        this._blockchainMonitor?.stopRoom?.(roomId);

        const session = this._sessionsByRoom.get(roomId);

        if (session?.gameId) {

            this._roomByGameId.delete(session.gameId);

        }

        this._sessionsByRoom.delete(roomId);

    }

    // -------------------------------------------------------------------------
    // Internal event handlers
    // -------------------------------------------------------------------------

    _handlePaymentConnectionReady(payload) {

        this.createAndRequest(payload?.roomId, {
            gameId: payload?.gameId ?? null
        });

    }

    _handleContractReadyForPayments(payload) {

        const roomId = payload?.roomId;

        const contractAddress = payload?.contractAddress;

        if (!roomId || !contractAddress) {

            return;

        }

        this.issueDeployedPaymentRequests(roomId, {
            contractAddress,
            paymentDeadline: payload?.paymentDeadline ?? null
        });

    }

    _handleContractDeploymentConfirmed(payload) {

        const roomId = payload?.roomId;

        if (!roomId || !payload?.address) {

            return;

        }

        this.issueDeployedPaymentRequests(roomId, {
            contractAddress: payload.address,
            paymentDeadline: payload?.paymentDeadline ?? null
        });

    }

    _handlePaymentTransactionDetected(payload) {

        const roomId = payload?.roomId;

        const playerId = payload?.playerId;

        if (!roomId || !playerId) {

            return;

        }

        const session = this._sessionsByRoom.get(roomId);

        if (!session || !session.isInProgress()) {

            return;

        }

        const participant = session.findParticipant(playerId);

        if (!participant) {

            this._emitUnexpectedPayment(session, payload, "unknown_player");

            return;

        }

        participant.confirmationStatus = PAYMENT_CONFIRMATION_STATUS.DETECTED;

        this._persistSession(session, "update");

        this._emitDomain(EVENT_TYPES.PAYMENT_RECEIVED, session, {
            playerId,
            walletAddress: participant.wallet,
            transactionHash: payload?.transactionId ?? null
        });

    }

    _handlePaymentTransactionConfirmed(payload) {

        this._processConfirmedPayment(payload, { source: "observation" });

    }

    _handleBlockchainConfirmed(payload) {

        this._processConfirmedPayment(payload, { source: "legacy" });

    }

    _handleBlockchainRejected(payload) {

        const roomId = payload?.roomId;

        const playerId = payload?.playerId;

        const session = roomId ? this._sessionsByRoom.get(roomId) : null;

        if (session) {

            const participant = session.findParticipant(playerId);

            if (participant) {

                participant.confirmationStatus = PAYMENT_CONFIRMATION_STATUS.REJECTED;

                this._persistSession(session, "update");

            }

            this._emitDomain(EVENT_TYPES.PAYMENT_REJECTED, session, {
                playerId,
                walletAddress: participant?.wallet ?? null,
                transactionHash: payload?.txHash ?? null,
                reason: payload?.reason ?? "rejected"
            });

        }

        this._log(
            `BLOCKCHAIN_REJECTED | roomId=${roomId} | `
                + `playerId=${playerId} | reason=${payload?.reason}`
        );

    }

    _handleTransactionFailed(payload) {

        const roomId = payload?.roomId;

        const playerId = payload?.playerId;

        const session = roomId ? this._sessionsByRoom.get(roomId) : null;

        if (!session || !playerId) {

            return;

        }

        const participant = session.findParticipant(playerId);

        if (!participant) {

            return;

        }

        participant.confirmationStatus = PAYMENT_CONFIRMATION_STATUS.FAILED;

        this._persistSession(session, "update");

        this._emitDomain(EVENT_TYPES.PAYMENT_REJECTED, session, {
            playerId,
            walletAddress: participant.wallet,
            transactionHash: payload?.transactionId ?? null,
            reason: payload?.reason ?? "transaction_failed"
        });

    }

    _processConfirmedPayment(payload, { source = "observation" } = {}) {

        const roomId = payload?.roomId;

        const playerId = payload?.playerId;

        if (!roomId || !playerId) {

            return;

        }

        const session = this._sessionsByRoom.get(roomId);

        if (!session || !session.isInProgress()) {

            if (session) {

                this._emitUnexpectedPayment(session, payload, "late_payment");

            }

            return;

        }

        try {

            this._validateIncomingPayment(session, payload);

            this.confirmBlockchainPayment(roomId, playerId, {
                txHash: payload?.transactionId ?? payload?.txHash ?? null,
                amount: payload?.amount ?? payload?.amountGram ?? null,
                sender: payload?.sender ?? null
            });

        } catch (error) {

            if (error instanceof DuplicatePaymentError) {

                return;

            }

            this._emitDomain(EVENT_TYPES.PAYMENT_REJECTED, session, {
                playerId,
                walletAddress: payload?.sender ?? null,
                transactionHash: payload?.transactionId ?? payload?.txHash ?? null,
                reason: error?.message ?? "validation_failed",
                source
            });

        }

    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    _activatePaymentRequests(session, {
        contractAddress,
        paymentDeadline = null
    }) {

        if (!contractAddress) {

            return null;

        }

        const deadline = Number.isFinite(paymentDeadline)
            ? paymentDeadline
            : session.paymentDeadline;

        if (Number.isFinite(deadline)) {

            session.paymentDeadline = deadline;

            session.expiresAt = deadline;

        }

        for (const participant of session.participants) {

            if (
                participant.status !== PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED
                && participant.status !== PAYMENT_PARTICIPANT_STATUS.WAITING
                && participant.status !== PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION
            ) {

                continue;

            }

            participant.contractAddress = contractAddress;

            participant.paymentReference = `payref_${session.paymentSessionId}_${participant.playerId}`;

            participant.status = PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION;

            this._emit(EVENT_TYPES.PAYMENT_REQUEST, {
                paymentSessionId: session.paymentSessionId,
                roomId: session.roomId,
                gameId: session.gameId,
                playerId: participant.playerId,
                requiredGram: participant.requiredGram,
                paymentDeadline: session.paymentDeadline,
                contractAddress,
                paymentReference: participant.paymentReference
            });

        }

        this._registerBlockchainWatches(session, contractAddress);

        this._persistSession(session, "update");

        this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

        this._log(
            `PAYMENT_REQUESTS_ISSUED | roomId=${session.roomId} | address=${contractAddress}`
        );

        return session;

    }

    _registerBlockchainWatches(session, contractAddress) {

        let count = 0;

        for (const participant of session.participants) {

            if (participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED) {

                continue;

            }

            this._registerPlayerWatch(session, participant, contractAddress);

            count += 1;

        }

        return count;

    }

    _registerPlayerWatch(session, participant, contractAddress = participant.contractAddress) {

        if (!this._blockchainMonitor || !contractAddress) {

            return;

        }

        this._blockchainMonitor.watchPayment({
            roomId: session.roomId,
            gameId: session.gameId,
            playerId: participant.playerId,
            contractAddress,
            contractId: session.contractId,
            correlationId: session.correlationId,
            paymentReference: participant.paymentReference,
            expectedGram: participant.requiredGram,
            expectedWallet: participant.wallet,
            paymentDeadline: session.paymentDeadline
        });

    }

    _validateIncomingPayment(session, payload) {

        const participant = session.findParticipant(payload.playerId);

        if (!participant) {

            throw new UnexpectedPaymentError("Payment for unknown player", payload);

        }

        if (participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED) {

            throw new DuplicatePaymentError(
                session.paymentSessionId,
                payload.playerId,
                payload?.transactionId ?? payload?.txHash ?? null
            );

        }

        if (session.paymentDeadline && Date.now() > session.paymentDeadline) {

            throw new UnexpectedPaymentError("Late payment after deadline", {
                paymentSessionId: session.paymentSessionId,
                playerId: payload.playerId
            });

        }

        const contract = this._resolveContract(session.roomId, session.contractId);

        if (contract?.contractAddress && payload?.address) {

            if (contract.contractAddress !== payload.address) {

                throw new PaymentValidationError("Payment sent to wrong contract", {
                    expected: contract.contractAddress,
                    actual: payload.address
                });

            }

        }

        if (payload?.sender && participant.wallet && payload.sender !== participant.wallet) {

            throw new PaymentValidationError("Payment from wrong wallet", {
                expected: participant.wallet,
                actual: payload.sender
            });

        }

        const amount = payload?.amount ?? payload?.amountGram ?? null;

        if (amount != null && !amountsMatch(participant.requiredGram, amount)) {

            throw new PaymentValidationError("Payment amount mismatch", {
                expected: participant.requiredGram,
                actual: amount
            });

        }

        if (
            payload?.network
            && session.network
            && payload.network !== session.network
        ) {

            throw new PaymentValidationError("Payment network mismatch", {
                expected: session.network,
                actual: payload.network
            });

        }

        return participant;

    }

    _maybeCompleteSession(session) {

        if (!session.allConfirmed()) {

            if (session.confirmedCount() > 0) {

                session.markPartiallyPaid();

                this._persistSession(session, "update");

            }

            return session;

        }

        session.markCompleted();

        this._clearExpiry(session.roomId);

        this._blockchainMonitor?.stopRoom?.(session.roomId);

        this._persistSession(session, "update");

        this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

        this._emit(EVENT_TYPES.PAYMENT_SESSION_COMPLETED, Object.freeze({
            ...session.toSnapshot(),
            timestamp: Date.now()
        }));

        this._log(
            `COMPLETED | roomId=${session.roomId} | `
                + `paymentSessionId=${session.paymentSessionId}`
        );

        return session;

    }

    _resolveContract(roomId, contractId = null) {

        if (!this._gameContractManager) {

            return null;

        }

        return contractId
            ? this._gameContractManager.getContractById?.(contractId)
            : this._gameContractManager.getContract?.(roomId);

    }

    _assertContractReadyForPayments(contract) {

        if (!PAYMENT_READY_CONTRACT_STATUSES.has(contract.status)) {

            throw new PaymentValidationError(
                `Contract not ready for payments | status=${contract.status}`,
                { contractId: contract.contractId, status: contract.status }
            );

        }

        if (!contract.contractAddress) {

            throw new PaymentValidationError(
                "Contract address missing",
                { contractId: contract.contractId }
            );

        }

    }

    _resolveWalletSession(roomId, playerId) {

        if (this._walletManager) {

            return this._walletManager.getWalletByPlayer(playerId, roomId);

        }

        const walletAddress = this._sessionWalletStore?.getWallet?.(roomId, playerId);

        if (!walletAddress) {

            return null;

        }

        return {
            walletAddress,
            status: WALLET_SESSION_STATUS.VERIFIED
        };

    }

    _indexSession(session) {

        this._sessionsByRoom.set(session.roomId, session);

        if (session.gameId) {

            this._roomByGameId.set(session.gameId, session.roomId);

        }

    }

    _persistSession(session, operation) {

        if (!this._financialPersistence) {

            return;

        }

        const payload = session.toPayload();

        const metadata = {
            paymentSessionId: session.paymentSessionId,
            roomId: session.roomId,
            gameId: session.gameId,
            contractId: session.contractId,
            tonNetwork: session.network,
            correlationId: session.correlationId,
            status: session.status
        };

        try {

            if (operation === "create") {

                this._financialPersistence.createPaymentSession(payload, metadata);

            } else {

                this._financialPersistence.updatePaymentSession(
                    session.paymentSessionId,
                    payload,
                    metadata
                );

            }

        } catch (error) {

            if (error?.name === "RecordNotFoundError" && operation === "update") {

                this._financialPersistence.createPaymentSession(payload, metadata);

            }

        }

    }

    _emitUnexpectedPayment(session, payload, reason) {

        this._emitDomain(EVENT_TYPES.PAYMENT_REJECTED, session, {
            playerId: payload?.playerId ?? null,
            walletAddress: payload?.sender ?? null,
            transactionHash: payload?.transactionId ?? payload?.txHash ?? null,
            reason
        });

    }

    _scheduleExpiry(session) {

        const delay = Math.max(0, (session.paymentDeadline ?? session.expiresAt) - Date.now());

        const timerId = setTimeout(() => {

            this._onExpiry(session.roomId);

        }, delay);

        this._expiryTimers.set(session.roomId, timerId);

    }

    _onExpiry(roomId) {

        this._expiryTimers.delete(roomId);

        const session = this._sessionsByRoom.get(roomId);

        if (!session || !session.isInProgress()) {

            return;

        }

        this.failSession(roomId, "payment_timeout");

    }

    _clearExpiry(roomId) {

        const timerId = this._expiryTimers.get(roomId);

        if (timerId) {

            clearTimeout(timerId);

            this._expiryTimers.delete(roomId);

        }

    }

    _reset() {

        for (const roomId of [...this._expiryTimers.keys()]) {

            this._clearExpiry(roomId);

        }

        this._sessionsByRoom.clear();

        this._roomByGameId.clear();

        this._confirmedTxHashes.clear();

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _emit(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.PAYMENT_SESSION_MANAGER,
            type,
            payload
        });

    }

    _emitDomain(type, session, extra = {}) {

        this._emit(type, Object.freeze({
            paymentSessionId: session.paymentSessionId,
            roomId: session.roomId,
            gameId: session.gameId,
            contractId: session.contractId,
            status: session.status,
            timestamp: Date.now(),
            correlationId: session.correlationId,
            ...extra
        }));

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new Error("PaymentSessionManager is not initialized");

        }

    }

    _log(message) {

        if (this._devMode) {

            this._logger.info(`[PaymentSessionManager] ${message}`);

        }

    }

}

// Re-export typed errors for convenience.
export {
    DuplicatePaymentError,
    PaymentSessionAlreadyExistsError,
    PaymentValidationError,
    UnexpectedPaymentError
} from "./PaymentSessionManagerErrors.js";
