import { randomUUID } from "node:crypto";

import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS,
    PaymentParticipant,
    PaymentSession
} from "../models/PaymentSession.js";
import { calculateRequiredGram } from "../payment/calculateRequiredGram.js";

const DEFAULT_PAYMENT_SESSION_DURATION_MS = 5 * 60 * 1000;

/**
 * P6.3 — Authoritative Payment Session manager.
 *
 * Owns payment state only. No blockchain, gameplay, or winner logic.
 * Operational map key is roomId (lobby lifecycle). Each session stores gameId.
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
        blockchainMonitor = null,
        sessionWalletStoreForWatch = null,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._playerManager = playerManager;

        this._roomManager = roomManager;

        this._gameplayContextResolver = gameplayContextResolver;

        this._sessionWalletStore = sessionWalletStore
            ?? sessionWalletStoreForWatch;

        this._blockchainMonitor = blockchainMonitor;

        this._durationMs = Number.isFinite(roomConfig?.paymentSessionDurationMs)
            && roomConfig.paymentSessionDurationMs > 0
            ? roomConfig.paymentSessionDurationMs
            : DEFAULT_PAYMENT_SESSION_DURATION_MS;

        this._devMode = devMode;

        // roomId → PaymentSession
        this._sessionsByRoom = new Map();

        // gameId → roomId
        this._roomByGameId = new Map();

        this._expiryTimers = new Map();

        this._handlers = [];

        this._initialized = false;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.PAYMENT_CONNECTION_READY,
            (envelope) => {

                this._handlePaymentConnectionReady(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.GAME_CONTRACT_READY_FOR_PAYMENTS,
            (envelope) => {

                this._handleContractReadyForPayments(envelope.payload);

            }
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
            EVENT_TYPES.PAYMENT_BLOCKCHAIN_CONFIRMED,
            (envelope) => {

                this._handleBlockchainConfirmed(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.PAYMENT_BLOCKCHAIN_REJECTED,
            (envelope) => {

                this._handleBlockchainRejected(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.ROOM_DESTROYED,
            (envelope) => {

                this.destroySession(envelope.payload?.roomId);

            }
        );

        this._subscribe(
            EVENT_TYPES.SESSION_FINISHED,
            (envelope) => {

                this.destroySession(envelope.payload?.roomId);

            }
        );

        this._subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            () => {

                this._reset();

            }
        );

        this._initialized = true;

    }

    shutdown() {

        this._reset();

        for (const subscription of this._handlers) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._handlers = [];

        this._initialized = false;

    }

    getSession(roomId) {

        return this._sessionsByRoom.get(roomId) ?? null;

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
     * Create the Payment Session and issue PAYMENT_REQUEST for every seat.
     */
    createAndRequest(roomId, { gameId = null } = {}) {

        this._assertInitialized();

        if (!roomId) {

            return null;

        }

        if (this._sessionsByRoom.has(roomId)) {

            return this._sessionsByRoom.get(roomId);

        }

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            this._logger.error(
                `PaymentSession create failed | roomId=${roomId} | reason=room_missing`
            );

            return null;

        }

        const resolvedGameId = gameId
            ?? this._gameplayContextResolver?.resolveGameIdByRoomId?.(roomId)
            ?? null;

        if (!resolvedGameId) {

            this._logger.error(
                `PaymentSession create failed | roomId=${roomId} | reason=game_missing`
            );

            return null;

        }

        if (this._roomByGameId.has(resolvedGameId)) {

            const existingRoomId = this._roomByGameId.get(resolvedGameId);

            return this._sessionsByRoom.get(existingRoomId) ?? null;

        }

        const createdAt = Date.now();

        const expiresAt = createdAt + this._durationMs;

        const participants = room.players.map((playerId) => {

            const identity = this._playerManager.getIdentity(playerId);

            const requiredGram = calculateRequiredGram(
                identity?.baseStake,
                identity?.sectorCount ?? 1
            );

            const wallet = this._sessionWalletStore?.getWallet?.(roomId, playerId)
                ?? null;

            return new PaymentParticipant({
                playerId,
                requiredGram: requiredGram ?? 0,
                wallet,
                status: PAYMENT_PARTICIPANT_STATUS.WAITING
            });

        });

        const session = new PaymentSession({
            paymentSessionId: `pay_${randomUUID()}`,
            roomId,
            gameId: resolvedGameId,
            participants,
            createdAt,
            expiresAt,
            status: PAYMENT_SESSION_STATUS.ACTIVE
        });

        this._sessionsByRoom.set(roomId, session);

        this._roomByGameId.set(resolvedGameId, roomId);

        this._scheduleExpiry(session);

        this._emit(EVENT_TYPES.PAYMENT_SESSION_CREATED, session.toSnapshot());

        this._log(
            `CREATED | roomId=${roomId} | gameId=${resolvedGameId} | `
                + `paymentSessionId=${session.paymentSessionId}`
        );

        for (const participant of session.participants) {

            participant.status = PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED;

        }

        // P6.5 — wallet payment requests wait until Game Contract is DEPLOYED.
        this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

        return session;

    }

    /**
     * After DEPLOYED — issue one Telegram Wallet payment request per seat.
     */
    issueDeployedPaymentRequests(roomId, {
        contractAddress,
        paymentDeadline = null
    } = {}) {

        this._assertInitialized();

        const session = this._sessionsByRoom.get(roomId);

        if (!session || session.status !== PAYMENT_SESSION_STATUS.ACTIVE) {

            return null;

        }

        if (!contractAddress) {

            return null;

        }

        const deadline = Number.isFinite(paymentDeadline)
            ? paymentDeadline
            : session.expiresAt;

        if (Number.isFinite(deadline)) {

            session.expiresAt = deadline;

        }

        for (const participant of session.participants) {

            if (
                participant.status !== PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED
                && participant.status !== PAYMENT_PARTICIPANT_STATUS.WAITING
            ) {

                continue;

            }

            participant.contractAddress = contractAddress;

            participant.paymentReference = `payref_${session.paymentSessionId}_${participant.playerId}`;

            participant.status = PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION;

            this._emit(EVENT_TYPES.PAYMENT_REQUEST, {
                paymentSessionId: session.paymentSessionId,
                roomId,
                gameId: session.gameId,
                playerId: participant.playerId,
                requiredGram: participant.requiredGram,
                paymentDeadline: session.expiresAt,
                contractAddress,
                paymentReference: participant.paymentReference
            });

        }

        this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

        this._log(
            `PAYMENT_REQUESTS_ISSUED | roomId=${roomId} | `
                + `address=${contractAddress}`
        );

        return session;

    }

    /**
     * Player confirmed in Telegram Wallet → blockchain pending until monitor confirms.
     */
    submitPlayerConfirmation(roomId, playerId) {

        this._assertInitialized();

        const session = this._sessionsByRoom.get(roomId);

        if (!session || session.status !== PAYMENT_SESSION_STATUS.ACTIVE) {

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

        this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

        participant.status = PAYMENT_PARTICIPANT_STATUS.BLOCKCHAIN_PENDING;

        this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

        const expectedWallet = this._sessionWalletStore?.getWallet?.(roomId, playerId)
            ?? participant.wallet
            ?? null;

        this._blockchainMonitor?.watchPayment?.({
            roomId,
            gameId: session.gameId,
            playerId,
            contractAddress: participant.contractAddress,
            paymentReference: participant.paymentReference,
            expectedGram: participant.requiredGram,
            expectedWallet,
            paymentDeadline: session.expiresAt
        });

        this._log(
            `BLOCKCHAIN_PENDING | roomId=${roomId} | playerId=${playerId}`
        );

        return session;

    }

    /**
     * Authoritative chain confirmation from BlockchainMonitor.
     */
    confirmBlockchainPayment(roomId, playerId, {
        txHash = null
    } = {}) {

        this._assertInitialized();

        const session = this._sessionsByRoom.get(roomId);

        if (!session || session.status !== PAYMENT_SESSION_STATUS.ACTIVE) {

            return null;

        }

        const participant = session.findParticipant(playerId);

        if (!participant) {

            return null;

        }

        if (
            participant.status !== PAYMENT_PARTICIPANT_STATUS.BLOCKCHAIN_PENDING
            && participant.status !== PAYMENT_PARTICIPANT_STATUS.PAYMENT_SUBMITTED
        ) {

            return session;

        }

        if (txHash) {

            participant.txHash = txHash;

        }

        participant.status = PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED;

        this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

        this._blockchainMonitor?.unwatchPayment?.(roomId, playerId);

        if (session.allConfirmed()) {

            session.markCompleted();

            this._clearExpiry(roomId);

            this._blockchainMonitor?.stopRoom?.(roomId);

            this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

            this._emit(EVENT_TYPES.PAYMENT_SESSION_COMPLETED, session.toSnapshot());

            this._log(
                `COMPLETED | roomId=${roomId} | paymentSessionId=${session.paymentSessionId}`
            );

        }

        return session;

    }

    /**
     * Player cancelled Telegram Wallet confirmation — seat stays incomplete.
     */
    reportPlayerCancel(roomId, playerId) {

        this._assertInitialized();

        const session = this._sessionsByRoom.get(roomId);

        if (!session || session.status !== PAYMENT_SESSION_STATUS.ACTIVE) {

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

            this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

        }

        return session;

    }

    failSession(roomId, reason = "payment_failed") {

        const session = this._sessionsByRoom.get(roomId);

        if (!session) {

            return null;

        }

        if (
            session.status === PAYMENT_SESSION_STATUS.FAILED
            || session.status === PAYMENT_SESSION_STATUS.COMPLETED
        ) {

            return session;

        }

        this._clearExpiry(roomId);

        this._blockchainMonitor?.stopRoom?.(roomId);

        session.markFailed();

        this._emit(EVENT_TYPES.PAYMENT_SESSION_UPDATED, session.toSnapshot());

        this._emit(EVENT_TYPES.PAYMENT_SESSION_FAILED, {
            ...session.toSnapshot(),
            reason
        });

        this._log(
            `FAILED | roomId=${roomId} | reason=${reason}`
        );

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

    _handlePaymentConnectionReady(payload) {

        const roomId = payload?.roomId;

        if (!roomId) {

            return;

        }

        this.createAndRequest(roomId, {
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

    _handleBlockchainConfirmed(payload) {

        const roomId = payload?.roomId;

        const playerId = payload?.playerId;

        if (!roomId || !playerId) {

            return;

        }

        this.confirmBlockchainPayment(roomId, playerId, {
            txHash: payload?.txHash ?? null
        });

    }

    _handleBlockchainRejected(payload) {

        // Invalid / expired chain payments are audited by BlockchainMonitor.
        // Payment Session seat stays BLOCKCHAIN_PENDING / AWAITING until timeout
        // or player retry — never invent client-facing chain errors.
        this._log(
            `BLOCKCHAIN_REJECTED | roomId=${payload?.roomId} | `
                + `playerId=${payload?.playerId} | reason=${payload?.reason}`
        );

    }

    _scheduleExpiry(session) {

        const delay = Math.max(0, session.expiresAt - Date.now());

        const timerId = setTimeout(() => {

            this._onExpiry(session.roomId);

        }, delay);

        this._expiryTimers.set(session.roomId, timerId);

    }

    _onExpiry(roomId) {

        this._expiryTimers.delete(roomId);

        const session = this._sessionsByRoom.get(roomId);

        if (!session || session.status !== PAYMENT_SESSION_STATUS.ACTIVE) {

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
