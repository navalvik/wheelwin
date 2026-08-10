import { randomUUID } from "node:crypto";

import {
    markDeployStage,
    printDeployBlock,
    safeSerialize
} from "../diagnostics/DeployPipelineForensics.js";
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
import { shouldPreserveFinancialEvidence } from "./financialEvidenceGuards.js";

const DEFAULT_PAYMENT_SESSION_DURATION_MS = 5 * 60 * 1000;

const PAYMENT_READY_CONTRACT_STATUSES = new Set([
    GAME_CONTRACT_STATUS.DEPLOYED,
    GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS
]);

/**
 * P6.3 / T2.7 — Authoritative Payment Session manager.
 *
 * Owns payment orchestration only. Never communicates with TON directly —
 * GameEscrow reads go through BlockchainMonitor (+ TonGameContractAdapter).
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
        gameContractManager = null,
        contractSettlementManager = null,
        blockchainMonitor = null,
        financialPersistence = null,
        tonNetwork = null,
        devMode = false
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

        this._gameContractManager = gameContractManager;

        this._contractSettlementManager = contractSettlementManager;

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

    /**
     * R8.8 — Late-bind settlement/contract refs for financial retention checks.
     */
    setFinancialEvidenceDeps({
        gameContractManager = null,
        contractSettlementManager = null
    } = {}) {

        if (gameContractManager) {

            this._gameContractManager = gameContractManager;

        }

        if (contractSettlementManager) {

            this._contractSettlementManager = contractSettlementManager;

        }

    }

    _shouldPreserveFinancialEvidence(roomId) {

        return shouldPreserveFinancialEvidence({
            roomId,
            gameManager: this._gameManager,
            contractSettlementManager: this._contractSettlementManager,
            gameContractManager: this._gameContractManager,
            paymentSessionManager: this
        });

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

                printDeployBlock("SUBSCRIBER EXECUTING — PaymentSessionManager", {
                    EventName: EVENT_TYPES.GAME_CONTRACT_DEPLOY_FAILED,
                    Subscriber: "PaymentSessionManager.initialize → failSession",
                    RoomId: envelope.payload?.roomId ?? null,
                    Reason: envelope.payload?.reason ?? null,
                    Timestamp: new Date().toISOString()
                });

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

        // R7.69A — GameEscrow STAKE is authoritative; PSM only synchronizes.
        this._subscribe(
            EVENT_TYPES.GAME_ESCROW_STAKE_CONFIRMED,
            (envelope) => this._handlePaymentTransactionConfirmed(envelope.payload)
        );

        // R7.69C — GameEscrow refunds are authoritative; PSM only synchronizes.
        this._subscribe(
            EVENT_TYPES.GAME_ESCROW_REFUND_CONFIRMED,
            (envelope) => this._handleGameEscrowRefundConfirmed(envelope.payload)
        );

        this._subscribe(
            EVENT_TYPES.GAME_ESCROW_CANCEL_CONFIRMED,
            (envelope) => this._handleGameEscrowCancelConfirmed(envelope.payload)
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

            this._logger.decisionTrace({
                stage: "PAYMENT_SESSION_CREATED",
                decision: "CREATED",
                reason: "Payment session created after PAYMENT_CONNECTION_READY.",
                caller: "PaymentSessionManager.createPaymentSession",
                nextAction: contractAddress || contract?.contractAddress
                    ? "Activate payment requests"
                    : "Emit PAYMENT_SESSION_UPDATED → deploy pipeline",
                roomId,
                gameId: resolvedGameId
            });

            if (contractAddress || contract?.contractAddress) {

                this._activatePaymentRequests(session, {
                    contractAddress: contractAddress ?? contract.contractAddress,
                    paymentDeadline: deadline
                });

            } else {

                // P6.3/P6.5 — seats are PAYMENT_REQUESTED without a contract yet.
                // GameContractManager listens only to PAYMENT_SESSION_UPDATED and
                // starts deploy from that snapshot; without this emit the lobby
                // flow never leaves CREATED (chicken-egg with activation).
                this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

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

            const created = this.createPaymentSession(roomId, { gameId });

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
                rewatched: 0,
                syncedFromChain: 0
            });

        }

        const records = this._financialPersistence.listActive(
            TON_FINANCIAL_RECORD_TYPES.PAYMENT_SESSION
        );

        let restored = 0;

        let recovered = 0;

        let rewatched = 0;

        const pendingSync = [];

        for (const record of records) {

            try {

                const session = PaymentSession.fromRecord(record);

                if (this._sessionsByRoom.has(session.roomId)) {

                    continue;

                }

                // R7.69C — restore CANCELLED sessions for refund sync / watch recovery.
                const isCancelled = session.status === PAYMENT_SESSION_STATUS.CANCELLED;

                if (session.isTerminal() && !isCancelled) {

                    continue;

                }

                if (
                    !isCancelled
                    && !session.isInProgress()
                    && session.status !== PAYMENT_SESSION_STATUS.RECOVERED
                ) {

                    session.status = PAYMENT_SESSION_STATUS.RECOVERED;

                }

                if (session.status === PAYMENT_SESSION_STATUS.RECOVERED) {

                    recovered += 1;

                }

                // R7.69B — restore seat indices for GameEscrow paidMask mapping.
                session.participants.forEach((participant, index) => {

                    if (participant.playerIndex == null) {

                        participant.playerIndex = index;

                    }

                });

                this._indexSession(session);

                if (
                    !isCancelled
                    && session.paymentDeadline
                    && session.paymentDeadline > Date.now()
                ) {

                    this._scheduleExpiry(session);

                }

                pendingSync.push(session);

                this._emitDomain(EVENT_TYPES.PAYMENT_SESSION_RECOVERED, session);

                restored += 1;

            } catch (error) {

                this._logger.error(
                    `PaymentSession restore skipped | id=${record?.recordId} | `
                        + `${error?.message ?? error}`
                );

            }

        }

        return this._finishPaymentSessionRestore({
            restored,
            recovered,
            rewatched,
            pendingSync
        });

    }

    /**
     * R7.69B — Finish restore: sync paid seats from GameEscrow, then rewatch unpaid.
     * Returns a Promise when chain sync is available; otherwise a sync summary.
     */
    _finishPaymentSessionRestore({
        restored,
        recovered,
        rewatched,
        pendingSync
    }) {

        const applyWatches = (syncedFromChain = 0) => {

            let watchCount = rewatched;

            for (const session of pendingSync) {

                if (
                    !session.isInProgress()
                    && session.status !== PAYMENT_SESSION_STATUS.CANCELLED
                ) {

                    continue;

                }

                const contract = this._resolveContract(session.roomId, session.contractId);

                const contractAddress = contract?.contractAddress
                    ?? session.participants?.[0]?.contractAddress
                    ?? null;

                if (contractAddress) {

                    if (session.status !== PAYMENT_SESSION_STATUS.CANCELLED) {

                        watchCount += this._registerBlockchainWatches(session, contractAddress);

                    }

                }

            }

            this._log(
                `RESTORE | restored=${restored} | recovered=${recovered} | `
                    + `rewatched=${watchCount} | syncedFromChain=${syncedFromChain}`
            );

            return Object.freeze({
                restored,
                recovered,
                rewatched: watchCount,
                syncedFromChain
            });

        };

        if (
            pendingSync.length === 0
            || !this._blockchainMonitor?.readGameEscrowPaymentState
        ) {

            return applyWatches(0);

        }

        return (async () => {

            let syncedFromChain = 0;

            for (const session of pendingSync) {

                try {

                    const sync = await this.syncFromGameEscrow(session.roomId);

                    syncedFromChain += sync?.synced ?? 0;

                } catch (error) {

                    this._logger?.warn?.(
                        `GameEscrow payment sync skipped on restore | `
                            + `roomId=${session.roomId} | ${error?.message ?? error}`
                    );

                }

            }

            return applyWatches(syncedFromChain);

        })();

    }

    /**
     * R7.69B — Align PaymentSession participants with GameEscrow paidMask.
     * GameEscrow is authoritative; backend cache never overrides chain.
     */
    async syncFromGameEscrow(roomId, {
        contractAddress: explicitAddress = null
    } = {}) {

        this._assertInitialized();

        const session = this._sessionsByRoom.get(roomId);

        if (!session) {

            return Object.freeze({
                ok: false,
                synced: 0,
                demoted: 0,
                reason: "no_active_session"
            });

        }

        // R7.69C — allow cancel sync after FULLY_PAID (READY on-chain) before settle.
        if (
            !session.isInProgress()
            && session.status !== PAYMENT_SESSION_STATUS.FULLY_PAID
            && session.status !== PAYMENT_SESSION_STATUS.CANCELLED
        ) {

            return Object.freeze({
                ok: false,
                synced: 0,
                demoted: 0,
                reason: "no_active_session"
            });

        }

        const contract = this._resolveContract(session.roomId, session.contractId);

        const contractAddress = explicitAddress
            ?? contract?.contractAddress
            ?? session.participants.find((p) => p.contractAddress)?.contractAddress
            ?? null;

        if (!contractAddress) {

            return Object.freeze({
                ok: false,
                synced: 0,
                demoted: 0,
                reason: "no_contract_address"
            });

        }

        if (session.status === PAYMENT_SESSION_STATUS.CANCELLED) {

            const cancelSync = await this._syncCancelFromGameEscrow(session, contractAddress);

            return Object.freeze({
                ok: true,
                synced: 0,
                demoted: 0,
                cancelled: true,
                refundSynced: cancelSync.refundSynced ?? 0,
                refundMask: cancelSync.refundMask ?? null
            });

        }

        if (!this._blockchainMonitor?.readGameEscrowPaymentState) {

            return Object.freeze({
                ok: false,
                synced: 0,
                demoted: 0,
                reason: "monitor_unavailable"
            });

        }

        let chainState;

        try {

            chainState = await this._blockchainMonitor.readGameEscrowPaymentState(
                contractAddress,
                { playerCount: session.participants.length }
            );

        } catch (error) {

            this._logger?.warn?.(
                `GameEscrow payment state read failed | roomId=${roomId} | `
                    + `${error?.message ?? error}`
            );

            return Object.freeze({
                ok: false,
                synced: 0,
                demoted: 0,
                reason: error?.message ?? "chain_read_failed"
            });

        }

        if (!chainState) {

            return Object.freeze({
                ok: false,
                synced: 0,
                demoted: 0,
                reason: "chain_state_unavailable"
            });

        }

        let synced = 0;

        let demoted = 0;

        let changed = false;

        session.participants.forEach((participant, index) => {

            if (participant.playerIndex == null) {

                participant.playerIndex = index;

            }

            const seatIndex = Number(participant.playerIndex);

            const bit = 1 << seatIndex;

            const onChainPaid = (Number(chainState.paidMask) & bit) !== 0;

            const playerDetail = chainState.players?.find(
                (entry) => Number(entry.index) === seatIndex
            );

            const paid = playerDetail?.paid === true || onChainPaid;

            if (paid) {

                if (participant.status !== PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED) {

                    this._applyGameEscrowConfirmed(session, participant, {
                        amount: participant.requiredGram
                    });

                    synced += 1;

                    changed = true;

                }

                this._blockchainMonitor?.unwatchPayment?.(roomId, participant.playerId);

            } else if (
                participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
            ) {

                // GameEscrow wins over stale backend cache.
                participant.status = PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION;

                participant.confirmationStatus = PAYMENT_CONFIRMATION_STATUS.NONE;

                participant.confirmedAt = null;

                participant.txHash = null;

                demoted += 1;

                changed = true;

            }

        });

        if (changed) {

            this._persistSession(session, "update");

            this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

            this._maybeCompleteSession(session);

        }

        this._log(
            `GAME_ESCROW_SYNC | roomId=${roomId} | paidMask=${chainState.paidMask} | `
                + `synced=${synced} | demoted=${demoted}`
        );

        const cancelSync = await this._syncCancelFromGameEscrow(session, contractAddress);

        return Object.freeze({
            ok: true,
            synced,
            demoted,
            paidMask: chainState.paidMask,
            totalPaid: chainState.totalPaid,
            requiredTotal: chainState.requiredTotal,
            cancelled: cancelSync.cancelled === true,
            refundSynced: cancelSync.refundSynced ?? 0,
            refundMask: cancelSync.refundMask ?? null
        });

    }

    /**
     * R7.69C — Align PaymentSession with GameEscrow cancel / refundMask.
     * Does not resend refunds; chain is source of truth.
     */
    async _syncCancelFromGameEscrow(session, contractAddress) {

        if (!session || !contractAddress) {

            return Object.freeze({
                cancelled: false,
                refundSynced: 0,
                refundMask: null
            });

        }

        if (!this._blockchainMonitor?.readGameEscrowCancelState) {

            return Object.freeze({
                cancelled: false,
                refundSynced: 0,
                refundMask: null
            });

        }

        let cancelState;

        try {

            cancelState = await this._blockchainMonitor.readGameEscrowCancelState(
                contractAddress,
                { playerCount: session.participants.length }
            );

        } catch (error) {

            this._logger?.warn?.(
                `GameEscrow cancel state read failed | roomId=${session.roomId} | `
                    + `${error?.message ?? error}`
            );

            return Object.freeze({
                cancelled: false,
                refundSynced: 0,
                refundMask: null
            });

        }

        if (!cancelState?.cancelled) {

            return Object.freeze({
                cancelled: false,
                refundSynced: 0,
                refundMask: cancelState?.refundMask ?? null
            });

        }

        let refundSynced = 0;

        let changed = false;

        const refundMask = Number(cancelState.refundMask) || 0;

        session.participants.forEach((participant, index) => {

            if (participant.playerIndex == null) {

                participant.playerIndex = index;

            }

            const seatIndex = Number(participant.playerIndex);

            const bit = 1 << seatIndex;

            const onChainRefunded = (refundMask & bit) !== 0;

            const playerDetail = cancelState.players?.find(
                (entry) => Number(entry.index) === seatIndex
            );

            const refunded = playerDetail?.refunded === true || onChainRefunded;

            if (refunded && participant.refunded !== true) {

                participant.refunded = true;

                refundSynced += 1;

                changed = true;

            }

            this._blockchainMonitor?.unwatchPayment?.(
                session.roomId,
                participant.playerId
            );

        });

        if (session.status !== PAYMENT_SESSION_STATUS.CANCELLED && session.isInProgress()) {

            try {

                session.markCancelled();

                changed = true;

            } catch (error) {

                this._logger?.warn?.(
                    `PaymentSession cancel transition skipped | roomId=${session.roomId} | `
                        + `${error?.message ?? error}`
                );

            }

        }

        if (
            session.status !== PAYMENT_SESSION_STATUS.CANCELLED
            && session.status === PAYMENT_SESSION_STATUS.FULLY_PAID
        ) {

            try {

                session.markCancelled();

                changed = true;

            } catch (error) {

                this._logger?.warn?.(
                    `PaymentSession cancel from FULLY_PAID skipped | roomId=${session.roomId} | `
                        + `${error?.message ?? error}`
                );

            }

        }

        if (changed) {

            this._clearExpiry(session.roomId);

            this._blockchainMonitor?.stopRoom?.(session.roomId);

            this._persistSession(session, "update");

            this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

        }

        this._log(
            `GAME_ESCROW_CANCEL_SYNC | roomId=${session.roomId} | `
                + `refundMask=${refundMask} | refundSynced=${refundSynced}`
        );

        return Object.freeze({
            cancelled: true,
            refundSynced,
            refundMask
        });

    }

    /**
     * R7.69C — Apply a single on-chain refund confirmation (idempotent).
     */
    _handleGameEscrowRefundConfirmed(payload) {

        const roomId = payload?.roomId;

        if (!roomId || !this._initialized) {

            return;

        }

        const session = this._sessionsByRoom.get(roomId);

        if (!session) {

            return;

        }

        let participant = null;

        if (payload.playerId) {

            participant = session.findParticipant(payload.playerId);

        }

        if (!participant && payload.playerIndex != null) {

            participant = session.participants.find(
                (entry) => Number(entry.playerIndex) === Number(payload.playerIndex)
            );

        }

        if (!participant) {

            return;

        }

        if (participant.refunded === true) {

            return;

        }

        participant.refunded = true;

        participant.refundTxHash = payload.transactionId ?? payload.txHash ?? null;

        this._persistSession(session, "update");

        this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

    }

    /**
     * R7.69C — Mark payment session CANCELLED after cancel confirmed on-chain.
     */
    _handleGameEscrowCancelConfirmed(payload) {

        const roomId = payload?.roomId;

        if (!roomId || !this._initialized) {

            return;

        }

        const session = this._sessionsByRoom.get(roomId);

        if (!session || session.status === PAYMENT_SESSION_STATUS.CANCELLED) {

            return;

        }

        if (
            !session.isInProgress()
            && session.status !== PAYMENT_SESSION_STATUS.FULLY_PAID
        ) {

            return;

        }

        try {

            session.markCancelled();

        } catch {

            return;

        }

        this._clearExpiry(session.roomId);

        this._blockchainMonitor?.stopRoom?.(session.roomId);

        this._persistSession(session, "update");

        this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

        this._log(
            `CANCELLED | roomId=${roomId} | paymentSessionId=${session.paymentSessionId}`
        );

    }

    /**
     * R7.69B — Mark seat paid from GameEscrow without emitting stake-confirmed
     * observation events (avoids duplicate GAME_ESCROW_STAKE_CONFIRMED).
     */
    _applyGameEscrowConfirmed(session, participant, { amount = null } = {}) {

        if (participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED) {

            return;

        }

        if (amount != null && Number.isFinite(Number(amount))) {

            participant.paidAmount = Number(amount);

        } else if (!participant.paidAmount) {

            participant.paidAmount = participant.requiredGram;

        }

        participant.confirmationStatus = PAYMENT_CONFIRMATION_STATUS.CONFIRMED;

        participant.confirmedAt = Date.now();

        participant.status = PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED;

        session.addReceivedPayment({
            playerId: participant.playerId,
            walletAddress: participant.wallet,
            amount: participant.paidAmount || participant.requiredGram,
            transactionHash: participant.txHash ?? `game_escrow:${session.roomId}:${participant.playerId}`,
            status: PAYMENT_CONFIRMATION_STATUS.CONFIRMED
        });

        this._lastConfirmationAt = Date.now();

        this._emitDomain(EVENT_TYPES.PAYMENT_CONFIRMED, session, {
            playerId: participant.playerId,
            walletAddress: participant.wallet,
            transactionHash: participant.txHash,
            source: "game_escrow"
        });

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
            gameId: payload?.gameId ?? null
        });

        console.log("[R7.50 DIAG] createAndRequest returned", {
            roomId: payload?.roomId ?? null,
            created: Boolean(session),
            paymentSessionId: session?.paymentSessionId ?? null,
            status: session?.status ?? null,
            timestamp: Date.now()
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
            paymentDeadline: session.paymentDeadline,
            playerIndex: participant.playerIndex ?? null
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

// Re-export typed errors for convenience.
export {
    DuplicatePaymentError,
    PaymentSessionAlreadyExistsError,
    PaymentValidationError,
    UnexpectedPaymentError
} from "./PaymentSessionManagerErrors.js";
