import { createHash, randomUUID } from "node:crypto";

import {
    markDeployStage,
    nextDeployAttempt,
    printDeployBlock,
    safeSerialize
} from "../diagnostics/DeployPipelineForensics.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    GAME_CONTRACT_STATUS,
    GameContract
} from "../models/GameContract.js";
import { PAYMENT_PARTICIPANT_STATUS } from "../models/PaymentSession.js";
import { buildGameContractSnapshot } from "../payment/buildGameContractSnapshot.js";
import { GameContractDeployAdapter } from "../payment/GameContractDeployAdapter.js";
import { hashGameContractSnapshot } from "../payment/ton/buildGameEscrowStateInit.js";
import { resolveGameEscrowMode } from "../config/gameEscrowMode.js";
import {
    ContractAlreadyExistsError,
    ContractNotFoundError,
    ContractOperationInProgressError,
    ContractRecoveryError,
    InvalidContractStateTransitionError,
    PersistenceFailureError
} from "./GameContractManagerErrors.js";
import { shouldPreserveFinancialEvidence } from "./financialEvidenceGuards.js";
import {
    buildPartialPaymentRefundTargets,
    countConfirmedParticipants,
    sessionNeedsEscrowUnwind
} from "./partialPaymentEscrowUnwind.js";

const R711B_EMIT_EVENTS = new Set([
    EVENT_TYPES.GAME_CONTRACT_DEPLOYED,
    EVENT_TYPES.GAME_CONTRACT_DEPLOY_FAILED,
    EVENT_TYPES.GAME_CONTRACT_READY_FOR_PAYMENTS,
    EVENT_TYPES.CONTRACT_DEPLOYING,
    EVENT_TYPES.CONTRACT_DEPLOYED,
    EVENT_TYPES.CONTRACT_FAILED,
    EVENT_TYPES.DEPLOYMENT_COST_CAPTURE_REQUESTED
]);

const REQUESTED_OR_BEYOND = new Set([
    PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED,
    PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION,
    PAYMENT_PARTICIPANT_STATUS.PAYMENT_SUBMITTED,
    PAYMENT_PARTICIPANT_STATUS.BLOCKCHAIN_PENDING,
    PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
]);

const ARCHIVEABLE_STATUSES = new Set([
    GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED,
    GAME_CONTRACT_STATUS.SETTLEMENT_FAILED,
    GAME_CONTRACT_STATUS.DEPLOY_FAILED
]);

const FAILABLE_FROM = new Set([
    GAME_CONTRACT_STATUS.DEPLOYING,
    GAME_CONTRACT_STATUS.SETTLEMENT_PREPARING,
    GAME_CONTRACT_STATUS.SETTLEMENT_SUBMITTED,
    GAME_CONTRACT_STATUS.SETTLEMENT_PENDING,
    GAME_CONTRACT_STATUS.SETTLEMENT_CONFIRMED,
    GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE,
    GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS,
    GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN
]);

/**
 * P6.4/P6.5/T2.4 — Authoritative Game Smart Contract lifecycle.
 *
 * Owns contract domain lifecycle, persistence coordination, and adapter calls.
 * Never imports @ton/* SDK. Never talks to TON directly.
 */
export class GameContractManager {

    constructor({
        logger,
        eventBus,
        playerManager,
        roomManager,
        gameManager = null,
        sessionWalletStore = null,
        configurationEngine = null,
        paymentRules = null,
        deployAdapter = null,
        financialPersistence = null,
        paymentSessionManager = null,
        contractSettlementManager = null,
        tonNetwork = null,
        creatingDelayMs = 0,
        deployDelayMs = 0,
        deployTimeoutMs = 2 * 60 * 1000,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._playerManager = playerManager;

        this._roomManager = roomManager;

        this._gameManager = gameManager;

        this._sessionWalletStore = sessionWalletStore;

        this._configurationEngine = configurationEngine;

        this._paymentRules = paymentRules;

        this._deployAdapter = deployAdapter
            ?? new GameContractDeployAdapter({
                logger,
                deployDelayMs
            });

        this._financialPersistence = financialPersistence;

        this._paymentSessionManager = paymentSessionManager;

        this._contractSettlementManager = contractSettlementManager;

        this._tonNetwork = tonNetwork ?? null;

        this._deployTimeoutMs = Number.isFinite(deployTimeoutMs)
            && deployTimeoutMs > 0
            ? deployTimeoutMs
            : 2 * 60 * 1000;

        this._creatingDelayMs = Number.isFinite(creatingDelayMs)
            && creatingDelayMs >= 0
            ? creatingDelayMs
            : 0;

        this._devMode = devMode;

        this._contractsByRoom = new Map();

        this._roomByGameId = new Map();

        this._contractsById = new Map();

        this._creatingTimers = new Map();

        this._operationLocks = new Map();

        this._handlers = [];

        this._blockchainMonitor = null;

        this._escrowUnwindByRoom = new Map();

        this._initialized = false;

    }

    /**
     * R17.9G.1 — Update payment rules used by future Game Contract snapshots.
     * Existing contracts keep their frozen snapshot fee / stake amounts.
     */
    setPaymentRules(paymentRules) {

        if (!paymentRules || typeof paymentRules !== "object") {

            throw new Error("GameContractManager.setPaymentRules requires paymentRules");

        }

        this._paymentRules = paymentRules;

        return this._paymentRules;

    }

    /**
     * R8.8 — Late-bind payment/settlement refs for financial retention checks.
     */
    setFinancialEvidenceDeps({
        paymentSessionManager = null,
        contractSettlementManager = null
    } = {}) {

        if (paymentSessionManager) {

            this._paymentSessionManager = paymentSessionManager;

        }

        if (contractSettlementManager) {

            this._contractSettlementManager = contractSettlementManager;

        }

    }

    /**
     * R17.8O.1 — Late-bind BlockchainMonitor for partial-payment refund watches.
     */
    setEscrowUnwindDeps({ blockchainMonitor = null } = {}) {

        if (blockchainMonitor) {

            this._blockchainMonitor = blockchainMonitor;

        }

    }

    _shouldPreserveFinancialEvidence(roomId) {

        return shouldPreserveFinancialEvidence({
            roomId,
            gameManager: this._gameManager,
            contractSettlementManager: this._contractSettlementManager,
            gameContractManager: this,
            paymentSessionManager: this._paymentSessionManager
        });

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.PAYMENT_SESSION_UPDATED,
            (envelope) => {

                this._handlePaymentSessionUpdated(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.PAYMENT_SESSION_COMPLETED,
            (envelope) => {

                this._handlePaymentSessionCompleted(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.PAYMENT_SESSION_FAILED,
            (envelope) => {

                const roomId = envelope.payload?.roomId;

                if (this._shouldPreserveFinancialEvidence(roomId)) {

                    return;

                }

                const unwind = this._escrowUnwindByRoom.get(roomId);

                if (unwind?.state === "failed") {

                    return;

                }

                this.destroyContract(roomId);

                this._escrowUnwindByRoom.delete(roomId);

            }
        );

        this._subscribe(
            EVENT_TYPES.ROOM_DESTROYED,
            (envelope) => {

                const roomId = envelope.payload?.roomId;

                if (this._shouldPreserveFinancialEvidence(roomId)) {

                    return;

                }

                this.destroyContract(roomId);

            }
        );

        this._subscribe(
            EVENT_TYPES.SESSION_FINISHED,
            (envelope) => {

                const roomId = envelope.payload?.roomId;

                // R8.8 — result presentation end ≠ financial teardown.
                if (this._shouldPreserveFinancialEvidence(roomId)) {

                    return;

                }

                this.destroyContract(roomId);

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

    // -------------------------------------------------------------------------
    // Lookups
    // -------------------------------------------------------------------------

    getContract(roomId) {

        return this._contractsByRoom.get(roomId) ?? null;

    }

    getContractById(contractId) {

        return this._contractsById.get(contractId) ?? null;

    }

    /**
     * R6.0C — Read-only room ids with game contracts (projection layer).
     */
    listContractRoomIds() {

        return [...this._contractsByRoom.keys()];

    }

    listContracts() {

        return [...this._contractsByRoom.values()];

    }

    getContractByGameId(gameId) {

        if (!gameId) {

            return null;

        }

        const roomId = this._roomByGameId.get(gameId);

        return roomId ? this.getContract(roomId) : null;

    }

    getDashboardSnapshot(roomId) {

        const contract = this.getContract(roomId);

        return contract?.toDashboardSnapshot?.() ?? null;

    }

    /**
     * P6.8B — public client update emit for settlement state transitions.
     */
    notifyClientUpdate(contract) {

        if (!contract) {

            return;

        }

        this._touchUpdated(contract);

        this._persistContract(contract);

        this._emitClientUpdate(contract);

        this._emitDomainLifecycle(
            EVENT_TYPES.CONTRACT_STATE_CHANGED,
            contract
        );

    }

    // -------------------------------------------------------------------------
    // T2.4 Public API
    // -------------------------------------------------------------------------

    /**
     * Create contract domain record + immutable snapshot.
     * Throws on duplicate (T2.4). Payment flow uses createContractRequest (idempotent).
     */
    createContract(roomId, options = {}) {

        this._assertInitialized();

        if (!roomId) {

            throw new ContractNotFoundError(roomId);

        }

        if (this._contractsByRoom.has(roomId)) {

            throw new ContractAlreadyExistsError(roomId, options.gameId ?? null);

        }

        if (options.gameId && this._roomByGameId.has(options.gameId)) {

            throw new ContractAlreadyExistsError(roomId, options.gameId);

        }

        const contract = this.createContractRequest(roomId, options);

        if (!contract) {

            throw new ContractNotFoundError(roomId);

        }

        return contract;

    }

    createContractRequest(roomId, { gameId = null, correlationId = null } = {}) {

        this._assertInitialized();

        if (!roomId) {

            return null;

        }

        if (this._contractsByRoom.has(roomId)) {

            return this._contractsByRoom.get(roomId);

        }

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            this._logger.error(
                `GameContract create failed | roomId=${roomId} | reason=room_missing`
            );

            return null;

        }

        const resolvedGameId = gameId ?? null;

        if (!resolvedGameId) {

            this._logger.error(
                `GameContract create failed | roomId=${roomId} | reason=game_missing`
            );

            return null;

        }

        if (this._roomByGameId.has(resolvedGameId)) {

            return this.getContractByGameId(resolvedGameId);

        }

        const configuration = this._configurationEngine
            ?.getConfiguration?.(resolvedGameId)
            ?? null;

        const tonConfig = this._deployAdapter?._tonConfig ?? {};

        let escrowMode = null;

        try {

            escrowMode = resolveGameEscrowMode(tonConfig.gameEscrowMode);

        } catch {

            escrowMode = tonConfig.gameEscrowMode ?? null;

        }

        const network = this._resolveTonNetwork();

        const adapterIdentity = this._deployAdapter?.constructor?.name
            ?? "GameContractDeployAdapter";

        const snapshot = buildGameContractSnapshot({
            gameId: resolvedGameId,
            roomId,
            playerIds: [...room.players],
            playerManager: this._playerManager,
            sessionWalletStore: this._sessionWalletStore,
            configuration,
            paymentRules: this._paymentRules ?? undefined,
            // R7.70C2.4 — freeze platform oracle into snapshot for StateInit.
            oracleWallet: tonConfig.oracleAddress ?? null,
            // R13.1H — freeze escrow lifecycle configuration at create.
            escrowMode,
            network,
            adapterIdentity,
            contractAddress: null
        });

        if (!snapshot) {

            this._logger.error(
                `GameContract create failed | roomId=${roomId} | reason=snapshot_invalid`
            );

            return null;

        }

        const now = Date.now();

        const contract = new GameContract({
            contractId: `contract_${randomUUID()}`,
            gameId: resolvedGameId,
            roomId,
            status: GAME_CONTRACT_STATUS.NOT_CREATED,
            snapshot,
            createdAt: null,
            updatedAt: now,
            tonNetwork: network,
            correlationId: correlationId ?? randomUUID(),
            snapshotHash: hashGameContractSnapshot(snapshot).toString("hex"),
            version: 1
        });

        this._indexContract(contract);

        if (!contract.transitionTo(GAME_CONTRACT_STATUS.CREATING)) {

            throw new InvalidContractStateTransitionError(
                contract.contractId,
                GAME_CONTRACT_STATUS.NOT_CREATED,
                GAME_CONTRACT_STATUS.CREATING
            );

        }

        this._persistContract(contract, { create: true });

        this._persistSnapshot(contract);

        this._emitClientUpdate(contract);

        this._emitDomainLifecycle(EVENT_TYPES.CONTRACT_CREATED, contract);

        this._log(
            `CREATING | roomId=${roomId} | gameId=${resolvedGameId} | `
                + `contractId=${contract.contractId}`
        );

        const stage = markDeployStage(roomId, "GAME_CONTRACT_CREATING");

        printDeployBlock("GameContractManager.createContractRequest", {
            RoomId: roomId,
            GameId: resolvedGameId,
            ContractId: contract.contractId,
            Status: contract.status,
            DurationSincePreviousStageMs: stage.elapsedMs,
            Timestamp: new Date(stage.now).toISOString()
        });

        this._scheduleCreated(contract);

        return contract;

    }

    /**
     * Explicit deploy entry (also used after create pipeline reaches READY_FOR_BLOCKCHAIN).
     */
    async deployContract(roomId) {

        this._assertInitialized();

        const contract = this._requireContractByRoom(roomId);

        return this._withLock(contract.contractId, "deploy", async () => {

            if (contract.status === GAME_CONTRACT_STATUS.DEPLOYED
                || contract.status === GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS
                || contract.status === GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE) {

                return contract;

            }

            if (contract.status === GAME_CONTRACT_STATUS.DEPLOYING) {

                throw new ContractOperationInProgressError(
                    contract.contractId,
                    "deploy"
                );

            }

            if (contract.status === GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN) {

                await this._beginDeploy(roomId);

                return this.getContract(roomId);

            }

            throw new InvalidContractStateTransitionError(
                contract.contractId,
                contract.status,
                GAME_CONTRACT_STATUS.DEPLOYING
            );

        });

    }

    /**
     * Load a contract from persistence into memory (recovery / ops).
     */
    loadContract(contractId) {

        this._assertInitialized();

        if (!contractId) {

            throw new ContractNotFoundError(contractId);

        }

        const existing = this.getContractById(contractId);

        if (existing) {

            return existing;

        }

        if (!this._financialPersistence) {

            throw new ContractNotFoundError(contractId);

        }

        try {

            const record = this._financialPersistence.loadGameContract(contractId);

            const contract = this._hydrateFromPersistenceRecord(record);

            this._indexContract(contract);

            return contract;

        } catch (error) {

            if (error?.code === "RECORD_NOT_FOUND") {

                throw new ContractNotFoundError(contractId);

            }

            throw new PersistenceFailureError(
                `Unable to load contract | contractId=${contractId}`,
                { cause: error?.message ?? null }
            );

        }

    }

    updateContractState(roomId, nextStatus) {

        this._assertInitialized();

        const contract = this._requireContractByRoom(roomId);

        return this._transitionContract(contract, nextStatus);

    }

    markPaymentsCompleted(roomId) {

        return this.markPaymentsComplete(roomId);

    }

    markPaymentsComplete(roomId) {

        const contract = this._contractsByRoom.get(roomId);

        if (!contract) {

            return null;

        }

        if (contract.status === GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE) {

            return contract;

        }

        if (contract.status !== GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS) {

            return contract;

        }

        this._transitionContract(
            contract,
            GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE,
            { throwOnInvalid: false }
        );

        this._emit(EVENT_TYPES.GAME_CONTRACT_PAYMENTS_COMPLETE, {
            roomId,
            gameId: contract.gameId,
            contractId: contract.contractId,
            paymentsCompletedAt: contract.paymentsCompletedAt,
            correlationId: contract.correlationId,
            timestamp: Date.now()
        });

        this._emitDomainLifecycle(EVENT_TYPES.CONTRACT_READY, contract);

        this._log(
            `PAYMENTS_COMPLETE | roomId=${roomId} | `
                + `contractId=${contract.contractId}`
        );

        return contract;

    }

    /**
     * Mark gameplay started after payments. Does not mutate settlement gate status.
     */
    markGameStarted(roomId) {

        const contract = this._requireContractByRoom(roomId);

        if (contract.status !== GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE) {

            throw new InvalidContractStateTransitionError(
                contract.contractId,
                contract.status,
                "GAME_STARTED"
            );

        }

        if (contract.gameStartedAt == null) {

            contract.gameStartedAt = Date.now();

            this._touchUpdated(contract);

            this._persistContract(contract);

            this._emitClientUpdate(contract);

            this._emitDomainLifecycle(EVENT_TYPES.CONTRACT_STATE_CHANGED, contract, {
                gameStarted: true
            });

        }

        return contract;

    }

    markWinnerPending(roomId) {

        const contract = this._requireContractByRoom(roomId);

        if (contract.status === GAME_CONTRACT_STATUS.SETTLEMENT_PREPARING) {

            return contract;

        }

        return this._transitionContract(
            contract,
            GAME_CONTRACT_STATUS.SETTLEMENT_PREPARING
        );

    }

    markSettlementPending(roomId) {

        const contract = this._requireContractByRoom(roomId);

        if (contract.status === GAME_CONTRACT_STATUS.SETTLEMENT_PENDING) {

            return contract;

        }

        if (contract.status === GAME_CONTRACT_STATUS.SETTLEMENT_PREPARING) {

            this._transitionContract(
                contract,
                GAME_CONTRACT_STATUS.SETTLEMENT_SUBMITTED
            );

        }

        if (contract.status === GAME_CONTRACT_STATUS.SETTLEMENT_SUBMITTED) {

            return this._transitionContract(
                contract,
                GAME_CONTRACT_STATUS.SETTLEMENT_PENDING
            );

        }

        throw new InvalidContractStateTransitionError(
            contract.contractId,
            contract.status,
            GAME_CONTRACT_STATUS.SETTLEMENT_PENDING
        );

    }

    completeContract(roomId) {

        const contract = this._requireContractByRoom(roomId);

        if (contract.status === GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED) {

            return contract;

        }

        if (contract.status === GAME_CONTRACT_STATUS.SETTLEMENT_CONFIRMED) {

            return this._transitionContract(
                contract,
                GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED
            );

        }

        throw new InvalidContractStateTransitionError(
            contract.contractId,
            contract.status,
            GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED
        );

    }

    async archiveContract(roomId) {

        this._assertInitialized();

        const contract = this._requireContractByRoom(roomId);

        return this._withLock(contract.contractId, "archive", async () => {

            if (contract.status === GAME_CONTRACT_STATUS.ARCHIVED) {

                return contract;

            }

            if (!ARCHIVEABLE_STATUSES.has(contract.status)) {

                throw new InvalidContractStateTransitionError(
                    contract.contractId,
                    contract.status,
                    GAME_CONTRACT_STATUS.ARCHIVED
                );

            }

            this._transitionContract(contract, GAME_CONTRACT_STATUS.ARCHIVED);

            if (this._financialPersistence) {

                try {

                    this._financialPersistence.archive(contract.contractId, {
                        archiveReason: "game_complete",
                        correlationId: contract.correlationId,
                        roomId: contract.roomId,
                        gameId: contract.gameId,
                        tonNetwork: contract.tonNetwork
                    });

                } catch (error) {

                    throw new PersistenceFailureError(
                        `Unable to archive contract | contractId=${contract.contractId}`,
                        { cause: error?.message ?? null }
                    );

                }

            }

            this._emitDomainLifecycle(EVENT_TYPES.CONTRACT_ARCHIVED, contract);

            this._log(
                `ARCHIVED | roomId=${roomId} | contractId=${contract.contractId}`
            );

            return contract;

        });

    }

    async failContract(roomId, reason = "contract_failed") {

        const contract = this._requireContractByRoom(roomId);

        if (
            contract.status === GAME_CONTRACT_STATUS.DEPLOY_FAILED
            || contract.status === GAME_CONTRACT_STATUS.SETTLEMENT_FAILED
            || contract.status === GAME_CONTRACT_STATUS.ARCHIVED
        ) {

            return contract;

        }

        return this._withLock(contract.contractId, "fail", async () => {

            contract.failureReason = reason;

            if (contract.status === GAME_CONTRACT_STATUS.DEPLOYING) {

                contract.applyDeploymentFailure(reason);

                this._transitionContract(
                    contract,
                    GAME_CONTRACT_STATUS.DEPLOY_FAILED,
                    { throwOnInvalid: false }
                );

            } else if (contract.canTransitionTo(GAME_CONTRACT_STATUS.SETTLEMENT_FAILED)) {

                this._transitionContract(
                    contract,
                    GAME_CONTRACT_STATUS.SETTLEMENT_FAILED
                );

            } else if (FAILABLE_FROM.has(contract.status)) {

                contract.failureReason = reason;

                this._touchUpdated(contract);

                this._persistContract(contract);

                this._emitClientUpdate(contract);

            } else {

                throw new InvalidContractStateTransitionError(
                    contract.contractId,
                    contract.status,
                    "FAILED"
                );

            }

            this._emitDomainLifecycle(EVENT_TYPES.CONTRACT_FAILED, contract, {
                reason
            });

            return contract;

        });

    }

    /**
     * Restore active contracts from TonFinancialPersistence after restart.
     */
    restoreContracts() {

        this._assertInitialized();

        if (!this._financialPersistence) {

            return Object.freeze({
                restored: 0,
                incompleteDeployments: Object.freeze([]),
                unfinishedTransitions: Object.freeze([])
            });

        }

        try {

            const active = this._financialPersistence.listActive("game_contract");

            let restored = 0;

            const incompleteDeployments = [];

            const unfinishedTransitions = [];

            for (const record of active) {

                try {

                    const contract = this._hydrateFromPersistenceRecord(record);

                    if (this._contractsByRoom.has(contract.roomId)) {

                        continue;

                    }

                    this._indexContract(contract);

                    restored += 1;

                    if (
                        contract.status === GAME_CONTRACT_STATUS.DEPLOYING
                        || contract.status === GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN
                    ) {

                        incompleteDeployments.push(contract.contractId);

                    }

                    if (
                        contract.status === GAME_CONTRACT_STATUS.SETTLEMENT_SUBMITTED
                        || contract.status === GAME_CONTRACT_STATUS.SETTLEMENT_PENDING
                        || contract.status === GAME_CONTRACT_STATUS.SETTLEMENT_PREPARING
                        || contract.status === GAME_CONTRACT_STATUS.CREATING
                    ) {

                        unfinishedTransitions.push(contract.contractId);

                    }

                } catch (error) {

                    this._logger.error(
                        `GameContract restore skipped | `
                            + `id=${record?.recordId} | ${error?.message ?? error}`
                    );

                }

            }

            this._log(
                `RESTORE | restored=${restored} | `
                    + `incompleteDeploy=${incompleteDeployments.length}`
            );

            return Object.freeze({
                restored,
                incompleteDeployments: Object.freeze(incompleteDeployments),
                unfinishedTransitions: Object.freeze(unfinishedTransitions)
            });

        } catch (error) {

            throw new ContractRecoveryError(
                "Unable to restore contracts from persistence",
                { cause: error?.message ?? null }
            );

        }

    }

    destroyContract(roomId) {

        if (!roomId) {

            return;

        }

        this._clearCreatingTimer(roomId);

        const contract = this._contractsByRoom.get(roomId);

        if (contract?.gameId) {

            this._roomByGameId.delete(contract.gameId);

        }

        if (contract?.contractId) {

            this._contractsById.delete(contract.contractId);

            this._operationLocks.delete(contract.contractId);

        }

        this._contractsByRoom.delete(roomId);

    }

    // -------------------------------------------------------------------------
    // Event handlers
    // -------------------------------------------------------------------------

    _handlePaymentSessionUpdated(payload) {

        const roomId = payload?.roomId;

        const gameId = payload?.gameId;

        if (!roomId || !gameId) {

            return;

        }

        if (this._contractsByRoom.has(roomId)) {

            return;

        }

        const participants = Array.isArray(payload.participants)
            ? payload.participants
            : [];

        if (participants.length === 0) {

            return;

        }

        const allRequested = participants.every(
            (participant) => REQUESTED_OR_BEYOND.has(participant.status)
        );

        if (!allRequested) {

            return;

        }

        const stage = markDeployStage(roomId, "PAYMENT_SESSION_UPDATED_TRIGGER");

        printDeployBlock("GameContractManager._handlePaymentSessionUpdated", {
            RoomId: roomId,
            GameId: gameId,
            ParticipantCount: participants.length,
            AllRequested: allRequested,
            Action: "createContractRequest",
            DurationSincePreviousStageMs: stage.elapsedMs,
            Timestamp: new Date(stage.now).toISOString()
        });

        this.createContractRequest(roomId, { gameId });

    }

    _handlePaymentSessionCompleted(payload) {

        const roomId = payload?.roomId;

        if (!roomId) {

            return;

        }

        this.markPaymentsComplete(roomId);

    }

    _scheduleCreated(contract) {

        const finish = () => {

            this._creatingTimers.delete(contract.roomId);

            const current = this._contractsByRoom.get(contract.roomId);

            if (!current || current.contractId !== contract.contractId) {

                return;

            }

            if (current.status !== GAME_CONTRACT_STATUS.CREATING) {

                return;

            }

            this._transitionContract(
                current,
                GAME_CONTRACT_STATUS.CREATED,
                { throwOnInvalid: false }
            );

            this._log(
                `CREATED | roomId=${current.roomId} | `
                    + `contractId=${current.contractId}`
            );

            this._transitionContract(
                current,
                GAME_CONTRACT_STATUS.AWAITING_PAYMENTS,
                { throwOnInvalid: false }
            );

            this._transitionContract(
                current,
                GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN,
                { throwOnInvalid: false }
            );

            this._log(
                `READY_FOR_BLOCKCHAIN | roomId=${current.roomId} | `
                    + `contractId=${current.contractId}`
            );

            const deployStage = markDeployStage(
                current.roomId,
                "READY_FOR_BLOCKCHAIN"
            );

            printDeployBlock("GameContractManager._scheduleCreated finish", {
                RoomId: current.roomId,
                GameId: current.gameId,
                ContractId: current.contractId,
                Status: current.status,
                CreatingDelayMs: this._creatingDelayMs,
                Action: "void _beginDeploy(current.roomId)",
                DurationSincePreviousStageMs: deployStage.elapsedMs,
                Timestamp: new Date(deployStage.now).toISOString()
            });

            void this._beginDeploy(current.roomId);

        };

        if (this._creatingDelayMs <= 0) {

            finish();

            return;

        }

        const timerId = setTimeout(finish, this._creatingDelayMs);

        this._creatingTimers.set(contract.roomId, timerId);

    }

    async _beginDeploy(roomId) {

        const contract = this._contractsByRoom.get(roomId);

        if (!contract) {

            printDeployBlock("BEGIN CONTRACT DEPLOY — ABORT", {
                RoomId: roomId,
                Reason: "contract_missing_from_registry",
                Timestamp: new Date().toISOString()
            });

            return;

        }

        if (contract.status !== GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN) {

            printDeployBlock("BEGIN CONTRACT DEPLOY — ABORT", {
                RoomId: roomId,
                ContractId: contract.contractId,
                CurrentState: contract.status,
                Reason: "status_not_READY_FOR_BLOCKCHAIN",
                Timestamp: new Date().toISOString()
            });

            return;

        }

        if (!contract.transitionTo(GAME_CONTRACT_STATUS.DEPLOYING)) {

            printDeployBlock("BEGIN CONTRACT DEPLOY — ABORT", {
                RoomId: roomId,
                ContractId: contract.contractId,
                CurrentState: contract.status,
                Reason: "transition_to_DEPLOYING_failed",
                Timestamp: new Date().toISOString()
            });

            return;

        }

        const attempt = nextDeployAttempt(roomId);
        const stage = markDeployStage(roomId, "BEGIN_CONTRACT_DEPLOY");
        const adapterName = this._deployAdapter?.constructor?.name
            ?? typeof this._deployAdapter;

        printDeployBlock("BEGIN CONTRACT DEPLOY", {
            RoomId: roomId,
            GameId: contract.gameId,
            ContractId: contract.contractId,
            CurrentState: contract.status,
            PaymentSession: "see PaymentSessionManager logs",
            DeployAdapter: adapterName,
            DeployAttempt: attempt,
            AsyncBranch: "_beginDeploy async (void from _scheduleCreated)",
            DurationSincePreviousStageMs: stage.elapsedMs,
            Timestamp: new Date(stage.now).toISOString()
        });

        this._touchUpdated(contract);

        this._persistContract(contract);

        this._emitClientUpdate(contract);

        this._emitDomainLifecycle(EVENT_TYPES.CONTRACT_DEPLOYING, contract);

        this._log(
            `DEPLOYING | roomId=${roomId} | contractId=${contract.contractId}`
        );

        this._logger.decisionTrace({
            stage: "BEGIN_DEPLOY",
            decision: "START",
            reason: "Contract READY_FOR_BLOCKCHAIN; starting deploy adapter.",
            caller: "GameContractManager._beginDeploy",
            nextAction: "Deploy Contract",
            roomId,
            gameId: contract.gameId ?? null
        });

        const adapterStartedAt = Date.now();

        let result;
        let caughtException = null;

        try {

            result = await Promise.race([
                this._deployAdapter.deploy({
                    contractId: contract.contractId,
                    snapshot: contract.snapshot
                }),
                new Promise((_, reject) => {

                    setTimeout(() => {

                        reject(new Error("deploy_timeout"));

                    }, this._deployTimeoutMs);

                })
            ]);

        } catch (error) {

            caughtException = error;

            printDeployBlock("DEPLOY EXCEPTION", {
                "Error.name": error?.name ?? "unknown",
                "Error.message": error?.message ?? String(error),
                "Error.stack": error?.stack ?? null,
                "Serialized error": safeSerialize(error),
                RoomId: roomId,
                GameId: contract.gameId,
                ContractId: contract.contractId,
                DeployAttempt: attempt,
                ElapsedMs: Date.now() - adapterStartedAt,
                Timestamp: new Date().toISOString()
            });

            if (error?.message === "deploy_timeout") {

                this._logger.decisionTrace({
                    stage: "LIFECYCLE_TIMEOUT",
                    decision: "DEPLOY_TIMEOUT",
                    reason: `Deploy exceeded ${this._deployTimeoutMs}ms`,
                    caller: "GameContractManager._beginDeploy",
                    nextAction: "DEPLOY_RESULT FAILED",
                    roomId,
                    gameId: contract.gameId ?? null
                });

            }

            result = {
                ok: false,
                reason: error?.message ?? "deploy_exception"
            };

        }

        const resultStage = markDeployStage(roomId, "DEPLOY_RESULT");
        const elapsedMs = Date.now() - adapterStartedAt;
        const resultIsNull = result === null;
        const resultIsUndefined = result === undefined;
        const resultKeys = result !== null && typeof result === "object"
            ? Object.keys(result)
            : [];

        printDeployBlock("DEPLOY RESULT", {
            RoomId: roomId,
            GameId: contract.gameId,
            ContractId: contract.contractId,
            DeployAttempt: attempt,
            AsyncBranch: "_beginDeploy after await adapter.deploy()",
            DurationSincePreviousStageMs: resultStage.elapsedMs,
            "typeof result": typeof result,
            "result === null": resultIsNull,
            "result === undefined": resultIsUndefined,
            result: safeSerialize(result),
            "JSON.stringify(result)": safeSerialize(result),
            "result.ok": resultIsNull || resultIsUndefined
                ? "(missing — result is null/undefined)"
                : result?.ok,
            "result.contractAddress": resultIsNull || resultIsUndefined
                ? "(missing — result is null/undefined)"
                : result?.contractAddress,
            "result.error": resultIsNull || resultIsUndefined
                ? "(missing — result is null/undefined)"
                : result?.error,
            "result.reason": resultIsNull || resultIsUndefined
                ? "(missing — result is null/undefined)"
                : result?.reason,
            "result.code": resultIsNull || resultIsUndefined
                ? "(missing — result is null/undefined)"
                : result?.code,
            "result.message": resultIsNull || resultIsUndefined
                ? "(missing — result is null/undefined)"
                : result?.message,
            availableKeys: resultKeys,
            caughtException: Boolean(caughtException),
            ElapsedMs: elapsedMs,
            Timestamp: new Date(resultStage.now).toISOString()
        });

        this._logger.decisionTrace({
            stage: "DEPLOY_RESULT",
            decision: result?.ok && result?.contractAddress ? "SUCCESS" : "FAILED",
            reason: result?.ok && result?.contractAddress
                ? `Adapter Result ok; address=${result.contractAddress}`
                : `Adapter Result failed; reason=${result?.reason ?? caughtException?.message ?? "deploy_failed"}`,
            caller: "GameContractManager._beginDeploy",
            nextAction: result?.ok && result?.contractAddress
                ? "Ready For Payments"
                : "GAME_CONTRACT_DEPLOY_FAILED",
            roomId,
            gameId: contract.gameId ?? null
        });

        const current = this._contractsByRoom.get(roomId);

        if (!current || current.contractId !== contract.contractId) {

            printDeployBlock("DEPLOY POST-ADAPTER — EARLY RETURN", {
                RoomId: roomId,
                Reason: !current
                    ? "contract_missing_after_await (registry cleared — room likely destroyed during deploy)"
                    : "contractId_mismatch_after_await",
                ExpectedContractId: contract.contractId,
                CurrentContractId: current?.contractId ?? null,
                DeployAttempt: attempt,
                WillEmitGAME_CONTRACT_DEPLOY_FAILED: false,
                Note: "Silent return — no DEPLOY_FAILED / DEPLOYED emit",
                Timestamp: new Date().toISOString()
            });

            return;

        }

        if (current.status !== GAME_CONTRACT_STATUS.DEPLOYING) {

            printDeployBlock("DEPLOY POST-ADAPTER — EARLY RETURN", {
                RoomId: roomId,
                Reason: "status_no_longer_DEPLOYING",
                CurrentState: current.status,
                DeployAttempt: attempt,
                WillEmitGAME_CONTRACT_DEPLOY_FAILED: false,
                Note: "Silent return — no DEPLOY_FAILED / DEPLOYED emit",
                Timestamp: new Date().toISOString()
            });

            return;

        }

        if (!result?.ok || !result.contractAddress) {

            const failReason = result?.reason ?? "deploy_failed";

            printDeployBlock("MANAGER DECISION — DEPLOY FAILED", {
                RoomId: roomId,
                GameId: current.gameId,
                ContractId: current.contractId,
                Decision: "emit GAME_CONTRACT_DEPLOY_FAILED",
                FailReason: failReason,
                "result.ok": result?.ok,
                "result.contractAddress": result?.contractAddress ?? null,
                DeployAttempt: attempt,
                Timestamp: new Date().toISOString()
            });

            current.applyDeploymentFailure(failReason);

            current.transitionTo(GAME_CONTRACT_STATUS.DEPLOY_FAILED);

            this._persistContract(current);

            this._emitClientUpdate(current);

            this._emit(EVENT_TYPES.GAME_CONTRACT_DEPLOY_FAILED, {
                ...current.toClientSnapshot(),
                reason: current.deployError
            });

            this._logger.decisionTrace({
                stage: "GAME_CONTRACT_DEPLOY_FAILED",
                decision: "FAIL",
                reason: current.deployError ?? failReason,
                caller: "GameContractManager._beginDeploy",
                nextAction: "PaymentSession failSession",
                roomId,
                gameId: current.gameId ?? null
            });

            this._emitDomainLifecycle(EVENT_TYPES.CONTRACT_FAILED, current, {
                reason: current.deployError
            });

            this._log(
                `DEPLOY_FAILED | roomId=${roomId} | reason=${current.deployError}`
            );

            return;

        }

        printDeployBlock("MANAGER DECISION — DEPLOY SUCCESS", {
            RoomId: roomId,
            GameId: current.gameId,
            ContractId: current.contractId,
            Decision: "emit GAME_CONTRACT_DEPLOYED",
            ContractAddress: result.contractAddress,
            DeployAttempt: attempt,
            Timestamp: new Date().toISOString()
        });

        current.applyDeploymentSuccess({
            contractAddress: result.contractAddress,
            deploymentTxId: result.deploymentTxId ?? null,
            deployedAt: result.deployedAt ?? Date.now()
        });

        if (result.snapshotHash) {

            current.snapshotHash = result.snapshotHash;

        }

        // R7.69A — GameEscrow: INIT_GAME + OPEN_PAYMENTS before player STAKE window.
        if (
            typeof this._deployAdapter?.initGame === "function"
            && typeof this._deployAdapter?.openPayments === "function"
            && this._deployAdapter?._tonConfig?.gameEscrowMode === "game"
        ) {

            try {

                const snapshotHash = current.snapshotHash
                    ?? result.snapshotHash;
                const contractIdHash = createHash("sha256")
                    .update(String(current.contractId ?? ""))
                    .digest("hex");
                const players = current.snapshot?.players ?? [];

                // R7.69D — oracle must be platform config, never a player wallet.
                const oracle = current.snapshot?.oracleWallet
                    ?? this._deployAdapter?._tonConfig?.oracleAddress
                    ?? null;

                if (!oracle) {

                    throw new Error("oracle_address_missing");

                }

                const init = await this._deployAdapter.initGame({
                    contractAddress: current.contractAddress,
                    oracle,
                    owner: current.snapshot?.ownerWallet ?? null,
                    contractIdHash,
                    snapshotHash
                });

                if (!init?.ok) {

                    throw new Error(init?.reason ?? "init_game_failed");

                }

                const open = await this._deployAdapter.openPayments({
                    contractAddress: current.contractAddress,
                    players
                });

                if (!open?.ok) {

                    throw new Error(open?.reason ?? "open_payments_failed");

                }

                this._log(
                    `GAME_ESCROW_PAYMENTS_OPEN | roomId=${roomId} | `
                        + `address=${current.contractAddress}`
                );

            } catch (error) {

                current.applyDeploymentFailure(
                    error?.message ?? "game_escrow_payments_open_failed"
                );
                current.transitionTo(GAME_CONTRACT_STATUS.DEPLOY_FAILED);
                this._persistContract(current);
                this._emitClientUpdate(current);
                this._emit(EVENT_TYPES.GAME_CONTRACT_DEPLOY_FAILED, {
                    ...current.toClientSnapshot(),
                    reason: current.deployError
                });
                return;

            }

        }

        current.transitionTo(GAME_CONTRACT_STATUS.DEPLOYED);

        this._persistContract(current);

        this._emitDeploymentCostCaptureRequested(current);

        this._emitClientUpdate(current);

        this._emit(EVENT_TYPES.GAME_CONTRACT_DEPLOYED, current.toClientSnapshot());

        this._emitDomainLifecycle(EVENT_TYPES.CONTRACT_DEPLOYED, current);

        this._log(
            `DEPLOYED | roomId=${roomId} | address=${current.contractAddress}`
        );

        if (!current.transitionTo(GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS)) {

            return;

        }

        this._persistContract(current);

        this._emitClientUpdate(current);

        this._emit(EVENT_TYPES.GAME_CONTRACT_READY_FOR_PAYMENTS, {
            roomId: current.roomId,
            gameId: current.gameId,
            contractId: current.contractId,
            contractAddress: current.contractAddress,
            paymentDeadline: Date.now() + (5 * 60 * 1000),
            correlationId: current.correlationId,
            participants: (current.snapshot?.players ?? []).map((player) => (
                Object.freeze({
                    playerId: player.playerId,
                    requiredGram: player.requiredGram,
                    wallet: player.wallet
                })
            ))
        });

        this._log(
            `AWAITING_PLAYER_PAYMENTS | roomId=${roomId} | `
                + `contractId=${current.contractId}`
        );

    }

    // -------------------------------------------------------------------------
    // Persistence / hydration
    // -------------------------------------------------------------------------

    _persistContract(contract, { create = false } = {}) {

        if (!this._financialPersistence || !contract) {

            return;

        }

        const payload = {
            contractId: contract.contractId,
            gameId: contract.gameId,
            roomId: contract.roomId,
            status: contract.status,
            contractAddress: contract.contractAddress,
            deploymentStatus: contract.deploymentStatus,
            deployedAt: contract.deployedAt,
            deploymentTxId: contract.deploymentTxId,
            deployError: contract.deployError,
            paymentsCompletedAt: contract.paymentsCompletedAt,
            tonNetwork: contract.tonNetwork,
            snapshotHash: contract.snapshotHash,
            version: contract.version,
            gameStartedAt: contract.gameStartedAt,
            archivedAt: contract.archivedAt,
            failureReason: contract.failureReason,
            snapshot: contract.snapshot
        };

        const metadata = {
            status: contract.status,
            roomId: contract.roomId,
            gameId: contract.gameId,
            contractId: contract.contractId,
            tonNetwork: contract.tonNetwork,
            correlationId: contract.correlationId,
            createdAt: contract.createdAt,
            updatedAt: contract.updatedAt ?? Date.now(),
            version: contract.version
        };

        try {

            if (create) {

                this._financialPersistence.createGameContract(payload, metadata);

                return;

            }

            try {

                this._financialPersistence.updateGameContract(
                    contract.contractId,
                    payload,
                    metadata
                );

            } catch (error) {

                if (error?.code === "RECORD_NOT_FOUND") {

                    this._financialPersistence.createGameContract(payload, metadata);

                    return;

                }

                throw error;

            }

        } catch (error) {

            this._logger.error(
                `GameContract persistence failed | contractId=${contract.contractId} | `
                    + `${error?.message ?? error}`
            );

            throw new PersistenceFailureError(
                `Unable to persist contract | contractId=${contract.contractId}`,
                { cause: error?.message ?? null }
            );

        }

    }

    _persistSnapshot(contract) {

        if (!this._financialPersistence || !contract?.snapshotHash) {

            return;

        }

        try {

            this._financialPersistence.createSnapshotRecord(
                {
                    snapshotHash: contract.snapshotHash,
                    gameId: contract.gameId,
                    roomId: contract.roomId,
                    contractId: contract.contractId,
                    snapshot: contract.snapshot
                },
                {
                    snapshotId: contract.snapshotHash,
                    roomId: contract.roomId,
                    gameId: contract.gameId,
                    contractId: contract.contractId,
                    tonNetwork: contract.tonNetwork,
                    correlationId: contract.correlationId,
                    status: "FROZEN"
                }
            );

        } catch (error) {

            if (error?.code === "DUPLICATE_RECORD") {

                return;

            }

            this._logger.error(
                `GameContract snapshot persist failed | `
                    + `contractId=${contract.contractId} | ${error?.message ?? error}`
            );

        }

    }

    _hydrateFromPersistenceRecord(record) {

        const payload = record?.payload ?? {};

        return new GameContract({
            contractId: payload.contractId ?? record.recordId,
            gameId: payload.gameId ?? record.gameId,
            roomId: payload.roomId ?? record.roomId,
            status: payload.status ?? record.status,
            snapshot: payload.snapshot ?? null,
            createdAt: record.createdAt ?? payload.createdAt ?? null,
            updatedAt: record.updatedAt ?? payload.updatedAt ?? null,
            contractAddress: payload.contractAddress ?? null,
            deploymentStatus: payload.deploymentStatus ?? null,
            deployedAt: payload.deployedAt ?? null,
            deploymentTxId: payload.deploymentTxId ?? null,
            deployError: payload.deployError ?? null,
            paymentsCompletedAt: payload.paymentsCompletedAt ?? null,
            tonNetwork: payload.tonNetwork ?? record.tonNetwork ?? null,
            correlationId: record.correlationId ?? payload.correlationId ?? null,
            snapshotHash: payload.snapshotHash ?? null,
            version: payload.version ?? record.version ?? 1,
            gameStartedAt: payload.gameStartedAt ?? null,
            archivedAt: payload.archivedAt ?? null,
            failureReason: payload.failureReason ?? null
        });

    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    _indexContract(contract) {

        this._contractsByRoom.set(contract.roomId, contract);

        this._roomByGameId.set(contract.gameId, contract.roomId);

        this._contractsById.set(contract.contractId, contract);

    }

    _requireContractByRoom(roomId) {

        const contract = this.getContract(roomId);

        if (!contract) {

            throw new ContractNotFoundError(roomId);

        }

        return contract;

    }

    _transitionContract(contract, nextStatus, { throwOnInvalid = true } = {}) {

        const previous = contract.status;

        if (previous === nextStatus) {

            return contract;

        }

        if (!contract.transitionTo(nextStatus)) {

            if (throwOnInvalid) {

                throw new InvalidContractStateTransitionError(
                    contract.contractId,
                    previous,
                    nextStatus
                );

            }

            return contract;

        }

        this._persistContract(contract);

        this._emitClientUpdate(contract);

        this._emitDomainLifecycle(EVENT_TYPES.CONTRACT_STATE_CHANGED, contract, {
            previousStatus: previous
        });

        return contract;

    }

    _touchUpdated(contract) {

        contract.updatedAt = Date.now();

    }

    _resolveTonNetwork() {

        if (this._tonNetwork) {

            return this._tonNetwork;

        }

        return this._deployAdapter?._tonConfig?.network
            ?? this._deployAdapter?._tonService?.getActiveNetwork?.()
            ?? null;

    }

    async _withLock(contractId, operation, fn) {

        const existing = this._operationLocks.get(contractId);

        if (existing) {

            throw new ContractOperationInProgressError(contractId, existing);

        }

        this._operationLocks.set(contractId, operation);

        try {

            return await fn();

        } finally {

            this._operationLocks.delete(contractId);

        }

    }

    _clearCreatingTimer(roomId) {

        const timerId = this._creatingTimers.get(roomId);

        if (timerId) {

            clearTimeout(timerId);

            this._creatingTimers.delete(roomId);

        }

    }

    _emitClientUpdate(contract) {

        this._emit(
            EVENT_TYPES.GAME_CONTRACT_UPDATED,
            contract.toClientSnapshot()
        );

    }

    /**
     * R17.8V.2P.J — Announce durable DEPLOY for cost snapshot capture.
     * Emit only after _persistContract. No cost math / RPC / wallet secrets.
     *
     * @param {GameContract} contract
     */
    _emitDeploymentCostCaptureRequested(contract) {

        const deploymentTxHash = String(contract?.deploymentTxId ?? "").trim();
        const contractAddress = String(contract?.contractAddress ?? "").trim();

        if (!deploymentTxHash || !contractAddress) {

            this._log(
                `DEPLOYMENT_COST_CAPTURE skipped | missing hash or address | `
                    + `roomId=${contract?.roomId ?? "null"}`
            );

            return;

        }

        const deployWallet = String(
            this._deployAdapter?._tonConfig?.deployerExpectedAddress
            ?? contract?.snapshot?.oracleWallet
            ?? this._deployAdapter?._tonConfig?.oracleAddress
            ?? ""
        ).trim();

        if (!deployWallet) {

            this._log(
                `DEPLOYMENT_COST_CAPTURE skipped | missing deployWallet | `
                    + `roomId=${contract?.roomId ?? "null"}`
            );

            return;

        }

        this._emit(EVENT_TYPES.DEPLOYMENT_COST_CAPTURE_REQUESTED, Object.freeze({
            gameId: contract.gameId,
            roomId: contract.roomId,
            contractId: contract.contractId,
            contractAddress,
            deploymentTxHash,
            deployWallet,
            deployedAt: contract.deployedAt ?? Date.now(),
            timestamp: Date.now()
        }));

    }

    _emitDomainLifecycle(type, contract, extra = {}) {

        this._emit(type, {
            contractId: contract.contractId,
            gameId: contract.gameId,
            roomId: contract.roomId,
            state: contract.status,
            timestamp: Date.now(),
            correlationId: contract.correlationId,
            ...extra
        });

    }

    _reset() {

        for (const roomId of [...this._creatingTimers.keys()]) {

            this._clearCreatingTimer(roomId);

        }

        this._contractsByRoom.clear();

        this._roomByGameId.clear();

        this._contractsById.clear();

        this._operationLocks.clear();

        this._escrowUnwindByRoom.clear();

    }

    /**
     * R17.8O.1 — Cancel deployed GameEscrow when payment cannot complete after
     * partial confirmation. Starts refund observation; room teardown waits for
     * PaymentSessionManager to emit PAYMENT_SESSION_FAILED after refunds.
     */
    async requestPartialPaymentEscrowUnwind({
        roomId,
        reason = "payment_failed",
        session = null
    } = {}) {

        this._assertInitialized();

        if (!roomId) {

            return Object.freeze({ ok: false, reason: "missing_room_id" });

        }

        const paymentSession = session
            ?? this._paymentSessionManager?.getSession?.(roomId)
            ?? null;

        const unwindNeeded = sessionNeedsEscrowUnwind(paymentSession);

        this._logger.info(
            `requestPartialPaymentEscrowUnwind | roomId=${roomId}`
                + ` | gameId=${paymentSession?.gameId ?? "null"}`
                + ` | paymentSessionId=${paymentSession?.paymentSessionId ?? "null"}`
                + ` | paymentSession.status=${paymentSession?.status ?? "null"}`
                + ` | sessionNeedsEscrowUnwind=${unwindNeeded}`
                + ` | timestamp=${new Date().toISOString()}`
                + ` | reason=${reason}`
        );

        if (!unwindNeeded) {

            return Object.freeze({ ok: false, reason: "no_unwind_needed", skipped: true });

        }

        const contract = this.getContract(roomId);

        const contractAddress = contract?.contractAddress ?? null;

        const gameId = contract?.gameId ?? paymentSession?.gameId ?? null;

        const confirmedPlayersCount = countConfirmedParticipants(paymentSession);

        const existing = this._escrowUnwindByRoom.get(roomId);

        if (existing?.state === "pending") {

            return Object.freeze({ ok: true, reason: "already_pending" });

        }

        if (!contractAddress) {

            this._escrowUnwindByRoom.set(roomId, {
                state: "failed",
                reason: "missing_contract_address"
            });

            this._emit(EVENT_TYPES.ESCROW_CANCEL_FAILED, {
                gameId,
                roomId,
                contractAddress: null,
                reason: "missing_contract_address",
                confirmedPlayersCount,
                timestamp: Date.now()
            });

            return Object.freeze({ ok: false, reason: "missing_contract_address" });

        }

        if (typeof this._deployAdapter?.cancel !== "function") {

            this._escrowUnwindByRoom.set(roomId, {
                state: "failed",
                reason: "cancel_not_supported"
            });

            this._emit(EVENT_TYPES.ESCROW_CANCEL_FAILED, {
                gameId,
                roomId,
                contractAddress,
                reason: "cancel_not_supported",
                confirmedPlayersCount,
                timestamp: Date.now()
            });

            return Object.freeze({ ok: false, reason: "cancel_not_supported" });

        }

        this._escrowUnwindByRoom.set(roomId, { state: "pending", reason });

        this._emit(EVENT_TYPES.ESCROW_CANCEL_REQUESTED, {
            gameId,
            roomId,
            contractAddress,
            reason,
            confirmedPlayersCount,
            timestamp: Date.now()
        });

        this._logger.info(
            `EMERGENCY_CANCEL | roomId=${roomId}`
                + ` | gameId=${gameId ?? "null"}`
                + ` | paymentSessionId=${paymentSession?.paymentSessionId ?? "null"}`
                + ` | paymentSession.status=${paymentSession?.status ?? "null"}`
                + ` | contractAddress=${contractAddress}`
                + ` | timestamp=${new Date().toISOString()}`
                + ` | reason=${reason}`
        );

        let result;

        try {

            result = await this._deployAdapter.cancel({
                contractAddress,
                reasonCode: 0
            });

        } catch (error) {

            result = {
                ok: false,
                reason: error?.message ?? "cancel_failed"
            };

        }

        if (!result?.ok) {

            this._escrowUnwindByRoom.set(roomId, {
                state: "failed",
                reason: result?.reason ?? "cancel_failed"
            });

            this._emit(EVENT_TYPES.ESCROW_CANCEL_FAILED, {
                gameId,
                roomId,
                contractAddress,
                reason: result?.reason ?? "cancel_failed",
                confirmedPlayersCount,
                timestamp: Date.now()
            });

            this._log(
                `ESCROW_CANCEL_FAILED | roomId=${roomId} | `
                    + `address=${contractAddress} | reason=${result?.reason ?? "cancel_failed"}`
            );

            return Object.freeze({
                ok: false,
                reason: result?.reason ?? "cancel_failed"
            });

        }

        this._paymentSessionManager?.noteEscrowCancelTx?.(
            roomId,
            result.txId ?? null
        );

        this._emit(EVENT_TYPES.ESCROW_CANCEL_CONFIRMED, {
            gameId,
            roomId,
            contractAddress,
            transactionHash: result.txId ?? null,
            timestamp: Date.now()
        });

        const { refunds, expectedRefundMask } = buildPartialPaymentRefundTargets(
            paymentSession
        );

        try {

            this._blockchainMonitor?.watchGameEscrowRefunds?.({
                escrowAddress: contractAddress,
                cancelTxHash: result.txId ?? null,
                refunds,
                expectedRefundMask,
                contractId: contract?.contractId ?? null,
                roomId,
                gameId,
                correlationId: contract?.correlationId
                    ?? paymentSession?.correlationId
                    ?? null,
                contractStatus: 9
            });

        } catch (error) {

            this._logger?.warn?.(
                `Escrow refund watch registration failed | roomId=${roomId} | `
                    + `${error?.message ?? error}`
            );

        }

        this._emit(EVENT_TYPES.ESCROW_REFUND_PENDING, {
            gameId,
            roomId,
            contractAddress,
            confirmedPlayersCount,
            refundCount: refunds.length,
            timestamp: Date.now()
        });

        this._log(
            `ESCROW_CANCEL_CONFIRMED | roomId=${roomId} | `
                + `address=${contractAddress} | tx=${result.txId ?? "null"}`
        );

        return Object.freeze({
            ok: true,
            cancelTxHash: result.txId ?? null
        });

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _emit(type, payload) {

        if (R711B_EMIT_EVENTS.has(type)) {

            printDeployBlock("EVENT EMITTED", {
                EventName: type,
                Payload: payload,
                Source: EVENT_SOURCES.GAME_CONTRACT_MANAGER,
                RoomId: payload?.roomId ?? null,
                GameId: payload?.gameId ?? null,
                ContractId: payload?.contractId ?? null,
                Timestamp: new Date().toISOString()
            });

        }

        this._eventBus.emit({
            source: EVENT_SOURCES.GAME_CONTRACT_MANAGER,
            type,
            payload
        });

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new Error("GameContractManager is not initialized");

        }

    }

    _log(message) {

        if (this._devMode) {

            this._logger.info(`[GameContractManager] ${message}`);

        }

    }

}

export {
    ContractAlreadyExistsError,
    ContractNotFoundError,
    ContractOperationInProgressError,
    ContractRecoveryError,
    ContractStateMismatchError,
    DeploymentFailedError,
    InvalidContractStateTransitionError,
    PersistenceFailureError
} from "./GameContractManagerErrors.js";
