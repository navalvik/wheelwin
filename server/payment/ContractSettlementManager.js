import { randomUUID } from "node:crypto";

import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { OwnerConfiguration } from "../config/OwnerConfiguration.js";
import { GAME_CONTRACT_STATUS } from "../models/GameContract.js";
import { PAYMENT_SESSION_STATUS } from "../models/PaymentSession.js";
import {
    DuplicateSettlementError,
    InvalidSettlementStateTransitionError,
    SettlementAlreadyExistsError,
    SettlementValidationError
} from "./ContractSettlementManagerErrors.js";
import { maskWalletAddress } from "./maskWalletAddress.js";
import { SettlementSession } from "./SettlementSession.js";
import {
    SETTLEMENT_SESSION_STATUS,
    isSettlementSessionTerminal
} from "./SettlementSessionStates.js";
import { TON_FINANCIAL_RECORD_TYPES } from "../persistence/TonFinancialPersistence.js";
import {
    GAME_ESCROW_MODE_GAME,
    GAME_ESCROW_MODE_V4,
    resolveGameEscrowMode
} from "./ton/buildGameEscrowStateInit.js";
import { GAME_CONTRACT_ON_CHAIN_STATUS } from "./ton/gameContract/GameContractOpcodes.js";
import {
    printGameEscrowConfirmationDebug,
    printGameEscrowSettlementDebug,
    setGameEscrowConfirmationDebug,
    setGameEscrowSettlementDebug
} from "../diagnostics/SettlementPipelineForensics.js";
import { shouldPreserveFinancialEvidence } from "../gameplay/financialEvidenceGuards.js";

export const DEFAULT_SETTLEMENT_TIMEOUT_MS = 10 * 60 * 1000;

const PAYMENT_COMPLETE_STATUSES = new Set([
    PAYMENT_SESSION_STATUS.FULLY_PAID,
    PAYMENT_SESSION_STATUS.COMPLETED
]);

/** R10.4 — On-chain settlement probe tri-state (never collapse UNKNOWN→NOT_SETTLED). */
export const ON_CHAIN_SETTLEMENT_PROBE_STATUS = Object.freeze({
    SETTLED: "SETTLED",
    NOT_SETTLED: "NOT_SETTLED",
    UNKNOWN: "UNKNOWN"
});

/**
 * One-game facts for the already-recovered du4w on-chain settlement.
 * Does not broadcast. Uses the confirmed escrow payout hash only.
 */
export const DU4W_RECOVERED_ON_CHAIN_SETTLEMENT = Object.freeze({
    roomId: "du4w",
    gameId: "game_edee03be-c042-4cf5-befb-5dfcd684f36c",
    winnerId: "player_0a1506f0-26f2-48d1-9660-8ae862b82182",
    winnerPayoutGram: 2.85,
    ownerPayoutGram: 0.15,
    escrowAddress: "EQBWeMKZpNcixJiG-JOLE-9qpQ1hp6HXyEiLxgkoCew3914p",
    settlementTransactionHash: "5kHLAKPh04SYY8LlOh18gESVSqHzLdTSCmMXy8tEQxs=",
    originalStatus: SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED,
    originalFailure: "TonCenter HTTP 429",
    originalReason: "settle_failed",
    probeStatus: "READY",
    onChainStatus: "SETTLED"
});

const ON_CHAIN_EXPLICITLY_NOT_SETTLED = new Set([
    GAME_CONTRACT_ON_CHAIN_STATUS.UNINITIALIZED,
    GAME_CONTRACT_ON_CHAIN_STATUS.DEPLOYED,
    GAME_CONTRACT_ON_CHAIN_STATUS.WAITING_PAYMENTS,
    GAME_CONTRACT_ON_CHAIN_STATUS.PAYMENTS_OPEN,
    GAME_CONTRACT_ON_CHAIN_STATUS.PAYMENTS_LOCKED,
    GAME_CONTRACT_ON_CHAIN_STATUS.READY,
    GAME_CONTRACT_ON_CHAIN_STATUS.LOCKED,
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6"
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
        gameManager = null,
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

        this._gameManager = gameManager;

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

    /**
     * R17.9G.1 — Update settlement timeout for newly started settlements only.
     * In-flight settlements keep their already computed deadline.
     */
    setSettlementTimeoutMs(timeoutMs) {

        const next = Number(timeoutMs);

        if (!Number.isFinite(next) || next <= 0) {

            throw new Error(
                "ContractSettlementManager.setSettlementTimeoutMs requires a positive duration"
            );

        }

        this._settlementTimeoutMs = next;

        return this._settlementTimeoutMs;

    }

    getSettlementTimeoutMs() {

        return this._settlementTimeoutMs;

    }

    /**
     * R13.1H — Prefer escrow mode frozen in the game financial snapshot.
     */
    _resolveEscrowMode(contract, request = null) {

        const fromSnapshot = contract?.snapshot?.escrowMode;

        if (
            fromSnapshot === GAME_ESCROW_MODE_GAME
            || fromSnapshot === GAME_ESCROW_MODE_V4
        ) {

            return fromSnapshot;

        }

        const fromRequest = request?.gameEscrowMode;

        if (
            fromRequest === GAME_ESCROW_MODE_GAME
            || fromRequest === GAME_ESCROW_MODE_V4
        ) {

            return fromRequest;

        }

        return this._gameEscrowMode;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.WINNER_DETERMINED,
            (envelope) => {

                // R9.2 — sync durable handoff before any async adapter work.
                this._onWinnerDetermined(envelope.payload);

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

    /**
     * Record a confirmed on-chain settlement after SETTLEMENT_FAILED.
     * Preserves the original failure on the same record. Does not broadcast.
     */
    async reconcileRecoveredOnChainSettlement(facts = {}) {

        const gameId = facts.gameId;

        const settlementTransactionHash = facts.settlementTransactionHash ?? null;

        if (!gameId || !settlementTransactionHash) {

            return null;

        }

        let session = this._byGameId.get(gameId) ?? null;

        if (!session) {

            const record = this._tryLoadSettlementRecord(gameId);

            if (!record) {

                this._log(
                    `Settlement reconcile skipped — no persisted session | `
                        + `gameId=${gameId}`
                );

                return null;

            }

            session = SettlementSession.fromRecord(record);

        }

        if (session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED) {

            if (
                session.settlementTransactionHash
                && session.settlementTransactionHash !== settlementTransactionHash
            ) {

                this._logger.error(
                    `Settlement reconcile refused — hash mismatch | `
                        + `gameId=${gameId} | `
                        + `existing=${session.settlementTransactionHash} | `
                        + `given=${settlementTransactionHash}`
                );

                return session;

            }

            this._rememberRecoveredSettlement(session, settlementTransactionHash);

            return session;

        }

        if (session.status !== SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED) {

            this._logger.error(
                `Settlement reconcile refused — status=${session.status} | `
                    + `gameId=${gameId}`
            );

            return session;

        }

        const winnerAmount = facts.winnerPayoutGram ?? session.prizeAmount;
        const organizerAmount = facts.ownerPayoutGram ?? session.organizerAmount;
        const originalReason = session.reason ?? facts.originalReason ?? null;
        const originalFailedAt = session.failedAt ?? null;

        if (winnerAmount != null) {

            session.prizeAmount = winnerAmount;

        }

        if (organizerAmount != null) {

            session.organizerAmount = organizerAmount;

        }

        if (facts.winnerId && !session.winnerId) {

            session.winnerId = facts.winnerId;

        }

        session.transitionTo(SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED, {
            settlementTransactionHash,
            completedAt: Date.now(),
            recoveryMetadata: Object.freeze({
                originalStatus: SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED,
                originalReason,
                originalFailedAt,
                originalFailure: facts.originalFailure ?? "TonCenter HTTP 429",
                httpStatus: 429,
                recoveredBy: "on_chain_settlement_recovery",
                probeStatus: facts.probeStatus ?? "READY",
                onChainStatus: facts.onChainStatus ?? "SETTLED",
                winnerAmount,
                organizerAmount,
                settlementTransactionHash
            })
        });

        this._rememberRecoveredSettlement(session, settlementTransactionHash);

        this._persistSession(session, "update");

        try {

            this._gameContractManager.completeContract?.(session.roomId);

        } catch (error) {

            this._logger.error(
                `Settlement reconcile contract complete skipped | `
                    + `gameId=${gameId} | ${error?.message ?? error}`
            );

        }

        this._clearExpiry(gameId);

        this._lastSettlementAt = Date.now();

        this._audit(session.roomId, {
            type: "SETTLEMENT_RECOVERED",
            gameId,
            contractId: session.contractId,
            originalStatus: SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED,
            originalReason,
            originalFailure: facts.originalFailure ?? "TonCenter HTTP 429",
            httpStatus: 429,
            probeStatus: facts.probeStatus ?? "READY",
            settlementTxHash: settlementTransactionHash,
            winnerAmount,
            organizerAmount,
            at: Date.now()
        });

        this._audit(session.roomId, {
            type: "SETTLEMENT_COMPLETED",
            gameId,
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
            recovered: true,
            at: session.completedAt,
            finalStatus: SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED
        });

        this._emitDomain(EVENT_TYPES.SETTLEMENT_RECOVERED, session, {
            originalStatus: SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED,
            originalReason,
            probeStatus: facts.probeStatus ?? "READY",
            transactionHash: settlementTransactionHash
        });

        this._emitDomain(EVENT_TYPES.SETTLEMENT_COMPLETED, session, {
            winnerAmount: session.prizeAmount,
            organizerAmount: session.organizerAmount,
            transactionHash: session.settlementTransactionHash,
            recovered: true
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
            recovered: true,
            timestamp: session.completedAt
        });

        this._log(
            `SETTLEMENT_COMPLETED recovered | gameId=${gameId} | `
                + `tx=${settlementTransactionHash} | `
                + `original=${originalReason ?? "SETTLEMENT_FAILED"}`
        );

        return session;

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

    /**
     * R9.4 / R10.4 — After financial recovery phases (contracts available),
     * resume restored CREATED / PREPARING / READY / hashless PENDING sessions.
     * PENDING with a tx hash remains rewatch-only on restore.
     */
    async resumeRestoredSettlements() {

        let attempted = 0;

        let resumed = 0;

        let skipped = 0;

        const sessions = [...this._byGameId.values()];

        for (const session of sessions) {

            if (!this._canResumeRestoredSettlement(session)) {

                skipped += 1;

                continue;

            }

            attempted += 1;

            const ok = await this._resumeRestoredSettlement(session);

            if (ok) {

                resumed += 1;

            } else {

                skipped += 1;

            }

        }

        return Object.freeze({ attempted, resumed, skipped });

    }

    /**
     * R9.4 / R10.4 — Idempotent guards before resume (submit or hashless PENDING).
     */
    _canResumeRestoredSettlement(session) {

        if (!session?.gameId) {

            return false;

        }

        if (!this._byGameId.has(session.gameId)) {

            return false;

        }

        if (session.isTerminal?.() === true) {

            return false;

        }

        if (this._inFlight.has(session.gameId)) {

            return false;

        }

        // Hashed PENDING+ stays rewatch-only (registered during restore).
        if (session.settlementTransactionHash) {

            return false;

        }

        if (session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_CONFIRMED) {

            return false;

        }

        return session.status === SETTLEMENT_SESSION_STATUS.CREATED
            || session.status === SETTLEMENT_SESSION_STATUS.PREPARING
            || session.status === SETTLEMENT_SESSION_STATUS.READY
            || session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING
            || session.status
                === SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING_CONFIRMATION;

    }

    _isHashlessPendingSession(session) {

        if (session?.settlementTransactionHash) {

            return false;

        }

        return session?.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING
            || session?.status
                === SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING_CONFIRMATION;

    }

    /**
     * R9.4 / R10.4 — Resume restored sessions with tri-state on-chain probe.
     * UNKNOWN never authorizes settleContract().
     */
    async _resumeRestoredSettlement(session) {

        if (!this._canResumeRestoredSettlement(session)) {

            return false;

        }

        const ctx = this._buildResumeContext(session);

        if (!ctx) {

            this._logger.error(
                `Settlement resume skipped — context incomplete | `
                    + `gameId=${session.gameId} | status=${session.status}`
            );

            return false;

        }

        this._inFlight.add(session.gameId);

        this._log(
            `Settlement resume starting | gameId=${session.gameId} | `
                + `status=${session.status}`
        );

        try {

            const onChain = await this._probeOnChainSettlement(session, ctx);

            this._log(
                `Settlement on-chain probe | gameId=${session.gameId} | `
                    + `probe=${onChain.status} | `
                    + `tx=${onChain.settlementTxHash ?? "none"}`
            );

            if (onChain.status === ON_CHAIN_SETTLEMENT_PROBE_STATUS.UNKNOWN) {

                this._log(
                    `Settlement resume parked — on-chain UNKNOWN | `
                        + `gameId=${session.gameId} | status=${session.status}`
                );

                return true;

            }

            if (this._isHashlessPendingSession(session)) {

                if (onChain.status === ON_CHAIN_SETTLEMENT_PROBE_STATUS.SETTLED) {

                    await this._resumeHashlessPendingSettled(session, ctx, onChain);

                    return true;

                }

                if (onChain.status === ON_CHAIN_SETTLEMENT_PROBE_STATUS.NOT_SETTLED) {

                    await this._resumeHashlessPendingNotSettled(session, ctx);

                    return true;

                }

                return true;

            }

            if (onChain.status === ON_CHAIN_SETTLEMENT_PROBE_STATUS.SETTLED) {

                await this._adoptOnChainSettlement(session, ctx, onChain);

                return true;

            }

            // NOT_SETTLED — existing submit paths only.
            if (session.status === SETTLEMENT_SESSION_STATUS.CREATED) {

                await this._advanceSettlementAfterHandoff(session, ctx);

            } else if (session.status === SETTLEMENT_SESSION_STATUS.PREPARING) {

                await this._resumeFromPreparing(session, ctx);

            } else if (session.status === SETTLEMENT_SESSION_STATUS.READY) {

                await this._submitSettlementAdapter(session, ctx);

            } else {

                return false;

            }

            return true;

        } catch (error) {

            this._logger.error(
                `Settlement resume failed | gameId=${session.gameId} | `
                    + `${error?.message ?? error}`
            );

            if (session.isInProgress?.()) {

                this._failSettlement(
                    session,
                    `resume_failed:${error?.message ?? "unknown"}`
                );

            }

            return false;

        } finally {

            this._inFlight.delete(session.gameId);

        }

    }

    _buildResumeContext(session) {

        const gameId = session.gameId;

        const roomId = session.roomId
            ?? this._gameplayContextResolver?.resolveRoomByGameId?.(gameId)
            ?? null;

        const contract = this._gameContractManager.getContractByGameId?.(gameId)
            ?? (roomId
                ? this._gameContractManager.getContract?.(roomId)
                : null)
            ?? (session.contractId
                ? this._gameContractManager.getContractById?.(session.contractId)
                : null)
            ?? null;

        if (!contract?.contractAddress || !contract.snapshot) {

            return null;

        }

        const request = session.request ?? null;

        const winnerId = session.winnerId
            ?? request?.winnerId
            ?? null;

        const winnerWallet = session.winnerWallet
            ?? request?.winnerWallet
            ?? null;

        const ownerWallet = session.ownerWallet
            ?? request?.ownerWallet
            ?? contract.snapshot.ownerWallet
            ?? null;

        const winnerAmount = session.prizeAmount
            ?? request?.winnerAmount
            ?? Number(contract.snapshot.payoutAmount);

        const organizerAmount = session.organizerAmount
            ?? request?.organizerAmount
            ?? Number(contract.snapshot.organizerFee);

        const totalPot = session.totalPot
            ?? request?.totalPot
            ?? Number(contract.snapshot.totalPot);

        if (!winnerId || !winnerWallet || !ownerWallet) {

            return null;

        }

        if (!Number.isFinite(winnerAmount) || !Number.isFinite(organizerAmount)) {

            return null;

        }

        return {
            ok: true,
            gameId,
            roomId: roomId ?? contract.roomId,
            contract,
            winnerId,
            winnerWallet,
            ownerWallet,
            winnerAmount,
            organizerAmount,
            totalPot,
            traceSeed: session.traceSeed ?? request?.traceSeed ?? null
        };

    }

    /**
     * R9.6 / R10.4 — Probe escrow via adapter get methods.
     * Returns tri-state status; UNKNOWN never authorizes settleContract().
     */
    async _probeOnChainSettlement(session, ctx) {

        const unknown = () => Object.freeze({
            status: ON_CHAIN_SETTLEMENT_PROBE_STATUS.UNKNOWN,
            settlementTxHash: null
        });

        const address = ctx?.contract?.contractAddress
            ?? session?.request?.contractAddress
            ?? null;

        if (!address || !this._settlementAdapter) {

            return unknown();

        }

        try {

            let state = null;

            if (typeof this._settlementAdapter.getSettlementState === "function") {

                state = await this._settlementAdapter.getSettlementState(address);

            } else if (typeof this._settlementAdapter.getContractState === "function") {

                state = await this._settlementAdapter.getContractState(address);

            } else {

                return unknown();

            }

            if (!state || state.status == null) {

                return unknown();

            }

            const probeStatus = this._classifyOnChainSettlementProbe(state.status);

            if (probeStatus === ON_CHAIN_SETTLEMENT_PROBE_STATUS.UNKNOWN) {

                return unknown();

            }

            const settlementTxHash = state.settlementTxHash
                ?? state.settlementTxId
                ?? state.lastSettlementTxHash
                ?? null;

            return Object.freeze({
                status: probeStatus,
                settlementTxHash: probeStatus
                    === ON_CHAIN_SETTLEMENT_PROBE_STATUS.SETTLED
                    ? settlementTxHash
                    : null
            });

        } catch (error) {

            this._logger.warn?.(
                `On-chain settlement probe failed | gameId=${session?.gameId} | `
                    + `${error?.message ?? error}`
            );

            return unknown();

        }

    }

    _classifyOnChainSettlementProbe(status) {

        if (status == null) {

            return ON_CHAIN_SETTLEMENT_PROBE_STATUS.UNKNOWN;

        }

        if (this._isOnChainSettledStatus(status)) {

            return ON_CHAIN_SETTLEMENT_PROBE_STATUS.SETTLED;

        }

        if (typeof status === "number") {

            if (status === 7) {

                return ON_CHAIN_SETTLEMENT_PROBE_STATUS.UNKNOWN;

            }

            if (status >= 0 && status <= 6) {

                return ON_CHAIN_SETTLEMENT_PROBE_STATUS.NOT_SETTLED;

            }

            return ON_CHAIN_SETTLEMENT_PROBE_STATUS.UNKNOWN;

        }

        const normalized = String(status).toUpperCase();

        if (
            normalized === GAME_CONTRACT_ON_CHAIN_STATUS.SETTLING
            || normalized === "7"
        ) {

            return ON_CHAIN_SETTLEMENT_PROBE_STATUS.UNKNOWN;

        }

        if (ON_CHAIN_EXPLICITLY_NOT_SETTLED.has(normalized)) {

            return ON_CHAIN_SETTLEMENT_PROBE_STATUS.NOT_SETTLED;

        }

        return ON_CHAIN_SETTLEMENT_PROBE_STATUS.UNKNOWN;

    }

    _isOnChainSettledStatus(status) {

        if (status == null) {

            return false;

        }

        if (status === GAME_CONTRACT_ON_CHAIN_STATUS.SETTLED) {

            return true;

        }

        if (typeof status === "number") {

            return status === 8;

        }

        const normalized = String(status).toUpperCase();

        return normalized === "SETTLED" || normalized === "8";

    }

    /**
     * R10.4 — Hashless PENDING + on-chain SETTLED: watch/confirm only (no settleContract).
     * Does not use _adoptOnChainSettlement (READY/pre-submit only).
     */
    async _resumeHashlessPendingSettled(session, ctx, onChain) {

        const settlementTxHash = onChain?.settlementTxHash
            ?? session.settlementTransactionHash
            ?? null;

        this._log(
            `Hashless PENDING adopt via watch | gameId=${session.gameId} | `
                + `status=${session.status} | tx=${settlementTxHash ?? "none"}`
        );

        if (settlementTxHash && !session.settlementTransactionHash) {

            session.settlementTransactionHash = settlementTxHash;

            session.updatedAt = Date.now();

            session.version += 1;

            this._persistSession(session, "update");

        }

        if (this._resolveEscrowMode(ctx.contract, session.request) === GAME_ESCROW_MODE_GAME) {

            if (session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING) {

                session.transitionTo(
                    SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING_CONFIRMATION,
                    {
                        settlementTransactionHash:
                            session.settlementTransactionHash
                    }
                );

                this._persistSession(session, "update");

            }

            const registered = this._registerGameEscrowPayoutWatch(session);

            if (registered <= 0) {

                this._failSettlement(
                    session,
                    "game_escrow_payout_watch_unavailable"
                );

            }

            return;

        }

        if (session.settlementTransactionHash) {

            const registered = this._registerSettlementWatch(session);

            if (registered <= 0) {

                await this._confirmSettlement(
                    session,
                    session.settlementTransactionHash
                );

            }

            return;

        }

        this._log(
            `Hashless PENDING SETTLED without tx hash — awaiting deadline | `
                + `gameId=${session.gameId}`
        );

    }

    /**
     * R10.4 — Hashless PENDING + explicit NOT_SETTLED: settleContract exactly once.
     * PENDING cannot legally return to READY; submit then apply into confirm/watch.
     */
    async _resumeHashlessPendingNotSettled(session, ctx) {

        if (session.settlementTransactionHash) {

            return;

        }

        const {
            contract,
            winnerWallet,
            ownerWallet,
            winnerAmount,
            organizerAmount
        } = ctx;

        const request = session.request ?? Object.freeze({
            gameId: ctx.gameId,
            contractId: contract.contractId,
            contractAddress: contract.contractAddress,
            winnerId: ctx.winnerId,
            winnerWallet,
            ownerWallet,
            winnerAmount,
            organizerAmount,
            totalPot: ctx.totalPot,
            traceSeed: ctx.traceSeed,
            timestamp: session.startedAt ?? Date.now(),
            snapshot: contract.snapshot,
            snapshotHash: contract.snapshotHash ?? null,
            gameEscrowMode: this._resolveEscrowMode(contract)
        });

        session.request = request;

        this._persistSession(session, "update");

        this._log(
            `Hashless PENDING submit once | gameId=${session.gameId} | `
                + `status=${session.status}`
        );

        let adapterResult;

        try {

            adapterResult = await this._settlementAdapter.settleContract(request);

        } catch (error) {

            this._failSettlement(
                session,
                `adapter_threw:${error?.message ?? "unknown"}`
            );

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

        if (this._resolveEscrowMode(contract, request) === GAME_ESCROW_MODE_GAME) {

            if (session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING) {

                session.transitionTo(
                    SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING_CONFIRMATION,
                    { settlementTransactionHash: settlementTxHash }
                );

            } else {

                session.settlementTransactionHash = settlementTxHash;

                session.updatedAt = Date.now();

                session.version += 1;

            }

            this._gameContractManager.markSettlementPending?.(ctx.roomId);

            this._persistSession(session, "update");

            const registered = this._registerGameEscrowPayoutWatch(session);

            if (registered <= 0) {

                this._failSettlement(
                    session,
                    "game_escrow_payout_watch_unavailable"
                );

            }

            return;

        }

        // Non-game PENDING: attach hash in place (PENDING→PENDING illegal).
        session.settlementTransactionHash = settlementTxHash;

        session.updatedAt = Date.now();

        session.version += 1;

        this._gameContractManager.markSettlementPending?.(ctx.roomId);

        this._persistSession(session, "update");

        if (this._blockchainMonitor && settlementTxHash) {

            const registered = this._registerSettlementWatch(session);

            if (registered > 0) {

                return;

            }

        }

        await this._confirmSettlement(session, settlementTxHash);

    }

    /**
     * R9.6 — Chain already settled: advance session to confirmation/watch path
     * without calling settleContract.
     */
    async _adoptOnChainSettlement(session, ctx, onChain) {

        const {
            roomId,
            contract,
            winnerWallet,
            ownerWallet,
            winnerAmount,
            organizerAmount
        } = ctx;

        const settlementTxHash = onChain?.settlementTxHash
            ?? session.settlementTransactionHash
            ?? null;

        this._log(
            `Settlement adopt on-chain SETTLED | gameId=${session.gameId} | `
                + `tx=${settlementTxHash ?? "unknown"}`
        );

        // Reach READY using legal transitions (no new statuses).
        if (session.status === SETTLEMENT_SESSION_STATUS.CREATED) {

            session.transitionTo(SETTLEMENT_SESSION_STATUS.PREPARING);

            this._gameContractManager.markWinnerPending?.(roomId);

            this._persistSession(session, "update");

        }

        if (session.status === SETTLEMENT_SESSION_STATUS.PREPARING) {

            if (!session.request) {

                session.request = Object.freeze({
                    gameId: ctx.gameId,
                    contractId: contract.contractId,
                    contractAddress: contract.contractAddress,
                    winnerId: ctx.winnerId,
                    winnerWallet,
                    ownerWallet,
                    winnerAmount,
                    organizerAmount,
                    totalPot: ctx.totalPot,
                    traceSeed: ctx.traceSeed,
                    timestamp: session.startedAt ?? Date.now(),
                    snapshot: contract.snapshot,
                    snapshotHash: contract.snapshotHash ?? null,
                    gameEscrowMode: this._resolveEscrowMode(contract)
                });

            }

            session.transitionTo(SETTLEMENT_SESSION_STATUS.READY);

            this._persistSession(session, "update");

        }

        if (session.status !== SETTLEMENT_SESSION_STATUS.READY) {

            throw new InvalidSettlementStateTransitionError(
                session.settlementSessionId,
                session.status,
                SETTLEMENT_SESSION_STATUS.READY
            );

        }

        // Reuse post-adapter confirmation path without broadcasting.
        await this._applySettlementAdapterResult(session, ctx, {
            ok: true,
            settlementTxId: settlementTxHash,
            txHash: settlementTxHash
        });

    }

    /**
     * R9.2 — Synchronous entry: validate + persist SettlementSession handoff
     * before yielding to the async adapter pipeline.
     */
    _onWinnerDetermined(payload) {

        const gameId = payload?.gameId;

        if (!gameId || !this._initialized) {

            return;

        }

        if (this._hasAuthoritativeSettledRecord(gameId)) {

            const settled = this._byGameId.get(gameId)
                ?? SettlementSession.fromRecord(
                    this._tryLoadSettlementRecord(gameId)
                );

            if (settled) {

                this._byGameId.set(gameId, settled);

                this._audit(settled.roomId, {
                    type: "SETTLEMENT_DUPLICATE_IGNORED",
                    gameId,
                    contractId: settled.contractId,
                    settlementTxHash: settled.settlementTransactionHash,
                    at: Date.now()
                });

            }

            return;

        }

        const existing = this._byGameId.get(gameId);

        if (existing?.isInProgress() || this._inFlight.has(gameId)) {

            return;

        }

        const validation = this._validateSettlement(gameId, payload);

        if (!validation.ok) {

            this._failWithoutContract(gameId, validation);

            return;

        }

        let session;

        try {

            session = this._createDurableSettlementHandoff(validation);

        } catch (error) {

            this._logger.error(
                `Settlement durable handoff failed | gameId=${gameId} | `
                    + `${error?.message ?? error}`
            );

            this._failWithoutContract(gameId, {
                ...validation,
                ok: false,
                reason: `handoff_persist_failed:${error?.message ?? "unknown"}`
            });

            return;

        }

        this._inFlight.add(gameId);

        void this._advanceSettlementAfterHandoff(session, validation)
            .catch((error) => {

                this._logger.error(
                    `Settlement pipeline failed after handoff | gameId=${gameId} | `
                        + `${error?.message ?? error}`
                );

                if (session && session.isInProgress?.()) {

                    this._failSettlement(
                        session,
                        `pipeline_failed:${error?.message ?? "unknown"}`
                    );

                }

            })
            .finally(() => {

                this._inFlight.delete(gameId);

            });

    }

    /**
     * R9.2 — Create + persist SettlementSession with winner/payout fields
     * before any await. Reuses existing SettlementSession + TonFinancialPersistence.
     */
    _createDurableSettlementHandoff(ctx) {

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

        if (this._byGameId.has(gameId) || this._hasAuthoritativeSettledRecord(gameId)) {

            throw new SettlementAlreadyExistsError(gameId, roomId);

        }

        const startedAt = Date.now();

        const deadline = startedAt + this._settlementTimeoutMs;

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
            gameEscrowMode: this._resolveEscrowMode(contract)
        });

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
            correlationId: contract.correlationId ?? randomUUID(),
            request
        });

        this._byGameId.set(gameId, session);

        this._persistSession(session, "create");

        this._emitDomain(EVENT_TYPES.SETTLEMENT_SESSION_CREATED, session);

        this._scheduleExpiry(session);

        this._log(
            `Settlement durable handoff persisted | gameId=${gameId} | `
                + `winner=${maskWalletAddress(winnerWallet)} | `
                + `status=${session.status}`
        );

        return session;

    }

    async _advanceSettlementAfterHandoff(session, ctx) {

        const {
            gameId,
            roomId,
            contract,
            winnerId,
            winnerWallet,
            ownerWallet,
            winnerAmount,
            organizerAmount,
            totalPot
        } = ctx;

        const startedAt = session.startedAt ?? Date.now();

        session.transitionTo(SETTLEMENT_SESSION_STATUS.PREPARING);

        this._gameContractManager.markWinnerPending?.(roomId);

        this._persistSession(session, "update");

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

        const request = session.request ?? Object.freeze({
            gameId,
            contractId: contract.contractId,
            contractAddress: contract.contractAddress,
            winnerId,
            winnerWallet,
            ownerWallet,
            winnerAmount,
            organizerAmount,
            totalPot,
            traceSeed: ctx.traceSeed,
            timestamp: startedAt,
            snapshot: contract.snapshot,
            snapshotHash: contract.snapshotHash ?? null,
            gameEscrowMode: this._resolveEscrowMode(contract)
        });

        session.request = request;

        session.transitionTo(SETTLEMENT_SESSION_STATUS.READY);

        this._persistSession(session, "update");

        await this._submitSettlementAdapter(session, ctx);

    }

    /**
     * R9.4 — PREPARING → READY → existing adapter submit (no CREATED restart).
     */
    async _resumeFromPreparing(session, ctx) {

        const {
            gameId,
            roomId,
            contract,
            winnerId,
            winnerWallet,
            ownerWallet,
            winnerAmount,
            organizerAmount,
            totalPot
        } = ctx;

        const startedAt = session.startedAt ?? Date.now();

        const request = session.request ?? Object.freeze({
            gameId,
            contractId: contract.contractId,
            contractAddress: contract.contractAddress,
            winnerId,
            winnerWallet,
            ownerWallet,
            winnerAmount,
            organizerAmount,
            totalPot,
            traceSeed: ctx.traceSeed,
            timestamp: startedAt,
            snapshot: contract.snapshot,
            snapshotHash: contract.snapshotHash ?? null,
            gameEscrowMode: this._resolveEscrowMode(contract)
        });

        session.request = request;

        session.transitionTo(SETTLEMENT_SESSION_STATUS.READY);

        this._persistSession(session, "update");

        await this._submitSettlementAdapter(session, ctx);

    }

    /**
     * Shared READY → settleContract path (live handoff + R9.4 READY resume).
     */
    async _submitSettlementAdapter(session, ctx) {

        const {
            contract,
            winnerWallet,
            ownerWallet,
            winnerAmount,
            organizerAmount
        } = ctx;

        if (session.status !== SETTLEMENT_SESSION_STATUS.READY) {

            throw new InvalidSettlementStateTransitionError(
                session.settlementSessionId,
                session.status,
                SETTLEMENT_SESSION_STATUS.READY
            );

        }

        if (session.settlementTransactionHash) {

            this._log(
                `Settlement adapter submit skipped — tx already present | `
                    + `gameId=${session.gameId}`
            );

            return;

        }

        const startedAt = session.startedAt ?? Date.now();

        const request = session.request ?? Object.freeze({
            gameId: ctx.gameId,
            contractId: contract.contractId,
            contractAddress: contract.contractAddress,
            winnerId: ctx.winnerId,
            winnerWallet,
            ownerWallet,
            winnerAmount,
            organizerAmount,
            totalPot: ctx.totalPot,
            traceSeed: ctx.traceSeed,
            timestamp: startedAt,
            snapshot: contract.snapshot,
            snapshotHash: contract.snapshotHash ?? null,
            gameEscrowMode: this._resolveEscrowMode(contract)
        });

        session.request = request;

        const escrowMode = this._resolveEscrowMode(contract, request);

        if (escrowMode === GAME_ESCROW_MODE_GAME) {

            setGameEscrowSettlementDebug({
                mode: escrowMode,
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

        await this._applySettlementAdapterResult(session, ctx, adapterResult);

    }

    async _applySettlementAdapterResult(session, ctx, adapterResult) {

        const {
            gameId,
            roomId,
            contract,
            winnerWallet,
            ownerWallet,
            winnerAmount,
            organizerAmount
        } = ctx;

        const settlementTxHash = adapterResult.settlementTxId
            ?? adapterResult.txHash
            ?? null;

        const escrowMode = this._resolveEscrowMode(contract, session.request);

        if (escrowMode === GAME_ESCROW_MODE_GAME) {

            setGameEscrowSettlementDebug({
                mode: escrowMode,
                escrowAddress: contract.contractAddress,
                winner: winnerWallet,
                owner: ownerWallet,
                winnerAmount,
                ownerAmount: organizerAmount,
                snapshotHash: contract.snapshotHash ?? null,
                transactionHash: settlementTxHash
            });
            printGameEscrowSettlementDebug();

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

    /**
     * Test / internal entry: durable handoff then async pipeline.
     * Production path uses `_onWinnerDetermined` (sync handoff first).
     */
    async _executeSettlement(ctx) {

        const session = this._createDurableSettlementHandoff(ctx);

        await this._advanceSettlementAfterHandoff(session, ctx);

        return session;

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
        const settleContract = this._gameContractManager
            ?.getContractByGameId?.(gameId)
            ?? null;

        if (
            this._resolveEscrowMode(settleContract, session.request)
            === GAME_ESCROW_MODE_GAME
        ) {

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

        const gameIdProbe = payload?.gameId
            ?? this._resolveGameIdByContract(payload?.contractId);

        const sessionProbe = gameIdProbe
            ? this._byGameId.get(gameIdProbe)
            : null;

        const contractProbe = gameIdProbe
            ? this._gameContractManager?.getContractByGameId?.(gameIdProbe)
            : null;

        if (
            this._resolveEscrowMode(contractProbe, sessionProbe?.request)
            !== GAME_ESCROW_MODE_GAME
        ) {

            return;

        }

        const gameId = gameIdProbe;

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

        const gameIdProbe = payload?.gameId
            ?? this._resolveGameIdByContract(payload?.contractId);

        const sessionProbe = gameIdProbe
            ? this._byGameId.get(gameIdProbe)
            : null;

        const contractProbe = gameIdProbe
            ? this._gameContractManager?.getContractByGameId?.(gameIdProbe)
            : null;

        if (
            this._resolveEscrowMode(contractProbe, sessionProbe?.request)
            !== GAME_ESCROW_MODE_GAME
        ) {

            return;

        }

        const gameId = gameIdProbe;

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

    _tryLoadSettlementRecord(gameId) {

        if (!gameId || !this._financialPersistence?.loadSettlementRecord) {

            return null;

        }

        try {

            return this._financialPersistence.loadSettlementRecord(gameId);

        } catch (error) {

            if (error?.name === "RecordNotFoundError") {

                return null;

            }

            throw error;

        }

    }

    _hasAuthoritativeSettledRecord(gameId) {

        const existing = this._byGameId.get(gameId);

        if (existing?.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED) {

            return true;

        }

        const record = this._tryLoadSettlementRecord(gameId);
        const status = record?.payload?.status ?? record?.status;

        return status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED;

    }

    _rememberRecoveredSettlement(session, settlementTransactionHash) {

        this._byGameId.set(session.gameId, session);

        if (session.settlementSessionId && settlementTransactionHash) {

            this._confirmedTxHashes.add(
                `${session.settlementSessionId}:${settlementTransactionHash}`
            );

        }

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

        // R8.6 / R8.8 — Room/SessionFinished must not erase financial evidence
        // while settlement is incomplete or financially activated post-init.
        if (shouldPreserveFinancialEvidence({
            roomId,
            gameManager: this._gameManager,
            contractSettlementManager: this,
            gameContractManager: this._gameContractManager,
            paymentSessionManager: this._paymentSessionManager
        })) {

            return;

        }

        for (const [gameId, session] of this._byGameId.entries()) {

            if (session.roomId === roomId) {

                // Preserve non-terminal sessions even if game record is gone.
                if (session.isInProgress?.() === true
                    || !isSettlementSessionTerminal(session.status)) {

                    continue;

                }

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
