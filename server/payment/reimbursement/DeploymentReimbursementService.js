/**
 * R17.8V.2P.M / N / S — Deployment reimbursement service.
 *
 * Stage M: createFromSnapshot foundation (no TON transfer).
 * Stage N: SETTLEMENT_COMPLETED → frozen snapshot → PENDING queue item.
 * Stage S: deferred create on DEPLOYMENT_COST_SNAPSHOT_FROZEN; deploy wallet pin.
 */

import { EVENT_SOURCES } from "../../events/EventSources.js";
import { EVENT_TYPES } from "../../events/EventTypes.js";
import {
    DuplicateRecordError,
    TON_FINANCIAL_RECORD_TYPES
} from "../../persistence/TonFinancialPersistence.js";
import { DEPLOYMENT_COST_SNAPSHOT_STATUS } from "./deploymentCostSnapshotStates.js";
import { isDeploymentReimbursementEnabled } from "./deploymentReimbursementConfig.js";
import { DEPLOYMENT_REIMBURSEMENT_STATUS } from "./deploymentReimbursementStates.js";
import { DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT } from "./deploymentReimbursementServiceResults.js";
import { reimbursementAddressesEqual } from "./ReimbursementWalletConfig.js";

export class DeploymentReimbursementService {

    /**
     * @param {{
     *   repository: import("./DeploymentReimbursementRepository.js").DeploymentReimbursementRepository,
     *   snapshotRepository?: import("./DeploymentCostSnapshotRepository.js").DeploymentCostSnapshotRepository|null,
     *   financialPersistence?: { loadSettlement?: Function, findByGame?: Function }|null,
     *   eventBus?: { subscribe: Function, unsubscribe: Function, emit?: Function }|null,
     *   reimbursementWallet?: string|null,
     *   logger?: object|null,
     *   env?: NodeJS.ProcessEnv
     * }} options
     */
    constructor({
        repository,
        snapshotRepository = null,
        financialPersistence = null,
        eventBus = null,
        reimbursementWallet = null,
        logger = null,
        env = process.env
    } = {}) {

        if (!repository) {

            throw new Error(
                "DeploymentReimbursementService requires DeploymentReimbursementRepository"
            );

        }

        this._repository = repository;

        this._snapshotRepository = snapshotRepository;

        this._financialPersistence = financialPersistence;

        this._eventBus = eventBus;

        const walletFromEnv = String(
            env?.TON_REIMBURSEMENT_EXPECTED_ADDRESS ?? ""
        ).trim();

        this._reimbursementWallet = reimbursementWallet
            ?? (walletFromEnv || null);

        this._logger = logger;

        this._env = env;

        this._initialized = false;

        this._handlers = [];

        /** @type {Set<string>} gameIds settled while snapshot not yet FROZEN */
        this._settledAwaitingFreeze = new Set();

        this._onSettlementCompleted = (envelope) => {

            // Non-blocking: settlement must not wait on queue creation.
            setImmediate(() => {

                try {

                    this.handleSettlementCompleted(envelope?.payload);

                } catch (error) {

                    this._logger?.error?.(
                        `DeploymentReimbursementService settlement handler error | `
                            + `${error?.message ?? error}`
                    );

                }

            });

        };

        this._onSnapshotFrozen = (envelope) => {

            setImmediate(() => {

                try {

                    this.handleSnapshotFrozen(envelope?.payload);

                } catch (error) {

                    this._logger?.error?.(
                        `DeploymentReimbursementService freeze handler error | `
                            + `${error?.message ?? error}`
                    );

                }

            });

        };

    }

    initialize() {

        if (this._initialized) {

            return;

        }

        this._initialized = true;

        if (this._eventBus) {

            this._subscribe(
                EVENT_TYPES.SETTLEMENT_COMPLETED,
                this._onSettlementCompleted
            );

            this._subscribe(
                EVENT_TYPES.DEPLOYMENT_COST_SNAPSHOT_FROZEN,
                this._onSnapshotFrozen
            );

        }

        this._logger?.debug?.(
            "DeploymentReimbursementService initialized (Stage S deferred create)"
        );

    }

    shutdown() {

        for (const { event, handler } of this._handlers) {

            this._eventBus?.unsubscribe?.(event, handler);

        }

        this._handlers = [];

        this._settledAwaitingFreeze.clear();

        this._initialized = false;

    }

    /**
     * R17.8V.2P.N / S — SETTLEMENT_COMPLETED → create if FROZEN, else wait for freeze.
     *
     * @param {object|null|undefined} payload
     * @returns {object}
     */
    handleSettlementCompleted(payload) {

        if (!this._initialized) {

            return {
                ok: false,
                code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.NOT_INITIALIZED,
                reimbursement: null,
                message: "DeploymentReimbursementService is not initialized"
            };

        }

        const gameId = String(payload?.gameId ?? "").trim();
        const roomId = String(payload?.roomId ?? "").trim() || null;

        if (!gameId) {

            this._emitAudit(
                EVENT_TYPES.DEPLOYMENT_REIMBURSEMENT_SKIPPED,
                {
                    gameId: null,
                    deploymentTxHash: null,
                    snapshotId: null,
                    reason: "missing_game_id"
                }
            );

            return {
                ok: false,
                code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.INVALID_PAYLOAD,
                reimbursement: null,
                message: "SETTLEMENT_COMPLETED payload missing gameId"
            };

        }

        if (!isDeploymentReimbursementEnabled(this._env)) {

            this._emitAudit(
                EVENT_TYPES.DEPLOYMENT_REIMBURSEMENT_SKIPPED,
                {
                    gameId,
                    deploymentTxHash: null,
                    snapshotId: null,
                    reason: "feature_disabled"
                }
            );

            return {
                ok: true,
                code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.FEATURE_DISABLED,
                reimbursement: null,
                message: "DEPLOYMENT_REIMBURSEMENT_ENABLED is false"
            };

        }

        if (!this._snapshotRepository) {

            this._emitAudit(
                EVENT_TYPES.DEPLOYMENT_REIMBURSEMENT_NO_SNAPSHOT,
                {
                    gameId,
                    deploymentTxHash: null,
                    snapshotId: null,
                    reason: "snapshot_repository_missing"
                }
            );

            return {
                ok: false,
                code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.NO_SNAPSHOT,
                reimbursement: null,
                message: "Snapshot repository not configured"
            };

        }

        const snapshot = this._snapshotRepository.findByGameId(gameId);

        if (!snapshot) {

            this._emitAudit(
                EVENT_TYPES.DEPLOYMENT_REIMBURSEMENT_NO_SNAPSHOT,
                {
                    gameId,
                    roomId,
                    deploymentTxHash: null,
                    snapshotId: null,
                    reason: "missing_snapshot"
                }
            );

            return {
                ok: false,
                code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.NO_SNAPSHOT,
                reimbursement: null,
                message: "No deployment_cost_snapshot for gameId"
            };

        }

        const snapshotStatus = snapshot.payload?.status;

        if (snapshotStatus !== DEPLOYMENT_COST_SNAPSHOT_STATUS.FROZEN) {

            // Durable wait: remember settlement so freeze notification can create later.
            this._settledAwaitingFreeze.add(gameId);

            const reason = snapshotStatus
                === DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP
                ? "snapshot_awaiting_freeze"
                : snapshotStatus
                    === DEPLOYMENT_COST_SNAPSHOT_STATUS.FAILED_LOOKUP
                    ? "snapshot_failed_lookup"
                    : "snapshot_awaiting_freeze";

            this._emitAudit(
                EVENT_TYPES.DEPLOYMENT_REIMBURSEMENT_SKIPPED,
                {
                    gameId,
                    roomId,
                    deploymentTxHash: snapshot.payload?.deploymentTxHash ?? null,
                    snapshotId: snapshot.recordId ?? snapshot.payload?.id ?? null,
                    reason
                }
            );

            return {
                ok: true,
                code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.SNAPSHOT_AWAITING_FREEZE,
                reimbursement: null,
                message: `Waiting for snapshot freeze | status=${snapshotStatus}`
            };

        }

        return this._createFromFrozenSnapshot(snapshot, { gameId, roomId });

    }

    /**
     * R17.8V.2P.S — DEPLOYMENT_COST_SNAPSHOT_FROZEN → create if settlement already done.
     *
     * @param {object|null|undefined} payload
     * @returns {object}
     */
    handleSnapshotFrozen(payload) {

        if (!this._initialized) {

            return {
                ok: false,
                code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.NOT_INITIALIZED,
                reimbursement: null,
                message: "DeploymentReimbursementService is not initialized"
            };

        }

        const gameId = String(payload?.gameId ?? "").trim();
        const roomId = String(payload?.roomId ?? "").trim() || null;

        if (!gameId) {

            return {
                ok: false,
                code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.INVALID_PAYLOAD,
                reimbursement: null,
                message: "DEPLOYMENT_COST_SNAPSHOT_FROZEN payload missing gameId"
            };

        }

        if (!isDeploymentReimbursementEnabled(this._env)) {

            return {
                ok: true,
                code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.FEATURE_DISABLED,
                reimbursement: null,
                message: "DEPLOYMENT_REIMBURSEMENT_ENABLED is false"
            };

        }

        if (!this._hasSettlementCompleted(gameId)) {

            return {
                ok: true,
                code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.SKIPPED,
                reimbursement: null,
                message: "Settlement not completed yet; wait for SETTLEMENT_COMPLETED"
            };

        }

        if (!this._snapshotRepository) {

            return {
                ok: false,
                code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.NO_SNAPSHOT,
                reimbursement: null,
                message: "Snapshot repository not configured"
            };

        }

        const snapshot = this._snapshotRepository.findByGameId(gameId);

        if (!snapshot
            || snapshot.payload?.status !== DEPLOYMENT_COST_SNAPSHOT_STATUS.FROZEN) {

            return {
                ok: false,
                code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.SNAPSHOT_NOT_FROZEN,
                reimbursement: null,
                message: "Frozen snapshot not found for gameId"
            };

        }

        const result = this._createFromFrozenSnapshot(snapshot, { gameId, roomId });

        if (
            result.ok
            && (
                result.code === DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.OK
                || result.code === DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.DUPLICATE
            )
        ) {

            this._settledAwaitingFreeze.delete(gameId);

        }

        return result;

    }

    /**
     * @param {object} snapshot
     * @param {{ gameId: string, roomId?: string|null }} context
     * @returns {object}
     */
    _createFromFrozenSnapshot(snapshot, context) {

        const { gameId, roomId = null } = context;

        const result = this.createFromSnapshot(snapshot);

        if (
            result.ok
            && result.code === DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.OK
        ) {

            this._settledAwaitingFreeze.delete(gameId);

            this._emitAudit(
                EVENT_TYPES.DEPLOYMENT_REIMBURSEMENT_CREATED,
                {
                    gameId,
                    roomId,
                    deploymentTxHash:
                        result.reimbursement?.payload?.deploymentTxHash ?? null,
                    snapshotId: snapshot.recordId ?? snapshot.payload?.id ?? null,
                    reason: null,
                    amountTon: result.reimbursement?.payload?.amountTon ?? null
                }
            );

            return result;

        }

        if (
            result.ok
            && result.code === DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.DUPLICATE
        ) {

            this._settledAwaitingFreeze.delete(gameId);

            this._emitAudit(
                EVENT_TYPES.DEPLOYMENT_REIMBURSEMENT_SKIPPED,
                {
                    gameId,
                    roomId,
                    deploymentTxHash:
                        result.reimbursement?.payload?.deploymentTxHash ?? null,
                    snapshotId: snapshot.recordId ?? snapshot.payload?.id ?? null,
                    reason: "duplicate_reimbursement"
                }
            );

            return result;

        }

        if (
            result.code
                === DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.DEPLOY_WALLET_MISMATCH
        ) {

            return result;

        }

        this._emitAudit(
            EVENT_TYPES.DEPLOYMENT_REIMBURSEMENT_SKIPPED,
            {
                gameId,
                roomId,
                deploymentTxHash: snapshot.payload?.deploymentTxHash ?? null,
                snapshotId: snapshot.recordId ?? snapshot.payload?.id ?? null,
                reason: String(result.code ?? result.message ?? "create_failed")
                    .toLowerCase()
            }
        );

        return result;

    }

    /**
     * @param {object} snapshotRecord financial record for deployment_cost_snapshot
     * @returns {object}
     */
    createFromSnapshot(snapshotRecord) {

        if (!this._initialized) {

            return {
                ok: false,
                code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.NOT_INITIALIZED,
                reimbursement: null,
                message: "DeploymentReimbursementService is not initialized"
            };

        }

        if (!isDeploymentReimbursementEnabled(this._env)) {

            return {
                ok: false,
                code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.FEATURE_DISABLED,
                reimbursement: null,
                message: "DEPLOYMENT_REIMBURSEMENT_ENABLED is false"
            };

        }

        const payload = snapshotRecord?.payload ?? snapshotRecord;

        if (!payload || typeof payload !== "object") {

            return {
                ok: false,
                code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.INVALID_SNAPSHOT,
                reimbursement: null,
                message: "Snapshot payload missing"
            };

        }

        if (payload.status !== DEPLOYMENT_COST_SNAPSHOT_STATUS.FROZEN) {

            return {
                ok: false,
                code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.SNAPSHOT_NOT_FROZEN,
                reimbursement: null,
                message: "Snapshot must be FROZEN"
            };

        }

        const amountTon = String(payload.deploymentCostTon ?? "").trim();
        const deploymentTxHash = String(payload.deploymentTxHash ?? "").trim();
        const deployWallet = String(payload.deployWallet ?? "").trim();

        if (!amountTon || !deploymentTxHash || !deployWallet) {

            return {
                ok: false,
                code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.INVALID_SNAPSHOT,
                reimbursement: null,
                message: "Frozen snapshot missing cost fields"
            };

        }

        const expectedDeployWallet = String(
            this._env?.TON_DEPLOYER_EXPECTED_ADDRESS ?? ""
        ).trim();

        if (
            expectedDeployWallet
            && !reimbursementAddressesEqual(deployWallet, expectedDeployWallet)
        ) {

            this._emitAudit(
                EVENT_TYPES.DEPLOYMENT_REIMBURSEMENT_DEPLOY_WALLET_MISMATCH,
                {
                    gameId: payload.gameId ?? null,
                    roomId: payload.roomId ?? null,
                    deploymentTxHash,
                    snapshotId: snapshotRecord.recordId ?? payload.id ?? null,
                    reason: "deploy_wallet_mismatch",
                    deployWallet,
                    expectedDeployWallet
                }
            );

            return {
                ok: false,
                code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.DEPLOY_WALLET_MISMATCH,
                reimbursement: null,
                message: "snapshot.deployWallet does not match configured deployer"
            };

        }

        const reimbursementWallet = String(this._reimbursementWallet ?? "").trim();

        if (!reimbursementWallet) {

            return {
                ok: false,
                code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.MISSING_REIMBURSEMENT_WALLET,
                reimbursement: null,
                message: "TON_REIMBURSEMENT_EXPECTED_ADDRESS is required"
            };

        }

        const existing = this._repository.findByDeploymentTxHash(deploymentTxHash)
            ?? this._repository.findByGameId(payload.gameId);

        if (existing) {

            return {
                ok: true,
                code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.DUPLICATE,
                reimbursement: existing,
                message: "Reimbursement already exists"
            };

        }

        try {

            const created = this._repository.create({
                gameId: payload.gameId,
                roomId: payload.roomId,
                contractId: payload.contractId,
                deploymentTxHash,
                deployWallet,
                reimbursementWallet,
                deploymentCostSnapshotId: String(
                    snapshotRecord.recordId ?? payload.id ?? ""
                ).trim(),
                amountTon,
                status: DEPLOYMENT_REIMBURSEMENT_STATUS.PENDING
            });

            this._logger?.info?.(
                `DeploymentReimbursement PENDING | gameId=${created.payload?.gameId} | `
                    + `amount=${created.payload?.amountTon}`
            );

            return {
                ok: true,
                code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.OK,
                reimbursement: created,
                message: "PENDING reimbursement created"
            };

        } catch (error) {

            if (error instanceof DuplicateRecordError) {

                const raced = this._repository.findByDeploymentTxHash(deploymentTxHash)
                    ?? this._repository.findByGameId(payload.gameId);

                if (raced) {

                    return {
                        ok: true,
                        code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.DUPLICATE,
                        reimbursement: raced,
                        message: "Reimbursement already exists (race)"
                    };

                }

            }

            return {
                ok: false,
                code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.CREATE_FAILED,
                reimbursement: null,
                message: error?.message ?? "Create failed"
            };

        }

    }

    /**
     * @param {string} gameId
     * @returns {object|null}
     */
    findByGameId(gameId) {

        return this._repository.findByGameId(gameId);

    }

    /**
     * @param {string} hash
     * @returns {object|null}
     */
    findByDeploymentTxHash(hash) {

        return this._repository.findByDeploymentTxHash(hash);

    }

    /**
     * Settlement completed for game (in-memory wait set or persisted settlement).
     *
     * @param {string} gameId
     * @returns {boolean}
     */
    _hasSettlementCompleted(gameId) {

        const id = String(gameId ?? "").trim();

        if (!id) {

            return false;

        }

        if (this._settledAwaitingFreeze.has(id)) {

            return true;

        }

        try {

            const settlement = this._financialPersistence?.loadSettlement?.(id)
                ?? null;

            const status = String(
                settlement?.payload?.status
                ?? settlement?.metadata?.status
                ?? ""
            ).trim();

            if (status === "SETTLEMENT_COMPLETED") {

                return true;

            }

        } catch {

            // ignore persistence miss

        }

        try {

            const records = this._financialPersistence?.findByGame?.(id) ?? [];

            return records.some((record) => {

                if (record.recordType !== TON_FINANCIAL_RECORD_TYPES.SETTLEMENT) {

                    return false;

                }

                const status = String(
                    record.payload?.status
                    ?? record.metadata?.status
                    ?? ""
                ).trim();

                return status === "SETTLEMENT_COMPLETED";

            });

        } catch {

            return false;

        }

    }

    /**
     * @param {string} event
     * @param {Function} handler
     */
    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    /**
     * @param {string} type
     * @param {object} payload
     */
    _emitAudit(type, payload) {

        const safe = Object.freeze({
            gameId: payload?.gameId ?? null,
            deploymentTxHash: payload?.deploymentTxHash ?? null,
            snapshotId: payload?.snapshotId ?? null,
            reason: payload?.reason ?? null,
            roomId: payload?.roomId ?? null,
            amountTon: payload?.amountTon ?? null,
            deployWallet: payload?.deployWallet ?? null,
            expectedDeployWallet: payload?.expectedDeployWallet ?? null
        });

        this._logger?.info?.(
            `${type} | gameId=${safe.gameId ?? "none"} | `
                + `tx=${safe.deploymentTxHash ?? "none"} | `
                + `snapshotId=${safe.snapshotId ?? "none"} | `
                + `reason=${safe.reason ?? "none"}`
        );

        try {

            this._eventBus?.emit?.({
                source: EVENT_SOURCES.DEPLOYMENT_REIMBURSEMENT_SERVICE,
                type,
                payload: safe
            });

        } catch (error) {

            this._logger?.warn?.(
                `DeploymentReimbursementService audit emit failed | `
                    + `${error?.message ?? error}`
            );

        }

    }

}
