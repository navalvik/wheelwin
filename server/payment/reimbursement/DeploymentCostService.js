/**
 * R17.8V.2P.I–K — Deployment Cost Snapshot service.
 *
 * Stage B: PENDING_LOOKUP create API.
 * Stage C: EventBus subscription.
 * Stage D: TonCenter lookup + FROZEN (chain economics only).
 */

import { EVENT_SOURCES } from "../../events/EventSources.js";
import { EVENT_TYPES } from "../../events/EventTypes.js";
import { DuplicateRecordError } from "../../persistence/TonFinancialPersistence.js";
import { isDeploymentCostSnapshotEnabled } from "./deploymentCostSnapshotConfig.js";
import {
    DEPLOYMENT_COST_LOOKUP_MAX_ATTEMPTS,
    deploymentCostNextLookupAt,
    isDeploymentCostLookupDue,
    isDeploymentCostSnapshotStuck
} from "./deploymentCostLookupBackoff.js";
import { DEPLOYMENT_COST_SNAPSHOT_STATUS } from "./deploymentCostSnapshotStates.js";
import { validateDeploymentCostSnapshotCreateInput } from "./deploymentCostSnapshotSchema.js";
import { DEPLOYMENT_COST_SERVICE_RESULT } from "./deploymentCostServiceResults.js";
import {
    extractDeployCostFromTransaction,
    transactionHashOf
} from "./extractDeployCostFromTransaction.js";
import { nanotonToTonString } from "./nanoton.js";

/**
 * @typedef {object} DeploymentCostCaptureInput
 * @property {string} gameId
 * @property {string} roomId
 * @property {string} contractId
 * @property {string} contractAddress
 * @property {string} deploymentTxHash
 * @property {string} deployWallet
 * @property {number} [deployedAt]
 * @property {number} [timestamp]
 */

/**
 * @typedef {object} DeploymentCostServiceResult
 * @property {boolean} ok
 * @property {string} code
 * @property {object|null} [snapshot]
 * @property {string[]} [errors]
 * @property {string} [message]
 * @property {string} [reason]
 */

export class DeploymentCostService {

    /**
     * @param {{
     *   repository: import("./DeploymentCostSnapshotRepository.js").DeploymentCostSnapshotRepository,
     *   eventBus?: { subscribe: Function, unsubscribe: Function }|null,
     *   transport?: { getTransactions: Function }|null,
     *   logger?: { debug?: Function, info?: Function, warn?: Function, error?: Function }|null,
     *   env?: NodeJS.ProcessEnv,
     *   transactionLookupLimit?: number
     * }} options
     */
    constructor({
        repository,
        eventBus = null,
        transport = null,
        logger = null,
        env = process.env,
        transactionLookupLimit = 40
    } = {}) {

        if (!repository) {

            throw new Error("DeploymentCostService requires DeploymentCostSnapshotRepository");

        }

        this._repository = repository;

        this._eventBus = eventBus;

        this._transport = transport;

        this._logger = logger;

        this._env = env;

        this._transactionLookupLimit = Number.isFinite(Number(transactionLookupLimit))
            ? Math.max(1, Number(transactionLookupLimit))
            : 40;

        this._initialized = false;

        this._handlers = [];

        this._recoveryRunning = false;

        this._onCaptureRequested = (envelope) => {

            try {

                const result = this.handleDeploymentCostCaptureRequested(
                    envelope?.payload
                );

                if (
                    result?.ok
                    && result.snapshot
                    && result.snapshot.payload?.status
                        === DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP
                    && this._transport
                ) {

                    void this.lookupAndFreezeSnapshot(result.snapshot)
                        .catch((error) => {

                            this._logger?.error?.(
                                `DeploymentCostService async lookup failed | `
                                    + `${error?.message ?? error}`
                            );

                        });

                }

            } catch (error) {

                this._logger?.error?.(
                    `DeploymentCostService capture handler error | ${error?.message ?? error}`
                );

            }

        };

    }

    initialize() {

        if (this._initialized) {

            return;

        }

        this._initialized = true;

        if (this._eventBus) {

            this._subscribe(
                EVENT_TYPES.DEPLOYMENT_COST_CAPTURE_REQUESTED,
                this._onCaptureRequested
            );

        }

        this._logger?.debug?.(
            "DeploymentCostService initialized (Stage E recovery)"
        );

        if (isDeploymentCostSnapshotEnabled(this._env)) {

            void this.runBackgroundRecovery()
                .catch((error) => {

                    this._logger?.error?.(
                        `DEPLOYMENT_COST_RECOVERY_STARTED failed | `
                            + `${error?.message ?? error}`
                    );

                });

        }

    }

    shutdown() {

        for (const { event, handler } of this._handlers) {

            this._eventBus?.unsubscribe?.(event, handler);

        }

        this._handlers = [];

        this._initialized = false;

        this._logger?.debug?.("DeploymentCostService shutdown");

    }

    /**
     * @param {DeploymentCostCaptureInput|null|undefined} payload
     * @returns {DeploymentCostServiceResult}
     */
    handleDeploymentCostCaptureRequested(payload) {

        return this.captureDeploymentCost(payload ?? {});

    }

    /**
     * @param {DeploymentCostCaptureInput} input
     * @returns {DeploymentCostServiceResult}
     */
    captureDeploymentCost(input) {

        if (!this._initialized) {

            return {
                ok: false,
                code: DEPLOYMENT_COST_SERVICE_RESULT.NOT_INITIALIZED,
                snapshot: null,
                message: "DeploymentCostService is not initialized"
            };

        }

        if (!isDeploymentCostSnapshotEnabled(this._env)) {

            this._logger?.debug?.(
                "DeploymentCostService capture skipped | DEPLOYMENT_COST_SNAPSHOT_ENABLED=false"
            );

            return {
                ok: false,
                code: DEPLOYMENT_COST_SERVICE_RESULT.FEATURE_DISABLED,
                snapshot: null,
                message: "DEPLOYMENT_COST_SNAPSHOT_ENABLED is false"
            };

        }

        return this.createPendingSnapshot(input);

    }

    /**
     * @param {DeploymentCostCaptureInput} input
     * @returns {DeploymentCostServiceResult}
     */
    createPendingSnapshot(input) {

        if (!this._initialized) {

            return {
                ok: false,
                code: DEPLOYMENT_COST_SERVICE_RESULT.NOT_INITIALIZED,
                snapshot: null,
                message: "DeploymentCostService is not initialized"
            };

        }

        const capture = this._normalizeCaptureInput(input);

        const validated = validateDeploymentCostSnapshotCreateInput({
            ...capture,
            status: DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP,
            createdAt: capture.createdAt
        });

        if (!validated.ok) {

            return {
                ok: false,
                code: DEPLOYMENT_COST_SERVICE_RESULT.INVALID_CAPTURE_PAYLOAD,
                snapshot: null,
                errors: validated.errors,
                message: "Invalid deployment cost capture payload"
            };

        }

        const existingByHash = this._repository.findByDeploymentTxHash(
            validated.payload.deploymentTxHash
        );

        if (existingByHash) {

            return {
                ok: true,
                code: DEPLOYMENT_COST_SERVICE_RESULT.SNAPSHOT_DUPLICATE,
                snapshot: existingByHash,
                message: "Snapshot already exists for deploymentTxHash"
            };

        }

        const existingByGame = this._repository.findByGameId(
            validated.payload.gameId
        );

        if (existingByGame) {

            return {
                ok: true,
                code: DEPLOYMENT_COST_SERVICE_RESULT.SNAPSHOT_DUPLICATE,
                snapshot: existingByGame,
                message: "Snapshot already exists for gameId"
            };

        }

        try {

            const created = this._repository.create({
                ...validated.payload,
                status: DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP
            });

            this._logger?.info?.(
                `DeploymentCostSnapshot PENDING_LOOKUP | gameId=${created.payload?.gameId} | `
                    + `tx=${created.payload?.deploymentTxHash}`
            );

            return {
                ok: true,
                code: DEPLOYMENT_COST_SERVICE_RESULT.OK,
                snapshot: created,
                message: "PENDING_LOOKUP snapshot created"
            };

        } catch (error) {

            if (error instanceof DuplicateRecordError) {

                const raced = this._repository.findByDeploymentTxHash(
                    validated.payload.deploymentTxHash
                )
                    ?? this._repository.findByGameId(validated.payload.gameId);

                if (raced) {

                    return {
                        ok: true,
                        code: DEPLOYMENT_COST_SERVICE_RESULT.SNAPSHOT_DUPLICATE,
                        snapshot: raced,
                        message: "Snapshot already exists (race)"
                    };

                }

            }

            this._logger?.error?.(
                `DeploymentCostSnapshot create failed | ${error?.message ?? error}`
            );

            return {
                ok: false,
                code: DEPLOYMENT_COST_SERVICE_RESULT.SNAPSHOT_CREATION_FAILED,
                snapshot: null,
                message: error?.message ?? "Snapshot creation failed"
            };

        }

    }

    /**
     * Stage D — load PENDING_LOOKUP, query chain, freeze.
     *
     * @param {object|string} snapshotOrId
     * @returns {Promise<DeploymentCostServiceResult>}
     */
    async lookupAndFreezeSnapshot(snapshotOrId) {

        if (!this._initialized) {

            return {
                ok: false,
                code: DEPLOYMENT_COST_SERVICE_RESULT.NOT_INITIALIZED,
                snapshot: null,
                message: "DeploymentCostService is not initialized"
            };

        }

        const snapshot = typeof snapshotOrId === "string"
            ? this._repository.findById(snapshotOrId)
            : snapshotOrId;

        if (!snapshot?.payload) {

            return {
                ok: false,
                code: DEPLOYMENT_COST_SERVICE_RESULT.SNAPSHOT_NOT_FOUND,
                snapshot: null,
                message: "Snapshot not found"
            };

        }

        if (
            snapshot.payload.status === DEPLOYMENT_COST_SNAPSHOT_STATUS.FROZEN
        ) {

            return {
                ok: true,
                code: DEPLOYMENT_COST_SERVICE_RESULT.ALREADY_FROZEN,
                snapshot,
                message: "Snapshot already FROZEN"
            };

        }

        if (!this._transport?.getTransactions) {

            return {
                ok: false,
                code: DEPLOYMENT_COST_SERVICE_RESULT.LOOKUP_SKIPPED,
                snapshot,
                message: "No TonCenter transport configured"
            };

        }

        const {
            deploymentTxHash,
            deployWallet,
            contractAddress
        } = snapshot.payload;

        let tx = null;

        try {

            tx = await this.lookupDeploymentTransaction(
                deploymentTxHash,
                deployWallet
            );

        } catch (error) {

            this._bumpLookupAttempt(snapshot, error?.message ?? "rpc_failure");

            return {
                ok: false,
                code: DEPLOYMENT_COST_SERVICE_RESULT.LOOKUP_PENDING,
                snapshot: this._repository.findById(snapshot.recordId),
                reason: "rpc_failure",
                message: error?.message ?? "TonCenter lookup failed"
            };

        }

        if (!tx) {

            this._bumpLookupAttempt(snapshot, "transaction_not_found");

            return {
                ok: false,
                code: DEPLOYMENT_COST_SERVICE_RESULT.LOOKUP_PENDING,
                snapshot: this._repository.findById(snapshot.recordId),
                reason: "transaction_not_found",
                message: "DEPLOY transaction not found yet"
            };

        }

        const extracted = this.extractDeployCostFromTransaction(tx, {
            contractAddress,
            deploymentTxHash
        });

        if (!extracted.ok) {

            this._bumpLookupAttempt(snapshot, extracted.reason);

            return {
                ok: false,
                code: DEPLOYMENT_COST_SERVICE_RESULT.FREEZE_REJECTED,
                snapshot: this._repository.findById(snapshot.recordId),
                reason: extracted.reason,
                message: `Freeze rejected | ${extracted.reason}`
            };

        }

        try {

            const frozen = this._repository.freezeFromChain(snapshot.recordId, {
                attachedTon: nanotonToTonString(extracted.attachedNanoton),
                networkFeeTon: nanotonToTonString(extracted.networkFeeNanoton),
                deploymentCostTon: nanotonToTonString(
                    extracted.deploymentCostNanoton
                ),
                source: "chain",
                frozenAt: Date.now()
            });

            this._logger?.info?.(
                `DeploymentCostSnapshot FROZEN | gameId=${frozen.payload?.gameId} | `
                    + `cost=${frozen.payload?.deploymentCostTon}`
            );

            this._emitSnapshotFrozen(frozen);

            return {
                ok: true,
                code: DEPLOYMENT_COST_SERVICE_RESULT.OK,
                snapshot: frozen,
                message: "Snapshot FROZEN from chain"
            };

        } catch (error) {

            return {
                ok: false,
                code: DEPLOYMENT_COST_SERVICE_RESULT.LOOKUP_FAILED,
                snapshot: this._repository.findById(snapshot.recordId),
                message: error?.message ?? "Freeze persistence failed"
            };

        }

    }

    /**
     * @param {string} txHash
     * @param {string} deployWallet
     * @returns {Promise<object|null>}
     */
    async lookupDeploymentTransaction(txHash, deployWallet) {

        const hash = String(txHash ?? "").trim();
        const address = String(deployWallet ?? "").trim();

        if (!hash || !address) {

            return null;

        }

        const transactions = await this._transport.getTransactions(address, {
            limit: this._transactionLookupLimit,
            archival: true
        });

        const list = Array.isArray(transactions) ? transactions : [];

        for (const tx of list) {

            if (transactionHashOf(tx) === hash) {

                return tx;

            }

        }

        return null;

    }

    /**
     * Public wrapper for pure extractor (test / service API).
     *
     * @param {object} tx
     * @param {{ contractAddress: string, deploymentTxHash?: string|null }} options
     */
    extractDeployCostFromTransaction(tx, options) {

        return extractDeployCostFromTransaction(tx, options);

    }

    /**
     * Stage E — non-blocking startup recovery entry.
     *
     * @returns {Promise<object>}
     */
    async runBackgroundRecovery() {

        if (!this._initialized || this._recoveryRunning) {

            return {
                ok: false,
                skipped: true,
                reason: this._recoveryRunning ? "already_running" : "not_initialized"
            };

        }

        if (!isDeploymentCostSnapshotEnabled(this._env)) {

            return {
                ok: false,
                skipped: true,
                reason: "feature_disabled"
            };

        }

        this._recoveryRunning = true;

        this._logger?.info?.("DEPLOYMENT_COST_RECOVERY_STARTED");

        try {

            const missing = await this.recoverMissingSnapshots();
            const pending = await this.retryPendingSnapshots();
            const failed = await this.recoverFailedSnapshots();

            return {
                ok: true,
                missing,
                pending,
                failed
            };

        } finally {

            this._recoveryRunning = false;

        }

    }

    /**
     * Create PENDING_LOOKUP for deployed game_contracts missing a snapshot.
     *
     * @returns {Promise<{ scanned: number, created: number, skipped: number, results: object[] }>}
     */
    async recoverMissingSnapshots() {

        const contracts = this._repository.listDeployedGameContracts();
        let created = 0;
        let skipped = 0;
        const results = [];

        for (const contract of contracts) {

            const payload = contract.payload ?? {};
            const deploymentTxHash = String(payload.deploymentTxId ?? "").trim();
            const contractAddress = String(payload.contractAddress ?? "").trim();
            const gameId = String(payload.gameId ?? contract.gameId ?? "").trim();
            const roomId = String(payload.roomId ?? contract.roomId ?? "").trim();
            const contractId = String(
                payload.contractId ?? contract.contractId ?? contract.recordId ?? ""
            ).trim();
            const deployWallet = String(
                payload.snapshot?.oracleWallet
                ?? payload.oracleWallet
                ?? ""
            ).trim();

            if (!deploymentTxHash || !contractAddress || !gameId || !deployWallet) {

                skipped += 1;
                continue;

            }

            const existing = this._repository.findByDeploymentTxHash(deploymentTxHash)
                ?? this._repository.findByGameId(gameId);

            if (existing) {

                skipped += 1;
                continue;

            }

            const capture = this.createPendingSnapshot({
                gameId,
                roomId,
                contractId,
                contractAddress,
                deploymentTxHash,
                deployWallet,
                deployedAt: payload.deployedAt ?? Date.now(),
                timestamp: Date.now()
            });

            if (capture.ok && capture.code === DEPLOYMENT_COST_SERVICE_RESULT.OK) {

                created += 1;

                this._logger?.info?.(
                    `DEPLOYMENT_COST_SNAPSHOT_RECOVERED | gameId=${gameId} | `
                        + `tx=${deploymentTxHash}`
                );

                if (this._transport) {

                    const freeze = await this.lookupAndFreezeSnapshot(capture.snapshot);

                    results.push({ gameId, capture, freeze });

                } else {

                    results.push({ gameId, capture });

                }

            } else if (
                capture.ok
                && capture.code === DEPLOYMENT_COST_SERVICE_RESULT.SNAPSHOT_DUPLICATE
            ) {

                skipped += 1;

            } else {

                results.push({ gameId, capture });

            }

        }

        return {
            scanned: contracts.length,
            created,
            skipped,
            results
        };

    }

    /**
     * Retry PENDING_LOOKUP rows that are due (or stuck).
     *
     * @returns {Promise<{ scanned: number, attempted: number, frozen: number, results: object[] }>}
     */
    async retryPendingSnapshots() {

        const now = Date.now();
        const pending = this._repository.listByStatus(
            DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP
        );

        let attempted = 0;
        let frozen = 0;
        const results = [];

        for (const snapshot of pending) {

            const payload = snapshot.payload ?? {};

            if (isDeploymentCostSnapshotStuck(payload, now)) {

                this._logger?.warn?.(
                    `DEPLOYMENT_COST_LOOKUP_RETRY | stuck | gameId=${payload.gameId} | `
                        + `tx=${payload.deploymentTxHash} | `
                        + `attempt=${payload.lookupAttempts ?? 0}`
                );

            }

            if (
                !isDeploymentCostLookupDue(payload, now)
                && !isDeploymentCostSnapshotStuck(payload, now)
            ) {

                continue;

            }

            attempted += 1;

            this._logger?.info?.(
                `DEPLOYMENT_COST_LOOKUP_RETRY | gameId=${payload.gameId} | `
                    + `tx=${payload.deploymentTxHash} | `
                    + `attempt=${payload.lookupAttempts ?? 0} | `
                    + `status=${payload.status}`
            );

            const result = await this.lookupAndFreezeSnapshot(snapshot);

            if (
                result.ok
                && result.snapshot?.payload?.status
                    === DEPLOYMENT_COST_SNAPSHOT_STATUS.FROZEN
            ) {

                frozen += 1;

            }

            if (!result.ok) {

                this._logger?.warn?.(
                    `DEPLOYMENT_COST_LOOKUP_FAILED | gameId=${payload.gameId} | `
                        + `tx=${payload.deploymentTxHash} | `
                        + `reason=${result.reason ?? result.message}`
                );

            }

            results.push(result);

        }

        return {
            scanned: pending.length,
            attempted,
            frozen,
            results
        };

    }

    /**
     * Re-queue FAILED_LOOKUP → PENDING_LOOKUP when due, then lookup.
     *
     * @returns {Promise<{ scanned: number, requeued: number, frozen: number, results: object[] }>}
     */
    async recoverFailedSnapshots() {

        const now = Date.now();
        const failed = this._repository.listByStatus(
            DEPLOYMENT_COST_SNAPSHOT_STATUS.FAILED_LOOKUP
        );

        let requeued = 0;
        let frozen = 0;
        const results = [];

        for (const snapshot of failed) {

            const payload = snapshot.payload ?? {};

            if (!isDeploymentCostLookupDue(payload, now)) {

                continue;

            }

            try {

                this._repository.updatePendingLookup(snapshot.recordId, {
                    status: DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP,
                    errorReason: payload.errorReason ?? "failed_lookup_retry",
                    lookupAttempts: Number(payload.lookupAttempts ?? 0),
                    nextLookupAt: now
                });

                requeued += 1;

            } catch (error) {

                results.push({
                    ok: false,
                    message: error?.message ?? "requeue_failed",
                    snapshot
                });

                continue;

            }

            const refreshed = this._repository.findById(snapshot.recordId);
            const result = await this.lookupAndFreezeSnapshot(refreshed);

            if (
                result.ok
                && result.snapshot?.payload?.status
                    === DEPLOYMENT_COST_SNAPSHOT_STATUS.FROZEN
            ) {

                frozen += 1;

            }

            results.push(result);

        }

        return {
            scanned: failed.length,
            requeued,
            frozen,
            results
        };

    }

    /**
     * @param {string} hash
     * @returns {object|null}
     */
    getSnapshotByDeploymentTxHash(hash) {

        return this._repository.findByDeploymentTxHash(hash);

    }

    /**
     * @param {string} gameId
     * @returns {object|null}
     */
    getSnapshotByGameId(gameId) {

        return this._repository.findByGameId(gameId);

    }

    /**
     * @param {object} snapshot
     * @param {string} reason
     */
    _bumpLookupAttempt(snapshot, reason) {

        try {

            const attempts = Number(snapshot.payload?.lookupAttempts ?? 0) + 1;
            const terminal = attempts >= DEPLOYMENT_COST_LOOKUP_MAX_ATTEMPTS;

            this._repository.updatePendingLookup(snapshot.recordId, {
                status: terminal
                    ? DEPLOYMENT_COST_SNAPSHOT_STATUS.FAILED_LOOKUP
                    : DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP,
                errorReason: reason,
                lookupAttempts: attempts,
                nextLookupAt: deploymentCostNextLookupAt(attempts)
            });

            if (terminal) {

                this._logger?.warn?.(
                    `DEPLOYMENT_COST_LOOKUP_FAILED | terminal | `
                        + `gameId=${snapshot.payload?.gameId} | `
                        + `tx=${snapshot.payload?.deploymentTxHash} | `
                        + `attempt=${attempts} | status=FAILED_LOOKUP | `
                        + `errorReason=${reason}`
                );

            }

        } catch (error) {

            this._logger?.warn?.(
                `DeploymentCostSnapshot lookup attempt bump failed | `
                    + `${error?.message ?? error}`
            );

        }

    }

    /**
     * @param {DeploymentCostCaptureInput} input
     * @returns {object}
     */
    _normalizeCaptureInput(input) {

        if (!input || typeof input !== "object") {

            return {};

        }

        const deployedAt = Number(input.deployedAt);
        const timestamp = Number(input.timestamp);
        const createdAt = Number.isFinite(deployedAt)
            ? deployedAt
            : (Number.isFinite(timestamp) ? timestamp : Date.now());

        return {
            gameId: input.gameId,
            roomId: input.roomId,
            contractId: input.contractId,
            contractAddress: input.contractAddress,
            deploymentTxHash: input.deploymentTxHash,
            deployWallet: input.deployWallet,
            createdAt
        };

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    /**
     * R17.8V.2P.S — notify reimbursement deferred-create path.
     *
     * @param {object} frozen
     */
    _emitSnapshotFrozen(frozen) {

        const payload = frozen?.payload ?? {};

        try {

            this._eventBus?.emit?.({
                source: EVENT_SOURCES.DEPLOYMENT_COST_SERVICE,
                type: EVENT_TYPES.DEPLOYMENT_COST_SNAPSHOT_FROZEN,
                payload: Object.freeze({
                    gameId: payload.gameId ?? null,
                    roomId: payload.roomId ?? null,
                    contractId: payload.contractId ?? null,
                    deploymentTxHash: payload.deploymentTxHash ?? null,
                    deploymentCostTon: payload.deploymentCostTon ?? null,
                    timestamp: Date.now()
                })
            });

        } catch (error) {

            this._logger?.warn?.(
                `DEPLOYMENT_COST_SNAPSHOT_FROZEN emit failed | `
                    + `${error?.message ?? error}`
            );

        }

    }

}
