import { randomUUID } from "node:crypto";

import {
    markDeployStage,
    printDeployBlock,
    safeSerialize
} from "../diagnostics/DeployPipelineForensics.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    PAYMENT_CONFIRMATION_STATUS,
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS,
    PaymentParticipant,
    PaymentSession
} from "../models/PaymentSession.js";
import { tonWalletAccountsEqual } from "../models/TonWalletAddress.js";
import { amountsMatch } from "../payment/BlockchainMonitor.js";
import { calculateRequiredGram } from "../payment/calculateRequiredGram.js";
import { resolveIntendedRoomWalletAddress } from "../payment/roomWallet/RoomWalletIncomingObserver.js";
import { TON_FINANCIAL_RECORD_TYPES } from "../persistence/TonFinancialPersistence.js";
import { WALLET_SESSION_STATUS } from "../session/WalletSessionStates.js";
import {
    DuplicatePaymentError,
    PaymentSessionAlreadyExistsError,
    PaymentValidationError,
    UnexpectedPaymentError
} from "./PaymentSessionManagerErrors.js";
import { shouldPreserveFinancialEvidence } from "./financialEvidenceGuards.js";

const DEFAULT_PAYMENT_SESSION_DURATION_MS = 8 * 60 * 1000;

/**
 * P6.3 / T2.7 — Authoritative Payment Session manager.
 *
 * Owns payment orchestration only. Never communicates with TON directly —
 * Room Wallet incoming observations are authoritative payment evidence.
 */
export class PaymentSessionManager {

    constructor({
        logger,
        eventBus,
        playerManager,
        roomManager,
        gameManager = null,
        roomConfig = null,
        gameplayContextResolver = null,
        sessionWalletStore = null,
        sessionWalletStoreForWatch = null,
        walletManager = null,
        settlementManager = null,
        blockchainMonitor = null,
        financialPersistence = null,
        tonNetwork = null,
        devMode = false,
        roomWalletPaymentIntakeEnabled = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._playerManager = playerManager;

        this._roomManager = roomManager;

        this._gameManager = gameManager;

        this._gameplayContextResolver = gameplayContextResolver;

        this._sessionWalletStore = sessionWalletStore
            ?? sessionWalletStoreForWatch;

        this._walletManager = walletManager;

        this._settlementManager = settlementManager;

        this._blockchainMonitor = blockchainMonitor;

        this._financialPersistence = financialPersistence;

        this._tonNetwork = tonNetwork ?? null;

        this._durationMs = Number.isFinite(roomConfig?.paymentSessionDurationMs)
            && roomConfig.paymentSessionDurationMs > 0
            ? roomConfig.paymentSessionDurationMs
            : DEFAULT_PAYMENT_SESSION_DURATION_MS;

        this._devMode = devMode;

        this._roomWalletPaymentIntakeEnabled = true;

        this._roomWalletRegistry = null;
        this._roomWalletRefundAdapter = null;
        this._roomWalletRefundRetryTimers = new Map();

        this._sessionsByRoom = new Map();

        this._roomByGameId = new Map();

        this._expiryTimers = new Map();

        this._confirmedTxHashes = new Set();

        this._lastConfirmationAt = null;

        this._handlers = [];

        this._initialized = false;

    }

    /**
     * R17.9G.1 — Update Payment Timer for newly created sessions only.
     * Existing sessions keep their already-scheduled deadlines.
     */
    setDurationMs(durationMs) {

        const next = Number(durationMs);

        if (!Number.isFinite(next) || next <= 0) {

            throw new Error("PaymentSessionManager.setDurationMs requires a positive duration");

        }

        this._durationMs = next;

        return this._durationMs;

    }

    /**
     * R8.8 — Late-bind settlement/contract refs for financial retention checks.
     */
    setFinancialEvidenceDeps({
        settlementManager = null
    } = {}) {

        if (settlementManager) {

            this._settlementManager = settlementManager;

        }

    }

    setRoomWalletFinance({
        registry = null,
        roomWalletPaymentIntakeEnabled = null
    } = {}) {

        if (registry) {

            this._roomWalletRegistry = registry;

        }

        // Room Wallet is the sole active gameplay payment path.
        this._roomWalletPaymentIntakeEnabled = true;

    }

    setRoomWalletRefundAdapter(adapter = null) {
        this._roomWalletRefundAdapter = adapter ?? null;
    }

    shouldProtectRoomFromFinancialClose(roomId) {
        if (!this._roomWalletPaymentIntakeEnabled) {
            return false;
        }

        const session = this._sessionsByRoom.get(roomId);
        if (!session || session.isTerminal()) {
            return false;
        }

        return session.participants.some((participant) =>
            participant.refunded !== true
            && (
                participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
                || Number(participant.paidAmount) > 0
            )
        );
    }

    _shouldPreserveFinancialEvidence(roomId) {

        return shouldPreserveFinancialEvidence({
            roomId,
            gameManager: this._gameManager,
            settlementManager: this._settlementManager,
            paymentSessionManager: this
        });

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.PAYMENT_CONNECTION_READY,
            (envelope) => this._handlePaymentConnectionReady(envelope.payload)
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
            (envelope) => {

                const roomId = envelope.payload?.roomId;

                if (this._shouldPreserveFinancialEvidence(roomId)) {

                    return;

                }

                this.destroySession(roomId);

            }
        );

        this._subscribe(
            EVENT_TYPES.SESSION_FINISHED,
            (envelope) => {

                const roomId = envelope.payload?.roomId;

                // R8.8 — Page6/result finish is not financial completion.
                if (this._shouldPreserveFinancialEvidence(roomId)) {

                    return;

                }

                this.destroySession(roomId);

            }
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

            const createdAt = Date.now();

            const deadline = paymentDeadline ?? createdAt + this._durationMs;

            const activeNetwork = network ?? this._tonNetwork ?? null;

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
                roomNumber: Number.isInteger(room.roomNumber) ? room.roomNumber : null,
                gameId: resolvedGameId,
                contractId: null,
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

            const roomWalletAddress = this._resolveRoomWalletPaymentAddress(room, activeNetwork);

            if (!roomWalletAddress) {

                throw new PaymentValidationError(
                    "Room Wallet address is required for player payment",
                    { roomId, roomNumber: room.roomNumber ?? null }
                );

            }

            session.roomWalletAddress = roomWalletAddress;

            session.transitionTo(PAYMENT_SESSION_STATUS.WAITING_FOR_PAYMENTS);

            this._indexSession(session);

            this._persistSession(session, "create");

            this._scheduleExpiry(session);

            this._emitDomain(EVENT_TYPES.PAYMENT_SESSION_CREATED, session);

            this._logger.decisionTrace({
                stage: "PAYMENT_SESSION_CREATED",
                decision: "CREATED",
                reason: "Payment session created with authoritative Room Wallet destination.",
                caller: "PaymentSessionManager.createPaymentSession",
                nextAction: "Activate Room Wallet payment requests",
                roomId,
                gameId: resolvedGameId
            });

            this._activatePaymentRequests(session, {
                contractAddress: roomWalletAddress,
                paymentDeadline: deadline
            });

            this._log(
                `CREATED | roomId=${roomId} | gameId=${resolvedGameId} | `
                    + `paymentSessionId=${session.paymentSessionId}`
            );

            return session;

    }

    /**
     * P6.3 legacy — idempotent create used by lobby flow.
     */
    createAndRequest(roomId, { gameId = null, network = null } = {}) {

        this._assertInitialized();

        const stage = markDeployStage(roomId, "PAYMENT_SESSION_CREATE_AND_REQUEST");

        // R7.50 temporary diagnostics — PaymentSession creation requested.
        console.log("[R7.50 DIAG] PaymentSession creation requested", {
            roomId: roomId ?? null,
            gameId: gameId ?? null,
            hasExistingSession: this._sessionsByRoom.has(roomId),
            timestamp: Date.now()
        });

        printDeployBlock("PaymentSessionManager.createAndRequest", {
            RoomId: roomId,
            GameId: gameId,
            HasExistingSession: this._sessionsByRoom.has(roomId),
            DurationSincePreviousStageMs: stage.elapsedMs,
            Timestamp: new Date(stage.now).toISOString()
        });

        if (!roomId) {

            console.log("[R7.50 DIAG] PaymentSession creation rejected", {
                reason: "roomId_missing",
                roomId: null,
                gameId: gameId ?? null,
                timestamp: Date.now()
            });

            return null;

        }

        if (this._sessionsByRoom.has(roomId)) {

            const existing = this._sessionsByRoom.get(roomId);

            console.log("[R7.50 DIAG] PaymentSession creation skipped (already exists)", {
                roomId,
                paymentSessionId: existing?.paymentSessionId ?? null,
                status: existing?.status ?? null,
                timestamp: Date.now()
            });

            return existing;

        }

        try {

            const created = this.createPaymentSession(roomId, {
                gameId,
                // Task 2026-09-17 — authoritative pre-create payment network
                // from the PAYMENT_CONNECTION_READY payload. null keeps the
                // established resolution (contract.tonNetwork → runtime).
                network
            });

            console.log("[R7.50 DIAG] PaymentSession created", {
                roomId,
                gameId: created?.gameId ?? gameId ?? null,
                paymentSessionId: created?.paymentSessionId ?? null,
                status: created?.status ?? null,
                participantCount: created?.participants?.length ?? null,
                timestamp: Date.now()
            });

            return created;

        } catch (error) {

            if (error instanceof PaymentSessionAlreadyExistsError) {

                const existing = this._sessionsByRoom.get(roomId) ?? null;

                console.log("[R7.50 DIAG] PaymentSession creation rejected", {
                    reason: "already_exists",
                    roomId,
                    paymentSessionId: existing?.paymentSessionId ?? null,
                    timestamp: Date.now()
                });

                return existing;

            }

            console.log("[R7.50 DIAG] PaymentSession creation rejected", {
                reason: error?.message ?? "payment_session_create_failed",
                errorName: error?.name ?? null,
                roomId,
                gameId: gameId ?? null,
                timestamp: Date.now()
            });

            this._logger.error(
                `PaymentSession create failed | roomId=${roomId} | `
                    + `${error?.message ?? error}`
            );

            this._logger.decisionTrace({
                stage: "TERMINAL_FAILURE",
                decision: "FAIL",
                reason: error?.message ?? "payment_session_create_failed",
                caller: "PaymentSessionManager.createAndRequest",
                nextAction: "Emit PAYMENT_SESSION_FAILED → _closeRoom",
                roomId,
                gameId: gameId ?? null
            });

            // R7.24 — create failure must not leave ARCHIVED rooms without a session timer.
            this._emit(EVENT_TYPES.PAYMENT_SESSION_FAILED, {
                roomId,
                gameId: gameId ?? null,
                reason: error?.message ?? "payment_session_create_failed"
            });

            return null;

        }

    }

    issueDeployedPaymentRequests(roomId, {
        contractAddress,
        paymentDeadline = null
    } = {}) {

        this._assertInitialized();

        if (this._roomWalletPaymentIntakeEnabled) {

            return this._sessionsByRoom.get(roomId) ?? null;

        }

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

    async restorePaymentSessions() {
        this._assertInitialized();

        const records = this._financialPersistence?.listActive?.(
            TON_FINANCIAL_RECORD_TYPES.PAYMENT_SESSION
        ) ?? [];

        let restored = 0;
        let recovered = 0;
        let refundPending = 0;

        for (const record of records) {
            try {
                const session = PaymentSession.fromRecord(record);
                if (!session.roomId || this._sessionsByRoom.has(session.roomId)) continue;

                const room = this._roomManager?.getRoom?.(session.roomId) ?? null;
                if (room?.roomNumber != null && session.roomNumber == null) {
                    session.roomNumber = room.roomNumber;
                }

                if (!session.roomWalletAddress) {
                    session.roomWalletAddress = this._resolveRoomWalletPaymentAddress(
                        room,
                        session.network ?? this._tonNetwork ?? null
                    );
                }

                if (this._roomWalletPaymentIntakeEnabled) {
                    this._reconcileRoomWalletAcceptedEvidence(session);
                }

                this._sessionsByRoom.set(session.roomId, session);
                if (session.gameId) this._roomByGameId.set(session.gameId, session.roomId);

                if (session.status === PAYMENT_SESSION_STATUS.PAYMENT_TIMEOUT
                    || session.status === PAYMENT_SESSION_STATUS.FAILED) {
                    const hasConfirmed = session.participants.some(participant =>
                        participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
                        || Number(participant.paidAmount) > 0
                    );
                    if (hasConfirmed && this._roomWalletRefundAdapter) {
                        if (session.status !== PAYMENT_SESSION_STATUS.REFUND_PENDING) {
                            session.markRefundPending();
                        }
                        this._persistSession(session, "update");
                        refundPending += 1;
                        void this._runRoomWalletRefunds(session, "restore_recovery");
                    }
                }

                if (session.isInProgress()) {
                    this._scheduleExpiry(session);
                }

                restored += 1;
            } catch (error) {
                this._logger?.error?.(
                    `Payment session restore failed | record=${record?.recordId ?? "unknown"} | ${error?.message ?? error}`
                );
            }
        }

        recovered = restored - refundPending;
        return Object.freeze({ restored, recovered, refundPending, rewatched: 0, syncedFromChain: 0 });
    }


    /**
     * Returns a Promise when chain sync is available; otherwise a sync summary.
     */
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

            this._sessionWalletStore?.lockFinancialWallet?.(roomId, playerId);

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

    /**
     * Player-initiated cancel (PAYMENT_CANCEL_INTENT).
     * R13.1H — Never cancels FULLY_PAID / PAYMENT_CONFIRMED seats.
     * Only resets SUBMITTED / BLOCKCHAIN_PENDING intent before confirmation.
     */
    reportPlayerCancel(roomId, playerId) {

        this._assertInitialized();

        const session = this._sessionsByRoom.get(roomId);

        if (!session) {

            return null;

        }

        // R13.1H — PLAYER_REQUEST_CANCEL forbidden after financial commitment.
        if (
            !session.isInProgress()
            || session.status === PAYMENT_SESSION_STATUS.FULLY_PAID
        ) {

            this._log(
                `PLAYER_CANCEL_FORBIDDEN | roomId=${roomId} | playerId=${playerId} | `
                    + `sessionStatus=${session.status}`
            );

            return null;

        }

        const participant = session.findParticipant(playerId);

        if (!participant) {

            return null;

        }

        if (participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED) {

            this._log(
                `PLAYER_CANCEL_FORBIDDEN | roomId=${roomId} | playerId=${playerId} | `
                    + `seat=PAYMENT_CONFIRMED`
            );

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

        printDeployBlock("PaymentSessionManager.failSession ENTRY", {
            RoomId: roomId,
            Reason: reason,
            HasSession: Boolean(session),
            PaymentSessionId: session?.paymentSessionId ?? null,
            SessionStatus: session?.status ?? null,
            IsTerminal: session?.isTerminal?.() ?? null,
            Timestamp: new Date().toISOString()
        });

        if (!session) {

            printDeployBlock("PaymentSessionManager.failSession ABORT", {
                RoomId: roomId,
                Reason: "no_session_in_registry",
                WillEmitPAYMENT_SESSION_FAILED: false,
                Timestamp: new Date().toISOString()
            });

            return null;

        }

        if (session.isTerminal()) {

            printDeployBlock("PaymentSessionManager.failSession ABORT", {
                RoomId: roomId,
                Reason: "session_already_terminal",
                WillEmitPAYMENT_SESSION_FAILED: false,
                Timestamp: new Date().toISOString()
            });

            return session;

        }

        if (session.status === PAYMENT_SESSION_STATUS.REFUND_PENDING) {

            printDeployBlock("PaymentSessionManager.failSession ABORT", {
                RoomId: roomId,
                Reason: "refund_in_progress",
                WillEmitPAYMENT_SESSION_FAILED: false,
                Timestamp: new Date().toISOString()
            });

            return session;

        }

        this._clearExpiry(roomId);

        this._blockchainMonitor?.stopRoom?.(roomId);

        if (this._roomWalletPaymentIntakeEnabled) {
            this._reconcileRoomWalletAcceptedEvidence(session);
        }

        const needsRoomWalletRefund = this._roomWalletPaymentIntakeEnabled
            && typeof this._roomWalletRefundAdapter?.refundTransfer === "function"
            && session.participants.some((participant) =>
                participant.refunded !== true
                && (
                    participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
                    || Number(participant.paidAmount) > 0
                )
            );

        if (reason === "payment_timeout") {

            session.markTimedOut();

            this._emitDomain(EVENT_TYPES.PAYMENT_TIMEOUT, session, { reason });

        } else {

            session.markFailed();

        }

        if (needsRoomWalletRefund) {
            session.recoveryMetadata = {
                ...(session.recoveryMetadata ?? {}),
                unwindReason: reason,
                roomWalletRefundRequestedAt: Date.now()
            };

            session.markRefundPending();
            this._persistSession(session, "update");
            this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

            void this._runRoomWalletRefunds(session, reason);

            this._log(
                `ROOM_WALLET_REFUND_REQUESTED | roomId=${roomId} | reason=${reason}`
            );

            this._logger.decisionTrace({
                stage: "TERMINAL_FAILURE",
                decision: "ROOM_WALLET_REFUND",
                reason: reason ?? "payment_failed",
                caller: "PaymentSessionManager.failSession",
                nextAction: "RoomWalletSettlementRouter.refundTransfer",
                roomId,
                gameId: session.gameId ?? null
            });

            return session;
        }

        this._persistSession(session, "update");

        this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

        const failedPayload = {
            ...session.toSnapshot(),
            reason
        };

        printDeployBlock("PaymentSessionManager.failSession EMITTING", {
            EventName: EVENT_TYPES.PAYMENT_SESSION_FAILED,
            Payload: failedPayload,
            RoomId: roomId,
            PaymentSessionId: session.paymentSessionId,
            Timestamp: new Date().toISOString()
        });

        this._emit(EVENT_TYPES.PAYMENT_SESSION_FAILED, failedPayload);

        this._log(`FAILED | roomId=${roomId} | reason=${reason}`);

        this._logger.decisionTrace({
            stage: "TERMINAL_FAILURE",
            decision: "FAIL",
            reason: reason ?? "payment_failed",
            caller: "PaymentSessionManager.failSession",
            nextAction: "Room close / cleanup",
            roomId,
            gameId: session.gameId ?? null
        });

        this._logger.decisionTrace({
            stage: "ROOM_TERMINATION",
            decision: "PENDING",
            reason: reason ?? "payment_failed",
            caller: "PaymentSessionManager.failSession",
            nextAction: "RoomLobbyBridge._handlePaymentSessionFailed",
            roomId,
            gameId: session.gameId ?? null
        });

        return session;

    }

    destroySession(roomId) {

        if (!roomId) {

            return;

        }

        const existing = this._sessionsByRoom.get(roomId) ?? null;

        // R7.50 temporary diagnostics — distinguish never-created vs post-destroy null.
        console.log("[R7.50 DIAG] PaymentSession destroySession", {
            roomId,
            hadSession: Boolean(existing),
            paymentSessionId: existing?.paymentSessionId ?? null,
            status: existing?.status ?? null,
            timestamp: Date.now()
        });

        this._clearExpiry(roomId);

        this._blockchainMonitor?.stopRoom?.(roomId);

        const session = existing;

        if (session?.gameId) {

            this._roomByGameId.delete(session.gameId);

        }

        this._sessionsByRoom.delete(roomId);

    }

    // -------------------------------------------------------------------------
    // Internal event handlers
    // -------------------------------------------------------------------------

    _handlePaymentConnectionReady(payload) {

        const stage = markDeployStage(
            payload?.roomId,
            "PAYMENT_CONNECTION_READY_HANDLER"
        );

        // R7.50 temporary diagnostics — EventBus handler entry.
        console.log("[R7.50 DIAG] PAYMENT_CONNECTION_READY received by PaymentSessionManager", {
            roomId: payload?.roomId ?? null,
            gameId: payload?.gameId ?? null,
            hasExistingSession: this._sessionsByRoom.has(payload?.roomId),
            timestamp: Date.now()
        });

        printDeployBlock("PaymentSessionManager._handlePaymentConnectionReady", {
            RoomId: payload?.roomId ?? null,
            GameId: payload?.gameId ?? null,
            DurationSincePreviousStageMs: stage.elapsedMs,
            Timestamp: new Date(stage.now).toISOString()
        });

        const session = this.createAndRequest(payload?.roomId, {
            gameId: payload?.gameId ?? null,
            // Task 2026-09-17 — authoritative pre-create payment network
            // ("testnet" | "mainnet") emitted by the server-owned
            // RoomLobbyBridge state. Never a client-provided value.
            network: payload?.paymentNetwork ?? null
        });

        console.log("[R7.50 DIAG] createAndRequest returned", {
            roomId: payload?.roomId ?? null,
            created: Boolean(session),
            paymentSessionId: session?.paymentSessionId ?? null,
            status: session?.status ?? null,
            timestamp: Date.now()
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

        for (let index = 0; index < session.participants.length; index += 1) {

            const participant = session.participants[index];

            if (
                participant.status !== PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED
                && participant.status !== PAYMENT_PARTICIPANT_STATUS.WAITING
                && participant.status !== PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION
            ) {

                continue;

            }

            participant.contractAddress = contractAddress;

            participant.paymentReference = `payref_${session.paymentSessionId}_${participant.playerId}`;

            participant.playerIndex = index;

            participant.status = PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION;

            this._emit(EVENT_TYPES.PAYMENT_REQUEST, {
                paymentSessionId: session.paymentSessionId,
                roomId: session.roomId,
                gameId: session.gameId,
                playerId: participant.playerId,
                playerIndex: index,
                requiredGram: participant.requiredGram,
                paymentDeadline: session.paymentDeadline,
                contractAddress,
                paymentReference: participant.paymentReference
            });

        }

        if (!this._roomWalletPaymentIntakeEnabled) {

            this._registerBlockchainWatches(session, contractAddress);

        }

        this._persistSession(session, "update");

        this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

        this._log(
            `PAYMENT_REQUESTS_ISSUED | roomId=${session.roomId} | address=${contractAddress}`
        );

        return session;

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

        const expectedDestination = session.roomWalletAddress
            ?? participant.contractAddress
            ?? null;

        const contract = this._resolveContract(session.roomId, session.contractId);

        if (this._roomWalletPaymentIntakeEnabled) {

            if (expectedDestination && payload?.address) {

                if (!tonWalletAccountsEqual(expectedDestination, payload.address)) {

                    throw new PaymentValidationError("Payment sent to wrong contract", {
                        expected: expectedDestination,
                        actual: payload.address
                    });

                }

            }

        } else if (contract?.contractAddress && payload?.address) {

            if (!tonWalletAccountsEqual(contract.contractAddress, payload.address)) {

                throw new PaymentValidationError("Payment sent to wrong contract", {
                    expected: contract.contractAddress,
                    actual: payload.address
                });

            }

        }

        if (payload?.sender && participant.wallet) {

            if (!tonWalletAccountsEqual(payload.sender, participant.wallet)) {

                throw new PaymentValidationError("Payment from wrong wallet", {
                    expected: participant.wallet,
                    actual: payload.sender
                });

            }

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

    _reconcileRoomWalletAcceptedEvidence(session) {
        if (!session || !this._financialPersistence?.findByRoom) {
            return 0;
        }

        let records = [];
        try {
            const byRoom = this._financialPersistence.findByRoom(session.roomId) ?? [];
            const byGame = this._financialPersistence.findByGame?.(session.gameId) ?? [];
            const seen = new Set();
            records = [...byRoom, ...byGame].filter((record) => {
                const key = `${record?.recordType ?? ""}:${record?.recordId ?? ""}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        } catch (error) {
            this._logger?.error?.(
                `Room Wallet accepted-payment evidence lookup failed | roomId=${session.roomId} | ${error?.message ?? error}`
            );
            return 0;
        }

        const accepted = records.filter((record) =>
            record?.recordType === TON_FINANCIAL_RECORD_TYPES.AUDIT
            && record?.status === "ACCEPTED"
            && record?.payload?.kind === "ROOM_WALLET_INCOMING_OBSERVATION"
            && record?.payload?.paymentSessionId === session.paymentSessionId
            && Number(record?.payload?.amountGram) > 0
        );

        let reconciled = 0;

        for (const record of accepted) {
            const payload = record.payload;
            const participant = session.findParticipant(payload.playerId);
            if (!participant || participant.refunded === true) {
                continue;
            }

            const amountGram = Number(payload.amountGram);
            if (!Number.isFinite(amountGram) || amountGram <= 0) {
                continue;
            }

            if (participant.status !== PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED) {
                participant.paidAmount = amountGram;
                participant.txHash = payload.transactionHash ?? participant.txHash ?? null;
                participant.confirmationStatus = PAYMENT_CONFIRMATION_STATUS.CONFIRMED;
                participant.confirmedAt = participant.confirmedAt ?? record.createdAt ?? Date.now();
                participant.status = PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED;
                reconciled += 1;
            }
        }

        if (reconciled > 0) {
            this._persistSession(session, "update");
            this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());
            this._logger?.warn?.(
                `Room Wallet financial evidence reconciled before close | roomId=${session.roomId} | payments=${reconciled}`
            );
        }

        return reconciled;
    }

    _resolveRoomWalletRefundRoomNumber(session) {
        const direct = Number(session?.roomNumber);
        if (Number.isInteger(direct) && direct >= 1) {
            return direct;
        }

        const room = this._roomManager?.getRoom?.(session?.roomId);
        const fromRoom = Number(room?.roomNumber);
        if (Number.isInteger(fromRoom) && fromRoom >= 1) {
            return fromRoom;
        }

        const byAddress = this._roomWalletRegistry?.getByAddress?.(session?.roomWalletAddress);
        const fromRegistry = Number(byAddress?.roomNumber);
        if (Number.isInteger(fromRegistry) && fromRegistry >= 1) {
            session.roomNumber = fromRegistry;
            return fromRegistry;
        }

        return null;
    }

    async _runRoomWalletRefunds(session, reason) {
        const pending = (session.participants ?? []).filter((participant) =>
            participant.refunded !== true
            && (
                participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
                || Number(participant.paidAmount) > 0
            )
        );

        if (pending.length === 0) {
            session.markCancelled();
            this._persistSession(session, "update");
            this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());
            this._emit(EVENT_TYPES.PAYMENT_SESSION_FAILED, {
                ...session.toSnapshot(),
                reason
            });
            return;
        }

        const refundRoomNumber = this._resolveRoomWalletRefundRoomNumber(session);
        if (!Number.isInteger(refundRoomNumber) || refundRoomNumber < 1) {
            this._logger?.error?.(
                `Room Wallet refund room number unavailable | roomId=${session.roomId} | wallet=${session.roomWalletAddress ?? "unknown"}`
            );
            this._scheduleRoomWalletRefundRetry(session.roomId);
            return;
        }

        let retryNeeded = false;

        for (const participant of pending) {
            const amountNano = BigInt(Math.round(
                Number(participant.paidAmount || participant.requiredGram || 0) * 1_000_000_000
            ));

            if (!participant.wallet || amountNano <= 0n) {
                retryNeeded = true;
                this._logger?.error?.(
                    `Room Wallet refund target invalid | roomId=${session.roomId} | playerId=${participant.playerId}`
                );
                continue;
            }

            try {
                const result = await this._roomWalletRefundAdapter.refundTransfer({
                    roomNumber: refundRoomNumber,
                    destination: participant.wallet,
                    amountNano,
                    queryId: stableRefundQueryId(session.paymentSessionId, participant.playerId)
                });

                if (!result?.ok) {
                    retryNeeded = true;
                    this._logger?.error?.(
                        `Room Wallet refund failed | roomId=${session.roomId} | playerId=${participant.playerId} | code=${result?.code ?? "unknown"}`
                    );
                    continue;
                }

                participant.refunded = true;
                participant.refundTxHash = result.txHash ?? null;
                this._persistSession(session, "update");
                this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

                this._logger?.info?.(
                    `Room Wallet refund broadcast | roomId=${session.roomId} | playerId=${participant.playerId} | txHash=${result.txHash ?? "unknown"}`
                );
            } catch (error) {
                retryNeeded = true;
                this._logger?.error?.(
                    `Room Wallet refund exception | roomId=${session.roomId} | playerId=${participant.playerId} | ${error?.message ?? error}`
                );
            }
        }

        const remaining = (session.participants ?? []).some((participant) =>
            participant.refunded !== true
            && (
                participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
                || Number(participant.paidAmount) > 0
            )
        );

        if (!remaining) {
            session.markCancelled();
            session.recoveryMetadata = {
                ...(session.recoveryMetadata ?? {}),
                roomWalletRefundCompletedAt: Date.now()
            };
            this._persistSession(session, "update");
            this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());
            this._emit(EVENT_TYPES.PAYMENT_SESSION_FAILED, {
                ...session.toSnapshot(),
                reason
            });
            return;
        }

        if (retryNeeded) {
            this._scheduleRoomWalletRefundRetry(session.roomId);
        }
    }

    _scheduleRoomWalletRefundRetry(roomId) {
        if (this._roomWalletRefundRetryTimers.has(roomId)) {
            return;
        }

        const timer = setTimeout(() => {
            this._roomWalletRefundRetryTimers.delete(roomId);
            const session = this._sessionsByRoom.get(roomId);
            if (session?.status === PAYMENT_SESSION_STATUS.REFUND_PENDING) {
                void this._runRoomWalletRefunds(session, "room_wallet_refund_retry");
            }
        }, 15_000);

        this._roomWalletRefundRetryTimers.set(roomId, timer);
    }



    _resolveRoomWalletPaymentAddress(room, paymentNetwork = null) {

        if (!room) {

            return null;

        }

        const resolvedNetwork = String(
            paymentNetwork
                ?? room?.paymentNetwork
                ?? room?.network
                ?? room?.tonNetwork
                ?? ""
        ).trim().toLowerCase();

        return resolveIntendedRoomWalletAddress({
            roomId: room.roomId,
            roomNumber: room.roomNumber ?? null,
            roomManager: this._roomManager,
            paymentNetwork: resolvedNetwork
        }, this._roomWalletRegistry);

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

        for (const timer of this._roomWalletRefundRetryTimers.values()) {
            clearTimeout(timer);
        }
        this._roomWalletRefundRetryTimers.clear();

        this._sessionsByRoom.clear();

        this._roomByGameId.clear();

        this._confirmedTxHashes.clear();

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _emit(type, payload) {

        if (type === EVENT_TYPES.PAYMENT_SESSION_FAILED) {

            printDeployBlock("EVENT EMITTED", {
                EventName: type,
                Payload: payload,
                Source: EVENT_SOURCES.PAYMENT_SESSION_MANAGER,
                RoomId: payload?.roomId ?? null,
                GameId: payload?.gameId ?? null,
                PaymentSessionId: payload?.paymentSessionId ?? null,
                Timestamp: new Date().toISOString()
            });

        }

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

function stableRefundQueryId(paymentSessionId, playerId) {
    const input = `${paymentSessionId}:${playerId}`;
    let hash = 0n;
    for (const char of input) {
        hash = (hash * 131n + BigInt(char.codePointAt(0))) & ((1n << 63n) - 1n);
    }
    return hash;
}

// Re-export typed errors for convenience.
export {
    DuplicatePaymentError,
    PaymentSessionAlreadyExistsError,
    PaymentValidationError,
    UnexpectedPaymentError
} from "./PaymentSessionManagerErrors.js";
