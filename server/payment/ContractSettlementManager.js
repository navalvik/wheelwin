import { randomUUID } from "node:crypto";

import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { OwnerConfiguration } from "../config/OwnerConfiguration.js";
import { GAME_CONTRACT_STATUS } from "../models/GameContract.js";
import { PAYMENT_SESSION_STATUS } from "../models/PaymentSession.js";
import {
    DuplicateSettlementError,
    SettlementAlreadyExistsError,
    SettlementValidationError
} from "./ContractSettlementManagerErrors.js";
import { maskWalletAddress } from "./maskWalletAddress.js";
import { SettlementSession } from "./SettlementSession.js";
import { SETTLEMENT_SESSION_STATUS } from "./SettlementSessionStates.js";
import { TON_FINANCIAL_RECORD_TYPES } from "../persistence/TonFinancialPersistence.js";
import {
    GAME_ESCROW_MODE_GAME,
    resolveGameEscrowMode
} from "./ton/buildGameEscrowStateInit.js";
import {
    printGameEscrowConfirmationDebug,
    printGameEscrowSettlementDebug,
    setGameEscrowConfirmationDebug,
    setGameEscrowSettlementDebug
} from "../diagnostics/SettlementPipelineForensics.js";

const DEFAULT_SETTLEMENT_TIMEOUT_MS = 10 * 60 * 1000;

const PAYMENT_COMPLETE_STATUSES = new Set([
    PAYMENT_SESSION_STATUS.FULLY_PAID,
    PAYMENT_SESSION_STATUS.COMPLETED
]);

/**
 * P6.8B / T2.8 — Authoritative post-winner settlement orchestration.
 *
 * Never determines winner. Never polls blockchain. Never uses TON SDK directly.
 */
export class ContractSettlementManager {

    constructor({
        logger,
        eventBus,
        gameContractManager,
        winnerEngine,
        configurationEngine = null,
        settlementAdapter,
        blockchainMonitor = null,
        deployerWalletAddress = null,
        financialPersistence = null,
        auditLedger = null,
        paymentSessionManager = null,
        walletManager = null,
        gameplayContextResolver = null,
        ownerConfiguration = OwnerConfiguration,
        tonNetwork = null,
        gameEscrowMode = null,
        settlementTimeoutMs = DEFAULT_SETTLEMENT_TIMEOUT_MS,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._gameContractManager = gameContractManager;

        this._winnerEngine = winnerEngine;

        this._configurationEngine = configurationEngine;

        this._settlementAdapter = settlementAdapter;

        this._blockchainMonitor = blockchainMonitor;

        // R7.62 — settlement account tx hash lives on the deployer wallet (not escrow).
        this._deployerWalletAddress = typeof deployerWalletAddress === "string"
            && deployerWalletAddress.trim()
            ? deployerWalletAddress.trim()
            : null;

        this._financialPersistence = financialPersistence;

        this._auditLedger = auditLedger;

        this._paymentSessionManager = paymentSessionManager;

        this._walletManager = walletManager;

        this._gameplayContextResolver = gameplayContextResolver;

        this._ownerConfiguration = ownerConfiguration;

        this._tonNetwork = tonNetwork ?? null;

        // R7.66F — v4 (default) keeps legacy settle; game uses GameEscrow SETTLE ABI.
        this._gameEscrowMode = resolveGameEscrowMode(gameEscrowMode);

        this._settlementTimeoutMs = Number.isFinite(settlementTimeoutMs)
            && settlementTimeoutMs > 0
            ? settlementTimeoutMs
            : DEFAULT_SETTLEMENT_TIMEOUT_MS;

        this._devMode = devMode;

        this._byGameId = new Map();

        this._expiryTimers = new Map();

        this._confirmedTxHashes = new Set();

        this._inFlight = new Set();

        this._lastSettlementAt = null;

        this._handlers = [];

        this._initialized = false;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.WINNER_DETERMINED,
            (envelope) => {

                void this._handleWinnerDetermined(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.SETTLEMENT_TRANSACTION_CONFIRMED,
            (envelope) => this._handleSettlementTransactionConfirmed(envelope.payload)
        );

        this._subscribe(
            EVENT_TYPES.GAME_ESCROW_SETTLEMENT_VERIFIED,
            (envelope) => this._handleGameEscrowSettlementVerified(envelope.payload)
        );

        this._subscribe(
            EVENT_TYPES.GAME_ESCROW_SETTLEMENT_REJECTED,
            (envelope) => this._handleGameEscrowSettlementRejected(envelope.payload)
        );

        this._subscribe(
            EVENT_TYPES.TRANSACTION_FAILED,
            (envelope) => this._handleTransactionFailed(envelope.payload)
        );

        this._subscribe(
            EVENT_TYPES.BLOCKCHAIN_CONTRACT_STATE_CHANGED,
            (envelope) => this._handleContractStateChanged(envelope.payload)
        );

        this._subscribe(
            EVENT_TYPES.ROOM_DESTROYED,
            (envelope) => this._forgetByRoom(envelope.payload?.roomId)
        );

        this._subscribe(
            EVENT_TYPES.SESSION_FINISHED,
            (envelope) => this._forgetByRoom(envelope.payload?.roomId)
        );

        this._subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            () => this._reset()
        );

        this._initialized = true;

    }

    shutdown() {

        for (const subscription of this._handlers) {

            this._eventBus.unsubscribe(subscription.event, subscription.handler);

        }

        this._handlers = [];

        this._reset();

        this._initialized = false;

    }

    getSettlement(gameId) {

        const session = this._byGameId.get(gameId) ?? null;

        return session ? session.toLegacyRecord() : null;

    }

    getSettlementSession(gameId) {

        return this._byGameId.get(gameId) ?? null;

    }

    listSettlementSnapshots() {

        return [...this._byGameId.keys()]
            .map((gameId) => this.getReconnectSnapshot(gameId))
            .filter(Boolean);

    }

    getActiveSettlementCount() {

        let count = 0;

        for (const session of this._byGameId.values()) {

            if (session.isInProgress()) {

                count += 1;

            }

        }

        return count;

    }

    getReconnectSnapshot(gameId) {

        const session = this._byGameId.get(gameId);

        if (!session) {

            return null;

        }

        return Object.freeze({
            gameId: session.gameId,
            roomId: session.roomId,
            contractId: session.contractId,
            status: session.status,
            winnerId: session.winnerId,
            winnerAmount: session.prizeAmount,
            organizerAmount: session.organizerAmount,
            settlementTxHash: session.settlementTransactionHash,
            startedAt: session.startedAt,
            completedAt: session.completedAt,
            failedAt: session.failedAt,
            reason: session.reason
        });

    }

    health() {

        let activeSettlements = 0;

        let pendingSettlements = 0;

        let completedSettlements = 0;

        let failedSettlements = 0;

        let recoveredSettlements = 0;

        for (const session of this._byGameId.values()) {

            if (session.isInProgress()) {

                activeSettlements += 1;

            }

            if (session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING) {

                pendingSettlements += 1;

            }

            if (session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED) {

                completedSettlements += 1;

            }

            if (
                session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED
                || session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_TIMEOUT
            ) {

                failedSettlements += 1;

            }

            if (session.status === SETTLEMENT_SESSION_STATUS.RECOVERED) {

                recoveredSettlements += 1;

            }

        }

        return Object.freeze({
            activeSettlements,
            pendingSettlements,
            completedSettlements,
            failedSettlements,
            recoveredSettlements,
            lastSettlement: this._lastSettlementAt,
            network: this._tonNetwork
        });

    }

    getDashboardSnapshot(gameId = null) {

        const sessions = gameId
            ? [this._byGameId.get(gameId)].filter(Boolean)
            : [...this._byGameId.values()];

        return Object.freeze({
            gameId,
            health: this.health(),
            sessions: Object.freeze(
                sessions.map((session) => session.toDashboardSnapshot())
            )
        });

    }

    restoreSettlementSessions() {

        if (!this._financialPersistence) {

            return Object.freeze({
                restored: 0,
                recovered: 0,
                rewatched: 0
            });

        }

        const records = this._financialPersistence.listActive(
            TON_FINANCIAL_RECORD_TYPES.SETTLEMENT
        );

        let restored = 0;

        let recovered = 0;

        let rewatched = 0;

        for (const record of records) {

            try {

                const session = SettlementSession.fromRecord(record);

                if (this._byGameId.has(session.gameId)) {

                    continue;

                }

                if (session.isTerminal()) {

                    continue;

                }

                if (!session.isInProgress() && session.status !== SETTLEMENT_SESSION_STATUS.RECOVERED) {

                    session.status = SETTLEMENT_SESSION_STATUS.RECOVERED;

                }

                if (session.status === SETTLEMENT_SESSION_STATUS.RECOVERED) {

                    recovered += 1;

                }

                this._byGameId.set(session.gameId, session);

                if (session.settlementDeadline && session.settlementDeadline > Date.now()) {

                    this._scheduleExpiry(session);

                }

                if (
                    session.settlementTransactionHash
                    && session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING
                ) {

                    rewatched += this._registerSettlementWatch(session);

                }

                if (
                    session.status
                        === SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING_CONFIRMATION
                ) {

                    rewatched += this._registerGameEscrowPayoutWatch(session);

                }

                this._emitDomain(EVENT_TYPES.SETTLEMENT_RECOVERED, session);

                restored += 1;

            } catch (error) {

                this._logger.error(
                    `Settlement restore skipped | id=${record?.recordId} | `
                        + `${error?.message ?? error}`
                );

            }

        }

        return Object.freeze({ restored, recovered, rewatched });

    }

    async _handleWinnerDetermined(payload) {

        const gameId = payload?.gameId;

        if (!gameId || !this._initialized) {

            return;

        }

        const existing = this._byGameId.get(gameId);

        if (existing?.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED) {

            this._audit(existing.roomId, {
                type: "SETTLEMENT_DUPLICATE_IGNORED",
                gameId,
                contractId: existing.contractId,
                at: Date.now()
            });

            return;

        }

        if (existing?.isInProgress() || this._inFlight.has(gameId)) {

            return;

        }

        const validation = this._validateSettlement(gameId, payload);

        if (!validation.ok) {

            this._failWithoutContract(gameId, validation);

            return;

        }

        this._inFlight.add(gameId);

        try {

            await this._executeSettlement(validation);

        } finally {

            this._inFlight.delete(gameId);

        }

    }

    _validateSettlement(gameId, winnerPayload) {

        const roomId = this._gameplayContextResolver
            ?.resolveRoomByGameId?.(gameId)
            ?? this._gameContractManager.getContractByGameId?.(gameId)?.roomId
            ?? null;

        const contract = this._gameContractManager.getContractByGameId?.(gameId)
            ?? (roomId
                ? this._gameContractManager.getContract?.(roomId)
                : null);

        if (!contract) {

            return { ok: false, gameId, roomId, reason: "contract_missing" };

        }

        if (!contract.snapshot) {

            return {
                ok: false,
                gameId,
                roomId: contract.roomId,
                contractId: contract.contractId,
                reason: "snapshot_missing"
            };

        }

        if (!contract.contractAddress) {

            return {
                ok: false,
                gameId,
                roomId: contract.roomId,
                contractId: contract.contractId,
                reason: "contract_not_deployed"
            };

        }

        if (contract.status !== GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE) {

            return {
                ok: false,
                gameId,
                roomId: contract.roomId,
                contractId: contract.contractId,
                reason: `contract_state_${contract.status}`
            };

        }

        const paymentSession = this._paymentSessionManager?.getSession?.(contract.roomId);

        // R7.69C — ignore cancelled GameEscrow / payment sessions (no settle).
        if (paymentSession?.status === PAYMENT_SESSION_STATUS.CANCELLED) {

            this._audit(contract.roomId, {
                type: "SETTLEMENT_IGNORED_CANCELLED",
                gameId,
                contractId: contract.contractId,
                at: Date.now()
            });

            return {
                ok: false,
                gameId,
                roomId: contract.roomId,
                contractId: contract.contractId,
                reason: "contract_cancelled"
            };

        }

        if (
            paymentSession
            && !PAYMENT_COMPLETE_STATUSES.has(paymentSession.status)
        ) {

            return {
                ok: false,
                gameId,
                roomId: contract.roomId,
                contractId: contract.contractId,
                reason: "payments_not_complete"
            };

        }

        const winnerId = winnerPayload?.winningPlayerId
            ?? winnerPayload?.winnerPlayerId
            ?? this._winnerEngine?.getResult?.(gameId)?.winningPlayer?.playerId
            ?? null;

        if (!winnerId) {

            return {
                ok: false,
                gameId,
                roomId: contract.roomId,
                contractId: contract.contractId,
                reason: "winner_missing"
            };

        }

        const winnerSeat = contract.snapshot.players?.find(
            (player) => String(player.playerId) === String(winnerId)
        );

        const winnerWallet = winnerSeat?.wallet ?? null;

        if (!winnerWallet) {

            return {
                ok: false,
                gameId,
                roomId: contract.roomId,
                contractId: contract.contractId,
                reason: "winner_wallet_missing"
            };

        }

        if (this._walletManager) {

            const walletSession = this._walletManager.getWalletByPlayer?.(
                winnerId,
                contract.roomId
            );

            if (!walletSession || walletSession.status !== "VERIFIED") {

                return {
                    ok: false,
                    gameId,
                    roomId: contract.roomId,
                    contractId: contract.contractId,
                    reason: "winner_wallet_not_verified"
                };

            }

        }

        let ownerWallet = contract.snapshot.ownerWallet ?? null;

        try {

            ownerWallet = ownerWallet
                ?? this._ownerConfiguration.getOwnerWallet();

        } catch {

            ownerWallet = null;

        }

        if (!ownerWallet) {

            return {
                ok: false,
                gameId,
                roomId: contract.roomId,
                contractId: contract.contractId,
                reason: "owner_wallet_missing"
            };

        }

        const winnerAmount = Number(contract.snapshot.payoutAmount);

        const organizerAmount = Number(contract.snapshot.organizerFee);

        if (!Number.isFinite(winnerAmount) || !Number.isFinite(organizerAmount)) {

            return {
                ok: false,
                gameId,
                roomId: contract.roomId,
                contractId: contract.contractId,
                reason: "payout_amounts_invalid"
            };

        }

        const traceSeed = this._configurationEngine
            ?.getConfiguration?.(gameId)?.traceSeed
            ?? this._winnerEngine?.getResult?.(gameId)?.traceSeed
            ?? null;

        return {
            ok: true,
            gameId,
            roomId: contract.roomId,
            contract,
            winnerId,
            winnerWallet,
            ownerWallet,
            winnerAmount,
            organizerAmount,
            totalPot: Number(contract.snapshot.totalPot),
            traceSeed
        };

    }

    async _executeSettlement(ctx) {

        const {
            gameId,
            roomId,
            contract,
            winnerId,
            winnerWallet,
            ownerWallet,
            winnerAmount,
            organizerAmount,
            totalPot,
            traceSeed
        } = ctx;

        if (this._byGameId.has(gameId)) {

            throw new SettlementAlreadyExistsError(gameId, roomId);

        }

        const startedAt = Date.now();

        const deadline = startedAt + this._settlementTimeoutMs;

        const session = new SettlementSession({
            settlementSessionId: `settle_${randomUUID()}`,
            contractId: contract.contractId,
            gameId,
            roomId,
            winnerId,
            winnerWallet,
            prizeAmount: winnerAmount,
            organizerAmount,
            totalPot,
            network: contract.tonNetwork ?? this._tonNetwork,
            status: SETTLEMENT_SESSION_STATUS.CREATED,
            ownerWallet,
            traceSeed,
            startedAt,
            settlementDeadline: deadline,
            correlationId: contract.correlationId ?? randomUUID()
        });

        this._byGameId.set(gameId, session);

        this._persistSession(session, "create");

        this._emitDomain(EVENT_TYPES.SETTLEMENT_SESSION_CREATED, session);

        session.transitionTo(SETTLEMENT_SESSION_STATUS.PREPARING);

        this._gameContractManager.markWinnerPending?.(roomId);

        this._persistSession(session, "update");

        this._scheduleExpiry(session);

        this._audit(roomId, {
            type: "SETTLEMENT_STARTED",
            gameId,
            contractId: contract.contractId,
            winnerId,
            winnerWallet,
            ownerWalletMasked: maskWalletAddress(ownerWallet),
            totalPot,
            winnerAmount,
            organizerAmount,
            at: startedAt
        });

        this._emitDomain(EVENT_TYPES.SETTLEMENT_STARTED, session, {
            winnerAmount,
            organizerAmount
        });

        this._emit(EVENT_TYPES.SETTLEMENT_SUBMITTED, {
            gameId,
            roomId,
            contractId: contract.contractId,
            status: SETTLEMENT_SESSION_STATUS.PREPARING,
            timestamp: Date.now()
        });

        const request = Object.freeze({
            gameId,
            contractId: contract.contractId,
            contractAddress: contract.contractAddress,
            winnerId,
            winnerWallet,
            ownerWallet,
            winnerAmount,
            organizerAmount,
            totalPot,
            traceSeed,
            timestamp: startedAt,
            snapshot: contract.snapshot,
            snapshotHash: contract.snapshotHash ?? null,
            // R7.66F — adapter selects legacy vs GameEscrow SETTLE body.
            gameEscrowMode: this._gameEscrowMode
        });

        session.request = request;

        session.transitionTo(SETTLEMENT_SESSION_STATUS.READY);

        this._persistSession(session, "update");

        if (this._gameEscrowMode === GAME_ESCROW_MODE_GAME) {

            setGameEscrowSettlementDebug({
                mode: this._gameEscrowMode,
                escrowAddress: contract.contractAddress,
                winner: winnerWallet,
                owner: ownerWallet,
                winnerAmount,
                ownerAmount: organizerAmount,
                snapshotHash: contract.snapshotHash ?? null,
                transactionHash: null
            });
            printGameEscrowSettlementDebug();

        }

        let adapterResult;

        try {

            adapterResult = await this._settlementAdapter.settleContract(request);

        } catch (error) {

            this._failSettlement(session, `adapter_threw:${error?.message ?? "unknown"}`);

            return;

        }

        if (!adapterResult?.ok) {

            this._failSettlement(
                session,
                adapterResult?.reason ?? "settlement_adapter_failed"
            );

            return;

        }

        const settlementTxHash = adapterResult.settlementTxId
            ?? adapterResult.txHash
            ?? null;

        if (this._gameEscrowMode === GAME_ESCROW_MODE_GAME) {

            setGameEscrowSettlementDebug({
                mode: this._gameEscrowMode,
                escrowAddress: contract.contractAddress,
                winner: winnerWallet,
                owner: ownerWallet,
                winnerAmount,
                ownerAmount: organizerAmount,
                snapshotHash: contract.snapshotHash ?? null,
                transactionHash: settlementTxHash
            });
            printGameEscrowSettlementDebug();

            // R7.66G — wait for payout proofs; do not complete on submit alone.
            session.transitionTo(
                SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING_CONFIRMATION,
                {
                    settlementTransactionHash: settlementTxHash
                }
            );

            this._gameContractManager.markSettlementPending?.(roomId);

            this._persistSession(session, "update");

            this._emitDomain(EVENT_TYPES.SETTLEMENT_PENDING, session, {
                transactionHash: settlementTxHash,
                pendingConfirmation: true
            });

            setGameEscrowConfirmationDebug({
                escrowAddress: contract.contractAddress,
                settleTxHash: settlementTxHash,
                winnerPayoutTx: null,
                ownerPayoutTx: null,
                confirmedAt: null,
                status: "SETTLEMENT_PENDING_CONFIRMATION"
            });
            printGameEscrowConfirmationDebug();

            this._log(
                `SETTLEMENT_PENDING_CONFIRMATION | gameId=${gameId} | `
                    + `contractId=${contract.contractId} | `
                    + `winner=${maskWalletAddress(winnerWallet)}`
            );

            const registered = this._registerGameEscrowPayoutWatch(session);

            if (registered > 0) {

                return;

            }

            // No monitor available — cannot confirm payouts in game mode.
            this._failSettlement(session, "game_escrow_payout_watch_unavailable");

            return;

        }

        session.transitionTo(SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING, {
            settlementTransactionHash: settlementTxHash
        });

        this._gameContractManager.markSettlementPending?.(roomId);

        this._persistSession(session, "update");

        this._emitDomain(EVENT_TYPES.SETTLEMENT_PENDING, session, {
            transactionHash: settlementTxHash
        });

        this._log(
            `SETTLEMENT_PENDING | gameId=${gameId} | `
                + `contractId=${contract.contractId} | `
                + `winner=${maskWalletAddress(winnerWallet)}`
        );

        if (this._blockchainMonitor && settlementTxHash) {

            const registered = this._registerSettlementWatch(session);

            if (registered > 0) {

                return;

            }

        }

        await this._confirmSettlement(session, settlementTxHash);

    }

    async _confirmSettlement(session, settlementTxHash) {

        if (session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED) {

            return session;

        }

        if (settlementTxHash) {

            const txKey = `${session.settlementSessionId}:${settlementTxHash}`;

            if (this._confirmedTxHashes.has(txKey)) {

                throw new DuplicateSettlementError(session.settlementSessionId, settlementTxHash);

            }

            this._confirmedTxHashes.add(txKey);

        }

        if (session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING
            || session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING_CONFIRMATION) {

            session.transitionTo(SETTLEMENT_SESSION_STATUS.SETTLEMENT_CONFIRMED, {
                settlementTransactionHash: settlementTxHash ?? session.settlementTransactionHash
            });

            this._gameContractManager.updateContractState?.(
                session.roomId,
                GAME_CONTRACT_STATUS.SETTLEMENT_CONFIRMED
            );

            this._persistSession(session, "update");

            this._emitDomain(EVENT_TYPES.SETTLEMENT_CONFIRMED, session, {
                transactionHash: session.settlementTransactionHash
            });

        }

        session.transitionTo(SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED, {
            completedAt: Date.now()
        });

        this._gameContractManager.completeContract?.(session.roomId);

        this._clearExpiry(session.gameId);

        this._lastSettlementAt = Date.now();

        this._persistSession(session, "update");

        this._audit(session.roomId, {
            type: "SETTLEMENT_COMPLETED",
            gameId: session.gameId,
            contractId: session.contractId,
            winnerId: session.winnerId,
            winnerWallet: session.winnerWallet,
            ownerWalletMasked: session.ownerWallet
                ? maskWalletAddress(session.ownerWallet)
                : null,
            totalPot: session.totalPot,
            winnerAmount: session.prizeAmount,
            organizerAmount: session.organizerAmount,
            settlementTxHash: session.settlementTransactionHash,
            at: session.completedAt,
            finalStatus: SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED
        });

        this._emitDomain(EVENT_TYPES.SETTLEMENT_COMPLETED, session, {
            winnerAmount: session.prizeAmount,
            organizerAmount: session.organizerAmount,
            transactionHash: session.settlementTransactionHash
        });

        this._emit(EVENT_TYPES.SETTLEMENT_COMPLETED, {
            gameId: session.gameId,
            roomId: session.roomId,
            contractId: session.contractId,
            status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED,
            winnerId: session.winnerId,
            winnerAmount: session.prizeAmount,
            organizerAmount: session.organizerAmount,
            settlementTxHash: session.settlementTransactionHash,
            timestamp: session.completedAt
        });

        this._log(
            `SETTLEMENT_COMPLETED | gameId=${session.gameId} | `
                + `tx=${session.settlementTransactionHash ?? "none"}`
        );

        this._cleanupAfterSuccess(session.roomId, session);

        return session;

    }

    _handleSettlementTransactionConfirmed(payload) {

        const gameId = payload?.gameId
            ?? this._resolveGameIdByContract(payload?.contractId);

        if (!gameId) {

            return;

        }

        const session = this._byGameId.get(gameId);

        if (!session || !session.isInProgress()) {

            return;

        }

        // R7.66G — GameEscrow completion requires payout proofs, not deployer tx alone.
        if (this._gameEscrowMode === GAME_ESCROW_MODE_GAME) {

            this._log(
                `SETTLEMENT tx seen (awaiting payouts) | gameId=${gameId} | `
                    + `tx=${payload?.transactionId ?? payload?.txHash ?? null}`
            );

            return;

        }

        const txHash = payload?.transactionId ?? payload?.txHash ?? null;

        try {

            void this._confirmSettlement(session, txHash);

        } catch (error) {

            if (error instanceof DuplicateSettlementError) {

                return;

            }

            this._failSettlement(session, error?.message ?? "confirmation_failed");

        }

    }

    _handleGameEscrowSettlementVerified(payload) {

        if (this._gameEscrowMode !== GAME_ESCROW_MODE_GAME) {

            return;

        }

        const gameId = payload?.gameId
            ?? this._resolveGameIdByContract(payload?.contractId);

        if (!gameId) {

            return;

        }

        const session = this._byGameId.get(gameId);

        if (!session || !session.isInProgress()) {

            return;

        }

        const confirmedAt = Date.now();

        setGameEscrowConfirmationDebug({
            escrowAddress: payload?.escrowAddress
                ?? session.request?.contractAddress
                ?? null,
            settleTxHash: payload?.settleTxHash
                ?? session.settlementTransactionHash
                ?? null,
            winnerPayoutTx: payload?.winnerPayoutTx ?? null,
            ownerPayoutTx: payload?.ownerPayoutTx ?? null,
            confirmedAt,
            status: "CONFIRMED"
        });
        printGameEscrowConfirmationDebug();

        try {

            void this._confirmSettlement(
                session,
                payload?.settleTxHash ?? session.settlementTransactionHash
            );

        } catch (error) {

            if (error instanceof DuplicateSettlementError) {

                return;

            }

            this._failSettlement(session, error?.message ?? "payout_confirmation_failed");

        }

    }

    _handleGameEscrowSettlementRejected(payload) {

        if (this._gameEscrowMode !== GAME_ESCROW_MODE_GAME) {

            return;

        }

        const gameId = payload?.gameId
            ?? this._resolveGameIdByContract(payload?.contractId);

        if (!gameId) {

            return;

        }

        const session = this._byGameId.get(gameId);

        if (!session || !session.isInProgress()) {

            return;

        }

        setGameEscrowConfirmationDebug({
            escrowAddress: payload?.escrowAddress
                ?? session.request?.contractAddress
                ?? null,
            settleTxHash: payload?.settleTxHash
                ?? session.settlementTransactionHash
                ?? null,
            winnerPayoutTx: payload?.winnerPayoutTx ?? null,
            ownerPayoutTx: payload?.ownerPayoutTx ?? null,
            confirmedAt: null,
            status: "REJECTED"
        });
        printGameEscrowConfirmationDebug();

        this._failSettlement(
            session,
            payload?.reason ?? "game_escrow_payout_rejected"
        );

    }

    _handleTransactionFailed(payload) {

        if (payload?.kind && payload.kind !== "SETTLEMENT") {

            return;

        }

        const gameId = payload?.gameId
            ?? this._resolveGameIdByContract(payload?.contractId);

        const session = gameId ? this._byGameId.get(gameId) : null;

        if (!session || !session.isInProgress()) {

            return;

        }

        this._failSettlement(session, payload?.reason ?? "transaction_failed");

    }

    _handleContractStateChanged(payload) {

        const gameId = payload?.gameId
            ?? this._resolveGameIdByContract(payload?.contractId);

        const session = gameId ? this._byGameId.get(gameId) : null;

        if (!session || session.isTerminal()) {

            return;

        }

        if (payload?.state === GAME_CONTRACT_STATUS.SETTLEMENT_FAILED) {

            this._failSettlement(session, "contract_state_failed");

        }

    }

    _failWithoutContract(gameId, validation) {

        const roomId = validation.roomId ?? null;

        const failedAt = Date.now();

        const session = new SettlementSession({
            settlementSessionId: `settle_${randomUUID()}`,
            contractId: validation.contractId ?? null,
            gameId,
            roomId,
            winnerId: null,
            winnerWallet: null,
            prizeAmount: null,
            status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED,
            startedAt: failedAt,
            failedAt,
            reason: validation.reason
        });

        this._byGameId.set(gameId, session);

        if (validation.contractId && roomId) {

            this._gameContractManager.failContract?.(roomId, validation.reason);

        }

        this._persistSession(session, "create");

        this._audit(roomId, {
            type: "SETTLEMENT_FAILED",
            gameId,
            contractId: validation.contractId ?? null,
            reason: validation.reason,
            at: failedAt,
            finalStatus: SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED
        });

        this._emitDomain(EVENT_TYPES.SETTLEMENT_FAILED, session, {
            reason: validation.reason
        });

        this._emit(EVENT_TYPES.SETTLEMENT_FAILED, {
            gameId,
            roomId,
            contractId: validation.contractId ?? null,
            status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED,
            reason: validation.reason,
            timestamp: failedAt
        });

        this._log(`SETTLEMENT_FAILED | gameId=${gameId} | reason=${validation.reason}`);

    }

    _failSettlement(session, reason) {

        const failedAt = Date.now();

        if (session.isTerminal()) {

            return;

        }

        this._clearExpiry(session.gameId);

        session.transitionTo(SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED, {
            failedAt,
            reason
        });

        this._gameContractManager.failContract?.(session.roomId, reason);

        this._persistSession(session, "update");

        this._audit(session.roomId, {
            type: "SETTLEMENT_FAILED",
            gameId: session.gameId,
            contractId: session.contractId,
            winnerId: session.winnerId,
            winnerWallet: session.winnerWallet,
            ownerWalletMasked: session.ownerWallet
                ? maskWalletAddress(session.ownerWallet)
                : null,
            totalPot: session.totalPot,
            winnerAmount: session.prizeAmount,
            organizerAmount: session.organizerAmount,
            reason,
            at: failedAt,
            finalStatus: SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED
        });

        this._emitDomain(EVENT_TYPES.SETTLEMENT_FAILED, session, { reason });

        this._emit(EVENT_TYPES.SETTLEMENT_FAILED, {
            gameId: session.gameId,
            roomId: session.roomId,
            contractId: session.contractId,
            status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED,
            reason,
            timestamp: failedAt
        });

        this._log(`SETTLEMENT_FAILED | gameId=${session.gameId} | reason=${reason}`);

        session.request = null;

    }

    _registerSettlementWatch(session) {

        if (!this._blockchainMonitor || !session.settlementTransactionHash) {

            return 0;

        }

        // R7.62 — R7.61 settlementTxId is the deployer account transaction_id.hash.
        // Watch the deployer wallet, not the escrow contract address.
        const address = this._deployerWalletAddress;

        if (!address) {

            this._log(
                `SETTLEMENT watch skipped | gameId=${session.gameId} | `
                    + "reason=deployer_wallet_address_missing"
            );

            return 0;

        }

        this._blockchainMonitor.watchTransaction({
            transactionId: session.settlementTransactionHash,
            address,
            contractId: session.contractId,
            roomId: session.roomId,
            gameId: session.gameId,
            correlationId: session.correlationId,
            kind: "SETTLEMENT",
            timeoutMs: session.settlementDeadline
                ? Math.max(0, session.settlementDeadline - Date.now())
                : null
        });

        this._log(
            `SETTLEMENT watch registered | gameId=${session.gameId} | `
                + `deployer=${address} | tx=${session.settlementTransactionHash}`
        );

        return 1;

    }

    /**
     * R7.66G — Watch escrow for GameEscrow winner/owner payout proofs.
     */
    _registerGameEscrowPayoutWatch(session) {

        if (!this._blockchainMonitor?.watchGameEscrowSettlement) {

            return 0;

        }

        const escrowAddress = session.request?.contractAddress
            ?? null;

        if (!escrowAddress || !session.winnerWallet || !session.ownerWallet) {

            return 0;

        }

        this._blockchainMonitor.watchGameEscrowSettlement({
            escrowAddress,
            settleTxHash: session.settlementTransactionHash,
            winnerAddress: session.winnerWallet,
            ownerAddress: session.ownerWallet,
            winnerAmount: session.prizeAmount,
            ownerAmount: session.organizerAmount,
            contractId: session.contractId,
            roomId: session.roomId,
            gameId: session.gameId,
            correlationId: session.correlationId,
            timeoutMs: session.settlementDeadline
                ? Math.max(0, session.settlementDeadline - Date.now())
                : null
        });

        this._log(
            `GAME_ESCROW payout watch registered | gameId=${session.gameId} | `
                + `escrow=${escrowAddress}`
        );

        return 1;

    }

    _resolveGameIdByContract(contractId) {

        if (!contractId) {

            return null;

        }

        for (const session of this._byGameId.values()) {

            if (session.contractId === contractId) {

                return session.gameId;

            }

        }

        return this._gameContractManager.getContractById?.(contractId)?.gameId ?? null;

    }

    _persistSession(session, operation) {

        if (!this._financialPersistence) {

            return;

        }

        const payload = session.toPayload();

        const metadata = {
            gameId: session.gameId,
            roomId: session.roomId,
            contractId: session.contractId,
            tonNetwork: session.network,
            correlationId: session.correlationId,
            status: session.status
        };

        try {

            if (operation === "create") {

                this._financialPersistence.createSettlementRecord(payload, metadata);

            } else {

                this._financialPersistence.updateSettlementRecord(
                    session.gameId,
                    payload,
                    metadata
                );

            }

        } catch (error) {

            if (error?.name === "RecordNotFoundError" && operation === "update") {

                this._financialPersistence.createSettlementRecord(payload, metadata);

            }

        }

    }

    _scheduleExpiry(session) {

        if (!session.settlementDeadline) {

            return;

        }

        const delay = Math.max(0, session.settlementDeadline - Date.now());

        const timerId = setTimeout(() => {

            this._onExpiry(session.gameId);

        }, delay);

        this._expiryTimers.set(session.gameId, timerId);

    }

    _onExpiry(gameId) {

        this._expiryTimers.delete(gameId);

        const session = this._byGameId.get(gameId);

        if (!session || !session.isInProgress()) {

            return;

        }

        session.transitionTo(SETTLEMENT_SESSION_STATUS.SETTLEMENT_TIMEOUT, {
            failedAt: Date.now(),
            reason: "settlement_timeout"
        });

        this._gameContractManager.failContract?.(session.roomId, "settlement_timeout");

        this._persistSession(session, "update");

        this._emitDomain(EVENT_TYPES.SETTLEMENT_TIMEOUT, session, {
            reason: "settlement_timeout"
        });

        this._emit(EVENT_TYPES.SETTLEMENT_FAILED, {
            gameId: session.gameId,
            roomId: session.roomId,
            contractId: session.contractId,
            status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_TIMEOUT,
            reason: "settlement_timeout",
            timestamp: Date.now()
        });

    }

    _clearExpiry(gameId) {

        const timerId = this._expiryTimers.get(gameId);

        if (timerId) {

            clearTimeout(timerId);

            this._expiryTimers.delete(gameId);

        }

    }

    _cleanupAfterSuccess(roomId, session) {

        session.request = null;

        if (roomId) {

            this._paymentSessionManager?.destroySession?.(roomId);

        }

    }

    _forgetByRoom(roomId) {

        if (!roomId) {

            return;

        }

        for (const [gameId, session] of this._byGameId.entries()) {

            if (session.roomId === roomId) {

                this._clearExpiry(gameId);

                this._byGameId.delete(gameId);

            }

        }

    }

    _emitDomain(type, session, extra = {}) {

        this._emit(type, Object.freeze({
            settlementSessionId: session.settlementSessionId,
            contractId: session.contractId,
            gameId: session.gameId,
            roomId: session.roomId,
            winnerId: session.winnerId,
            winnerWallet: session.winnerWallet,
            transactionHash: session.settlementTransactionHash,
            status: session.status,
            timestamp: Date.now(),
            correlationId: session.correlationId,
            ...extra
        }));

    }

    _audit(roomId, entry) {

        if (!roomId) {

            return;

        }

        this._auditLedger?.append?.(roomId, Object.freeze({
            category: "CONTRACT_SETTLEMENT",
            ...entry
        }));

    }

    _emit(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.CONTRACT_SETTLEMENT_MANAGER,
            type,
            payload
        });

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _reset() {

        for (const gameId of [...this._expiryTimers.keys()]) {

            this._clearExpiry(gameId);

        }

        this._byGameId.clear();

        this._confirmedTxHashes.clear();

        this._inFlight.clear();

    }

    _log(message) {

        this._logger.info(`[ContractSettlementManager] ${message}`);

    }

}

export {
    DuplicateSettlementError,
    SettlementAlreadyExistsError,
    SettlementValidationError
} from "./ContractSettlementManagerErrors.js";
