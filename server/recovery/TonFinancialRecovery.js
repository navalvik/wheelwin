/**
 * T2.9 — Financial recovery coordinator.
 *
 * Restores consistency between financial managers after restart or outage.
 * Owns orchestration only — no financial, blockchain, or payment state.
 */

import { randomUUID } from "node:crypto";

import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_CONTRACT_STATUS } from "../models/GameContract.js";
import {
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS
} from "../models/PaymentSession.js";
import {
    TON_FINANCIAL_RECORD_TYPES
} from "../persistence/TonFinancialRecordTypes.js";
import { SETTLEMENT_SESSION_STATUS } from "../payment/SettlementSessionStates.js";
import {
    FinancialRecoveryError,
    RecoveryCheckpointError,
    RecoveryConsistencyError,
    RecoveryManagerUnavailableError,
    RecoveryOrderError,
    RecoveryValidationError
} from "./TonFinancialRecoveryErrors.js";
import {
    FINANCIAL_RECOVERY_PHASE,
    FINANCIAL_RECOVERY_STATE
} from "./TonFinancialRecoveryStates.js";

const BLOCKCHAIN_CHECKPOINT_KIND = "blockchain_monitor";

const TERMINAL_CONTRACT_STATUSES = new Set([
    GAME_CONTRACT_STATUS.ARCHIVED,
    GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED,
    GAME_CONTRACT_STATUS.DEPLOY_FAILED,
    GAME_CONTRACT_STATUS.SETTLEMENT_FAILED
]);

const EMPTY_MONITOR_CHECKPOINT = Object.freeze({
    contracts: Object.freeze([]),
    transactions: Object.freeze([]),
    paymentWatches: Object.freeze([]),
    seenTxByRoom: Object.freeze({}),
    confirmedRefsByRoom: Object.freeze({}),
    emittedObservations: Object.freeze([])
});

/**
 * @typedef {object} TonFinancialRecoveryOptions
 * @property {object} logger
 * @property {import("../events/EventBus.js").EventBus} eventBus
 * @property {import("../session/WalletManager.js").WalletManager} [walletManager]
 * @property {import("../session/SessionWalletStore.js").SessionWalletStore} [sessionWalletStore]
 * @property {import("../gameplay/PaymentSessionManager.js").PaymentSessionManager} [paymentSessionManager]
 * @property {import("../gameplay/GameContractManager.js").GameContractManager} [gameContractManager]
 * @property {import("../payment/ContractSettlementManager.js").ContractSettlementManager} [contractSettlementManager]
 * @property {import("../payment/BlockchainMonitor.js").BlockchainMonitor} [blockchainMonitor]
 * @property {import("../persistence/TonFinancialPersistence.js").TonFinancialPersistence} [financialPersistence]
 * @property {import("../managers/PlayerManager.js").PlayerManager} [playerManager]
 * @property {import("../managers/RoomManager.js").RoomManager} [roomManager]
 */

export class TonFinancialRecovery {

    constructor({
        logger,
        eventBus,
        walletManager = null,
        sessionWalletStore = null,
        paymentSessionManager = null,
        gameContractManager = null,
        contractSettlementManager = null,
        blockchainMonitor = null,
        financialPersistence = null,
        playerManager = null,
        roomManager = null
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._walletManager = walletManager;

        this._sessionWalletStore = sessionWalletStore;

        this._paymentSessionManager = paymentSessionManager;

        this._gameContractManager = gameContractManager;

        this._contractSettlementManager = contractSettlementManager;

        this._blockchainMonitor = blockchainMonitor;

        this._financialPersistence = financialPersistence;

        this._playerManager = playerManager;

        this._roomManager = roomManager;

        this._initialized = false;

        this._state = FINANCIAL_RECOVERY_STATE.NOT_STARTED;

        this._currentPhase = null;

        this._currentRecoveryId = null;

        this._lastRecovery = null;

        this._lastReport = null;

        this._recoveredManagers = Object.freeze([]);

        this._pendingRecoveries = [];

        this._phaseOrderGuard = 0;

    }

    initialize() {

        if (this._initialized) {

            return;

        }

        this._initialized = true;

        this._state = FINANCIAL_RECOVERY_STATE.NOT_STARTED;

    }

    shutdown() {

        this._initialized = false;

        this._state = FINANCIAL_RECOVERY_STATE.NOT_STARTED;

        this._currentPhase = null;

        this._currentRecoveryId = null;

        this._pendingRecoveries = [];

        this._phaseOrderGuard = 0;

    }

    /**
     * Execute the full mandatory recovery pipeline.
     */
    async recover({
        trigger = "server_restart",
        reason = "startup"
    } = {}) {

        this._assertInitialized();

        if (this._state === FINANCIAL_RECOVERY_STATE.RECOVERING) {

            throw new RecoveryOrderError("Financial recovery is already in progress");

        }

        const recoveryId = randomUUID();

        const startedAt = Date.now();

        this._currentRecoveryId = recoveryId;

        this._state = FINANCIAL_RECOVERY_STATE.RECOVERING;

        this._phaseOrderGuard = 0;

        const report = this._createEmptyReport(recoveryId, startedAt, trigger, reason);

        this._emitRecovery(EVENT_TYPES.FINANCIAL_RECOVERY_STARTED, {
            recoveryId,
            phase: FINANCIAL_RECOVERY_PHASE.WALLETS,
            progress: 0,
            timestamp: startedAt,
            trigger,
            reason
        });

        try {

            this._mergePhaseResult(
                report,
                FINANCIAL_RECOVERY_PHASE.WALLETS,
                this.recoverWallets()
            );

            this._mergePhaseResult(
                report,
                FINANCIAL_RECOVERY_PHASE.CONTRACTS,
                this.recoverContracts()
            );

            this._mergePhaseResult(
                report,
                FINANCIAL_RECOVERY_PHASE.PAYMENTS,
                await this.recoverPayments()
            );

            this._mergePhaseResult(
                report,
                FINANCIAL_RECOVERY_PHASE.SETTLEMENTS,
                this.recoverSettlements()
            );

            this._mergePhaseResult(
                report,
                FINANCIAL_RECOVERY_PHASE.BLOCKCHAIN,
                await this.recoverBlockchain()
            );

            this._state = FINANCIAL_RECOVERY_STATE.VALIDATING;

            this._currentPhase = FINANCIAL_RECOVERY_PHASE.VALIDATION;

            this._emitRecovery(EVENT_TYPES.FINANCIAL_RECOVERY_VALIDATION_STARTED, {
                recoveryId,
                phase: FINANCIAL_RECOVERY_PHASE.VALIDATION,
                progress: 0.85,
                timestamp: Date.now()
            });

            const validation = this.validateRecovery();

            report.warnings.push(...validation.warnings);

            report.errors.push(...validation.errors);

            if (validation.consistencyErrors.length > 0) {

                report.errors.push(...validation.consistencyErrors);

            }

            report.duration = Date.now() - startedAt;

            report.timestamp = Date.now();

            const completed = Object.freeze({
                ...report,
                warnings: Object.freeze([...report.warnings]),
                errors: Object.freeze([...report.errors]),
                failedRecoveries: Object.freeze([...report.failedRecoveries])
            });

            this._lastReport = completed;

            this._lastRecovery = Object.freeze({
                recoveryId,
                trigger,
                reason,
                completedAt: completed.timestamp,
                duration: completed.duration,
                success: completed.errors.length === 0
            });

            this._recoveredManagers = Object.freeze(
                this._buildRecoveredManagersList(completed)
            );

            if (completed.errors.length > 0) {

                this._state = FINANCIAL_RECOVERY_STATE.FAILED;

                this._emitRecovery(EVENT_TYPES.FINANCIAL_RECOVERY_FAILED, {
                    recoveryId,
                    phase: FINANCIAL_RECOVERY_PHASE.COMPLETE,
                    progress: 1,
                    timestamp: completed.timestamp,
                    duration: completed.duration,
                    warnings: completed.warnings,
                    errors: completed.errors
                });

                return completed;

            }

            this._state = FINANCIAL_RECOVERY_STATE.COMPLETED;

            this._currentPhase = FINANCIAL_RECOVERY_PHASE.COMPLETE;

            this._emitRecovery(EVENT_TYPES.FINANCIAL_RECOVERY_COMPLETED, {
                recoveryId,
                phase: FINANCIAL_RECOVERY_PHASE.COMPLETE,
                progress: 1,
                timestamp: completed.timestamp,
                duration: completed.duration,
                warnings: completed.warnings,
                errors: completed.errors
            });

            return completed;

        } catch (error) {

            report.duration = Date.now() - startedAt;

            report.timestamp = Date.now();

            report.errors.push(error?.message ?? String(error));

            report.failedRecoveries.push({
                phase: this._currentPhase,
                reason: error?.message ?? String(error)
            });

            const failed = Object.freeze({
                ...report,
                warnings: Object.freeze([...report.warnings]),
                errors: Object.freeze([...report.errors]),
                failedRecoveries: Object.freeze([...report.failedRecoveries])
            });

            this._lastReport = failed;

            this._lastRecovery = Object.freeze({
                recoveryId,
                trigger,
                reason,
                completedAt: failed.timestamp,
                duration: failed.duration,
                success: false
            });

            this._state = FINANCIAL_RECOVERY_STATE.FAILED;

            this._emitRecovery(EVENT_TYPES.FINANCIAL_RECOVERY_FAILED, {
                recoveryId,
                phase: this._currentPhase,
                progress: 1,
                timestamp: failed.timestamp,
                duration: failed.duration,
                warnings: failed.warnings,
                errors: failed.errors
            });

            if (error instanceof FinancialRecoveryError) {

                return failed;

            }

            throw error;

        } finally {

            this._currentRecoveryId = null;

            this._phaseOrderGuard = 0;

        }

    }

    recoverWallets() {

        this._assertInitialized();

        this._assertRecoveryPhaseOrder(1, FINANCIAL_RECOVERY_PHASE.WALLETS);

        this._state = FINANCIAL_RECOVERY_STATE.RESTORING_WALLETS;

        this._currentPhase = FINANCIAL_RECOVERY_PHASE.WALLETS;

        this._emitProgress(FINANCIAL_RECOVERY_PHASE.WALLETS, 0.1);

        try {

            if (this._walletManager?.restoreSessions) {

                const summary = this._walletManager.restoreSessions();

                return Object.freeze({
                    ok: true,
                    restored: summary.restored ?? 0,
                    summary
                });

            }

            if (this._sessionWalletStore?.restore) {

                const summary = this._sessionWalletStore.restore();

                return Object.freeze({
                    ok: true,
                    restored: summary.restored ?? 0,
                    summary
                });

            }

            return Object.freeze({
                ok: true,
                restored: 0,
                warning: "wallet_recovery_skipped_no_manager"
            });

        } catch (error) {

            return Object.freeze({
                ok: false,
                restored: 0,
                error: error?.message ?? String(error)
            });

        }

    }

    recoverContracts() {

        this._assertInitialized();

        this._assertRecoveryPhaseOrder(2, FINANCIAL_RECOVERY_PHASE.CONTRACTS);

        this._state = FINANCIAL_RECOVERY_STATE.RESTORING_CONTRACTS;

        this._currentPhase = FINANCIAL_RECOVERY_PHASE.CONTRACTS;

        this._emitProgress(FINANCIAL_RECOVERY_PHASE.CONTRACTS, 0.25);

        if (!this._gameContractManager?.restoreContracts) {

            return Object.freeze({
                ok: true,
                restored: 0,
                warning: "contract_recovery_skipped_no_manager"
            });

        }

        try {

            const summary = this._gameContractManager.restoreContracts();

            return Object.freeze({
                ok: true,
                restored: summary.restored ?? 0,
                summary
            });

        } catch (error) {

            return Object.freeze({
                ok: false,
                restored: 0,
                error: error?.message ?? String(error)
            });

        }

    }

    async recoverPayments() {

        this._assertInitialized();

        this._assertRecoveryPhaseOrder(3, FINANCIAL_RECOVERY_PHASE.PAYMENTS);

        this._state = FINANCIAL_RECOVERY_STATE.RESTORING_PAYMENTS;

        this._currentPhase = FINANCIAL_RECOVERY_PHASE.PAYMENTS;

        this._emitProgress(FINANCIAL_RECOVERY_PHASE.PAYMENTS, 0.4);

        if (!this._paymentSessionManager?.restorePaymentSessions) {

            return Object.freeze({
                ok: true,
                restored: 0,
                warning: "payment_recovery_skipped_no_manager"
            });

        }

        try {

            const summary = await this._paymentSessionManager.restorePaymentSessions();

            return Object.freeze({
                ok: true,
                restored: summary.restored ?? 0,
                summary
            });

        } catch (error) {

            return Object.freeze({
                ok: false,
                restored: 0,
                error: error?.message ?? String(error)
            });

        }

    }

    recoverSettlements() {

        this._assertInitialized();

        this._assertRecoveryPhaseOrder(4, FINANCIAL_RECOVERY_PHASE.SETTLEMENTS);

        this._state = FINANCIAL_RECOVERY_STATE.RESTORING_SETTLEMENTS;

        this._currentPhase = FINANCIAL_RECOVERY_PHASE.SETTLEMENTS;

        this._emitProgress(FINANCIAL_RECOVERY_PHASE.SETTLEMENTS, 0.55);

        if (!this._contractSettlementManager?.restoreSettlementSessions) {

            return Object.freeze({
                ok: true,
                restored: 0,
                warning: "settlement_recovery_skipped_no_manager"
            });

        }

        try {

            const summary = this._contractSettlementManager.restoreSettlementSessions();

            return Object.freeze({
                ok: true,
                restored: summary.restored ?? 0,
                summary
            });

        } catch (error) {

            return Object.freeze({
                ok: false,
                restored: 0,
                error: error?.message ?? String(error)
            });

        }

    }

    async recoverBlockchain() {

        this._assertInitialized();

        this._assertRecoveryPhaseOrder(5, FINANCIAL_RECOVERY_PHASE.BLOCKCHAIN);

        this._state = FINANCIAL_RECOVERY_STATE.RESTORING_BLOCKCHAIN;

        this._currentPhase = FINANCIAL_RECOVERY_PHASE.BLOCKCHAIN;

        this._emitProgress(FINANCIAL_RECOVERY_PHASE.BLOCKCHAIN, 0.7);

        let checkpointRestored = false;

        let checkpointWarning = null;

        if (this._blockchainMonitor?.restoreCheckpoint) {

            try {

                const checkpoint = this._loadBlockchainCheckpoint()
                    ?? EMPTY_MONITOR_CHECKPOINT;

                this._blockchainMonitor.restoreCheckpoint(checkpoint);

                checkpointRestored = true;

            } catch (error) {

                checkpointWarning = error?.message ?? String(error);

                if (!(error instanceof RecoveryCheckpointError)) {

                    this._logger?.warn?.(
                        `TonFinancialRecovery blockchain checkpoint skipped | ${checkpointWarning}`
                    );

                }

            }

        } else {

            checkpointWarning = "blockchain_recovery_skipped_no_monitor";

        }

        const watchSummary = await this._reregisterBlockchainWatches();

        this._currentPhase = FINANCIAL_RECOVERY_PHASE.WATCHES;

        this._emitProgress(FINANCIAL_RECOVERY_PHASE.WATCHES, 0.8);

        return Object.freeze({
            ok: checkpointWarning === null || checkpointRestored === true,
            checkpointRestored,
            checkpointWarning,
            ...watchSummary
        });

    }

    validateRecovery() {

        this._assertInitialized();

        const warnings = [];

        const errors = [];

        const consistencyErrors = [];

        this._validateWalletSessions(warnings, consistencyErrors);

        this._validatePaymentSessions(warnings, consistencyErrors);

        this._validateContracts(warnings, consistencyErrors);

        this._validateSettlements(warnings, consistencyErrors);

        this._validateBlockchainWatches(warnings, consistencyErrors);

        if (consistencyErrors.length > 0) {

            errors.push(
                new RecoveryConsistencyError(
                    "Financial recovery consistency validation reported issues",
                    { issues: consistencyErrors.length }
                ).message
            );

        }

        return Object.freeze({
            ok: consistencyErrors.length === 0 && errors.length === 0,
            warnings: Object.freeze(warnings),
            errors: Object.freeze(errors),
            consistencyErrors: Object.freeze(consistencyErrors)
        });

    }

    health() {

        const report = this._lastReport;

        return Object.freeze({
            state: this._state,
            currentPhase: this._currentPhase,
            lastRecovery: this._lastRecovery,
            recoveredManagers: this._recoveredManagers,
            pendingRecoveries: Object.freeze([...this._pendingRecoveries]),
            warnings: report?.warnings ?? Object.freeze([]),
            errors: report?.errors ?? Object.freeze([]),
            duration: report?.duration ?? 0
        });

    }

    getRecoveryReport() {

        if (!this._lastReport) {

            return Object.freeze({
                walletSessionsRecovered: 0,
                paymentSessionsRecovered: 0,
                contractsRecovered: 0,
                settlementsRecovered: 0,
                blockchainWatchesRecovered: 0,
                failedRecoveries: Object.freeze([]),
                warnings: Object.freeze([]),
                errors: Object.freeze([]),
                duration: 0,
                timestamp: null
            });

        }

        return Object.freeze({ ...this._lastReport });

    }

    getDashboardSnapshot() {

        const report = this.getRecoveryReport();

        return Object.freeze({
            state: this._state,
            currentPhase: this._currentPhase,
            recoveryId: this._currentRecoveryId,
            lastRecovery: this._lastRecovery,
            recoveredManagers: this._recoveredManagers,
            recoveredObjects: Object.freeze({
                walletSessions: report.walletSessionsRecovered,
                paymentSessions: report.paymentSessionsRecovered,
                contracts: report.contractsRecovered,
                settlements: report.settlementsRecovered,
                blockchainWatches: report.blockchainWatchesRecovered
            }),
            warnings: report.warnings,
            errors: report.errors,
            duration: report.duration,
            lastSuccessfulRecovery: this._lastRecovery?.success === true
                ? this._lastRecovery
                : null
        });

    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    _assertInitialized() {

        if (!this._initialized) {

            throw new FinancialRecoveryError("TonFinancialRecovery is not initialized");

        }

    }

    _assertRecoveryPhaseOrder(expectedStep, phase) {

        if (this._phaseOrderGuard + 1 !== expectedStep) {

            throw new RecoveryOrderError(
                `Recovery phase out of order | expected step ${this._phaseOrderGuard + 1} got ${expectedStep}`,
                { phase, expectedStep, actualGuard: this._phaseOrderGuard }
            );

        }

        this._phaseOrderGuard = expectedStep;

    }

    _createEmptyReport(recoveryId, startedAt, trigger, reason) {

        return {
            recoveryId,
            trigger,
            reason,
            walletSessionsRecovered: 0,
            paymentSessionsRecovered: 0,
            contractsRecovered: 0,
            settlementsRecovered: 0,
            blockchainWatchesRecovered: 0,
            failedRecoveries: [],
            warnings: [],
            errors: [],
            duration: 0,
            timestamp: startedAt
        };

    }

    _mergePhaseResult(report, phase, result) {

        if (result?.warning) {

            report.warnings.push(result.warning);

        }

        if (result?.error) {

            report.errors.push(result.error);

            report.failedRecoveries.push({
                phase,
                reason: result.error
            });

        }

        if (phase === FINANCIAL_RECOVERY_PHASE.WALLETS) {

            report.walletSessionsRecovered += result?.restored ?? 0;

        }

        if (phase === FINANCIAL_RECOVERY_PHASE.CONTRACTS) {

            report.contractsRecovered += result?.restored ?? 0;

        }

        if (phase === FINANCIAL_RECOVERY_PHASE.PAYMENTS) {

            report.paymentSessionsRecovered += result?.restored ?? 0;

        }

        if (phase === FINANCIAL_RECOVERY_PHASE.SETTLEMENTS) {

            report.settlementsRecovered += result?.restored ?? 0;

        }

        if (
            phase === FINANCIAL_RECOVERY_PHASE.BLOCKCHAIN
            && result?.totalWatches !== undefined
        ) {

            report.blockchainWatchesRecovered += result.totalWatches ?? 0;

        }

    }

    _loadBlockchainCheckpoint() {

        if (!this._financialPersistence?.listActive) {

            return null;

        }

        const records = this._financialPersistence.listActive(
            TON_FINANCIAL_RECORD_TYPES.RECOVERY_CHECKPOINT
        );

        const monitorRecords = records
            .map((record) => ({
                record,
                payload: record?.payload ?? {},
                sortKey: record?.payload?.checkpointAt
                    ?? record?.updatedAt
                    ?? record?.createdAt
                    ?? 0
            }))
            .filter(({ payload }) => (
                payload.kind === BLOCKCHAIN_CHECKPOINT_KIND
                || payload.monitorCheckpoint
            ))
            .sort((left, right) => right.sortKey - left.sortKey);

        if (monitorRecords.length === 0) {

            return null;

        }

        const payload = monitorRecords[0].payload;

        const checkpoint = payload.monitorCheckpoint ?? payload;

        if (!checkpoint || typeof checkpoint !== "object") {

            throw new RecoveryCheckpointError("Invalid blockchain monitor checkpoint payload");

        }

        return checkpoint;

    }

    async _reregisterBlockchainWatches() {

        if (!this._blockchainMonitor) {

            return Object.freeze({
                contractWatches: 0,
                paymentWatches: 0,
                settlementWatches: 0,
                refundWatches: 0,
                totalWatches: 0,
                warning: "watch_registration_skipped_no_monitor"
            });

        }

        let contractWatches = 0;

        let paymentWatches = 0;

        let settlementWatches = 0;

        let refundWatches = 0;

        if (this._gameContractManager?.listContracts) {

            for (const contract of this._gameContractManager.listContracts()) {

                if (
                    !contract?.contractId
                    || !contract?.contractAddress
                    || TERMINAL_CONTRACT_STATUSES.has(contract.status)
                ) {

                    continue;

                }

                try {

                    this._blockchainMonitor.registerContract?.(
                        contract.contractId,
                        contract.contractAddress,
                        {
                            roomId: contract.roomId,
                            gameId: contract.gameId,
                            correlationId: contract.correlationId ?? null,
                            expectDeployment: contract.status === GAME_CONTRACT_STATUS.DEPLOYING
                        }
                    );

                    contractWatches += 1;

                } catch (error) {

                    this._logger?.warn?.(
                        `Contract watch registration skipped | `
                            + `contractId=${contract.contractId} | ${error?.message ?? error}`
                    );

                }

            }

        }

        if (this._paymentSessionManager?.listSessionRoomIds) {

            for (const roomId of this._paymentSessionManager.listSessionRoomIds()) {

                const session = this._paymentSessionManager.getSession(roomId);

                if (
                    !session
                    || (
                        !session.isInProgress?.()
                        && session.status !== PAYMENT_SESSION_STATUS.CANCELLED
                        && session.status !== PAYMENT_SESSION_STATUS.FULLY_PAID
                    )
                ) {

                    continue;

                }

                const contract = this._gameContractManager?.getContract?.(roomId);

                const contractAddress = contract?.contractAddress
                    ?? session.contractAddress
                    ?? session.participants?.find?.((p) => p.contractAddress)?.contractAddress
                    ?? null;

                if (!contractAddress) {

                    continue;

                }

                // R7.69B — GameEscrow is payment authority before re-registering watches.
                if (this._paymentSessionManager.syncFromGameEscrow) {

                    try {

                        await this._paymentSessionManager.syncFromGameEscrow(roomId, {
                            contractAddress
                        });

                    } catch (error) {

                        this._logger?.warn?.(
                            `GameEscrow payment sync skipped before watches | `
                                + `roomId=${roomId} | ${error?.message ?? error}`
                        );

                    }

                }

                // Refresh session after possible cancel sync.
                const syncedSession = this._paymentSessionManager.getSession(roomId)
                    ?? session;

                if (syncedSession.status === PAYMENT_SESSION_STATUS.CANCELLED) {

                    // R7.69C — restore refund observation only; never resend refunds.
                    refundWatches += this._registerRefundWatchFromSession(
                        syncedSession,
                        contractAddress
                    );

                    continue;

                }

                for (const participant of syncedSession.participants ?? []) {

                    if (participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED) {

                        continue;

                    }

                    try {

                        this._blockchainMonitor.watchPayment?.({
                            roomId: syncedSession.roomId,
                            gameId: syncedSession.gameId,
                            playerId: participant.playerId,
                            contractAddress,
                            contractId: syncedSession.contractId,
                            correlationId: syncedSession.correlationId,
                            paymentReference: participant.paymentReference,
                            expectedGram: participant.requiredGram,
                            expectedWallet: participant.wallet,
                            paymentDeadline: syncedSession.paymentDeadline,
                            playerIndex: participant.playerIndex ?? null
                        });

                        paymentWatches += 1;

                    } catch (error) {

                        this._logger?.warn?.(
                            `Payment watch registration skipped | roomId=${roomId} | `
                                + `playerId=${participant.playerId} | ${error?.message ?? error}`
                        );

                    }

                }

            }

        }

        if (this._contractSettlementManager?.getSettlementSession) {

            const gameIds = this._contractSettlementManager.listSettlementSnapshots?.()
                ?.map((snapshot) => snapshot.gameId)
                .filter(Boolean)
                ?? [];

            for (const gameId of gameIds) {

                const session = this._contractSettlementManager.getSettlementSession(gameId);

                if (
                    !session
                    || session.status !== SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING
                    || !session.settlementTransactionHash
                ) {

                    continue;

                }

                const contract = this._gameContractManager?.getContract?.(session.roomId);

                try {

                    this._blockchainMonitor.watchTransaction?.({
                        transactionId: session.settlementTransactionHash,
                        address: contract?.contractAddress,
                        contractId: session.contractId,
                        roomId: session.roomId,
                        gameId: session.gameId,
                        correlationId: session.correlationId,
                        kind: "SETTLEMENT",
                        timeoutMs: session.settlementDeadline
                            ? Math.max(0, session.settlementDeadline - Date.now())
                            : null
                    });

                    settlementWatches += 1;

                } catch (error) {

                    this._logger?.warn?.(
                        `Settlement watch registration skipped | gameId=${gameId} | `
                            + `${error?.message ?? error}`
                    );

                }

            }

        }

        return Object.freeze({
            contractWatches,
            paymentWatches,
            settlementWatches,
            refundWatches,
            totalWatches: contractWatches
                + paymentWatches
                + settlementWatches
                + refundWatches
        });

    }

    /**
     * R7.69C — Re-register refund observation watches after restart.
     * Observation only — never resends EMERGENCY_CANCEL / refunds.
     */
    _registerRefundWatchFromSession(session, contractAddress) {

        if (
            !this._blockchainMonitor?.watchGameEscrowRefunds
            || !session
            || !contractAddress
        ) {

            return 0;

        }

        const pendingRefunds = (session.participants ?? [])
            .filter((participant) => {
                const paid = participant.status
                    === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
                    || Number(participant.paidAmount) > 0;
                return paid && participant.refunded !== true;
            })
            .map((participant) => ({
                playerIndex: participant.playerIndex,
                playerId: participant.playerId,
                wallet: participant.wallet,
                amount: participant.paidAmount || participant.requiredGram
            }))
            .filter((entry) => entry.wallet && entry.amount != null);

        // Even with empty pending list, restore a watch when session is cancelled
        // so chain confirmation can complete idempotently.
        try {

            const expectedRefundMask = (session.participants ?? []).reduce(
                (mask, participant, index) => {
                    const seat = participant.playerIndex == null
                        ? index
                        : Number(participant.playerIndex);
                    const paid = participant.status
                        === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
                        || Number(participant.paidAmount) > 0;
                    return paid ? (mask | (1 << seat)) : mask;
                },
                0
            );

            this._blockchainMonitor.watchGameEscrowRefunds({
                escrowAddress: contractAddress,
                cancelTxHash: session.recoveryMetadata?.cancelTxHash ?? null,
                refunds: pendingRefunds.length > 0
                    ? pendingRefunds
                    : (session.participants ?? [])
                        .filter((participant) => {
                            const paid = participant.status
                                === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
                                || Number(participant.paidAmount) > 0;
                            return paid;
                        })
                        .map((participant) => ({
                            playerIndex: participant.playerIndex,
                            playerId: participant.playerId,
                            wallet: participant.wallet,
                            amount: participant.paidAmount || participant.requiredGram
                        })),
                expectedRefundMask,
                contractId: session.contractId,
                roomId: session.roomId,
                gameId: session.gameId,
                correlationId: session.correlationId,
                contractStatus: 9
            });

            return 1;

        } catch (error) {

            this._logger?.warn?.(
                `Refund watch registration skipped | roomId=${session.roomId} | `
                    + `${error?.message ?? error}`
            );

            return 0;

        }

    }

    _validateWalletSessions(warnings, consistencyErrors) {

        const sessions = this._sessionWalletStore?.listAllSessions?.() ?? [];

        for (const session of sessions) {

            if (!session?.playerId) {

                continue;

            }

            if (
                this._playerManager?.hasPlayer
                && !this._playerManager.hasPlayer(session.playerId)
            ) {

                consistencyErrors.push(
                    `wallet_session_orphan_player:${session.walletSessionId}:${session.playerId}`
                );

            }

            if (
                session.roomId
                && this._roomManager?.hasRoom
                && !this._roomManager.hasRoom(session.roomId)
            ) {

                warnings.push(
                    `wallet_session_missing_room:${session.walletSessionId}:${session.roomId}`
                );

            }

        }

    }

    _validatePaymentSessions(warnings, consistencyErrors) {

        if (!this._paymentSessionManager?.listSessionRoomIds) {

            return;

        }

        for (const roomId of this._paymentSessionManager.listSessionRoomIds()) {

            const session = this._paymentSessionManager.getSession(roomId);

            if (!session) {

                continue;

            }

            for (const participant of session.participants ?? []) {

                const walletSession = this._sessionWalletStore?.findByPlayer?.(
                    participant.playerId,
                    { roomId, activeOnly: false }
                ) ?? null;

                if (
                    participant.walletSessionId
                    && !walletSession
                    && participant.wallet
                ) {

                    warnings.push(
                        `payment_wallet_session_missing:${roomId}:${participant.playerId}`
                    );

                }

                if (
                    this._playerManager?.hasPlayer
                    && !this._playerManager.hasPlayer(participant.playerId)
                ) {

                    consistencyErrors.push(
                        `payment_session_orphan_player:${roomId}:${participant.playerId}`
                    );

                }

            }

            if (
                session.contractId
                && this._gameContractManager?.getContractById
                && !this._gameContractManager.getContractById(session.contractId)
            ) {

                consistencyErrors.push(
                    `payment_session_missing_contract:${roomId}:${session.contractId}`
                );

            }

        }

    }

    _validateContracts(warnings, consistencyErrors) {

        if (!this._gameContractManager?.listContracts) {

            return;

        }

        for (const contract of this._gameContractManager.listContracts()) {

            if (!contract?.gameId) {

                warnings.push(`contract_missing_game_id:${contract?.contractId ?? "unknown"}`);

                continue;

            }

            if (
                this._roomManager?.hasRoom
                && contract.roomId
                && !this._roomManager.hasRoom(contract.roomId)
            ) {

                warnings.push(
                    `contract_missing_room:${contract.contractId}:${contract.roomId}`
                );

            }

            const paymentSession = this._paymentSessionManager?.getSessionByGameId?.(
                contract.gameId
            );

            if (
                contract.status === GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE
                && paymentSession
                && paymentSession.status !== PAYMENT_SESSION_STATUS.FULLY_PAID
            ) {

                warnings.push(
                    `contract_payments_complete_without_fully_paid_session:${contract.contractId}`
                );

            }

        }

    }

    _validateSettlements(warnings, consistencyErrors) {

        if (!this._contractSettlementManager?.getSettlementSession) {

            return;

        }

        const snapshots = this._contractSettlementManager.listSettlementSnapshots?.() ?? [];

        for (const snapshot of snapshots) {

            const session = this._contractSettlementManager.getSettlementSession(
                snapshot.gameId
            );

            if (!session || session.isTerminal?.()) {

                continue;

            }

            const paymentSession = this._paymentSessionManager?.getSessionByGameId?.(
                session.gameId
            );

            if (
                paymentSession
                && paymentSession.status !== PAYMENT_SESSION_STATUS.FULLY_PAID
                && !paymentSession.isTerminal?.()
            ) {

                consistencyErrors.push(
                    `settlement_before_payment_complete:${session.gameId}`
                );

            }

            if (
                session.contractId
                && this._gameContractManager?.getContractById
                && !this._gameContractManager.getContractById(session.contractId)
            ) {

                warnings.push(
                    `settlement_missing_contract:${session.gameId}:${session.contractId}`
                );

            }

        }

    }

    _validateBlockchainWatches(warnings, consistencyErrors) {

        if (!this._blockchainMonitor?.listWatchedContracts) {

            return;

        }

        const watchedContracts = this._blockchainMonitor.listWatchedContracts();

        for (const watch of watchedContracts) {

            const contract = this._gameContractManager?.getContractById?.(
                watch.contractId
            );

            if (!contract) {

                consistencyErrors.push(
                    `blockchain_watch_orphan_contract:${watch.contractId}`
                );

                continue;

            }

            if (TERMINAL_CONTRACT_STATUSES.has(contract.status)) {

                warnings.push(
                    `blockchain_watch_terminal_contract:${watch.contractId}:${contract.status}`
                );

            }

        }

    }

    _buildRecoveredManagersList(report) {

        const managers = [];

        if (report.walletSessionsRecovered > 0 || this._walletManager || this._sessionWalletStore) {

            managers.push("wallets");

        }

        if (report.contractsRecovered > 0 || this._gameContractManager) {

            managers.push("contracts");

        }

        if (report.paymentSessionsRecovered > 0 || this._paymentSessionManager) {

            managers.push("payments");

        }

        if (report.settlementsRecovered > 0 || this._contractSettlementManager) {

            managers.push("settlements");

        }

        if (report.blockchainWatchesRecovered > 0 || this._blockchainMonitor) {

            managers.push("blockchain");

        }

        return managers;

    }

    _emitProgress(phase, progress) {

        if (!this._currentRecoveryId) {

            return;

        }

        this._emitRecovery(EVENT_TYPES.FINANCIAL_RECOVERY_PROGRESS, {
            recoveryId: this._currentRecoveryId,
            phase,
            progress,
            timestamp: Date.now()
        });

    }

    _emitRecovery(type, payload) {

        this._eventBus?.emit?.({
            source: EVENT_SOURCES.TON_FINANCIAL_RECOVERY,
            type,
            payload
        });

    }

}

export {
    FinancialRecoveryError,
    RecoveryCheckpointError,
    RecoveryConsistencyError,
    RecoveryManagerUnavailableError,
    RecoveryOrderError,
    RecoveryValidationError
} from "./TonFinancialRecoveryErrors.js";

export {
    FINANCIAL_RECOVERY_PHASE,
    FINANCIAL_RECOVERY_STATE
} from "./TonFinancialRecoveryStates.js";
