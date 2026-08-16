/**
 * R17.8V.2P.I–K — Deployment Cost Snapshot service.
 *
 * Stage B: PENDING_LOOKUP create API.
 * Stage C: EventBus subscription.
 * Stage D: TonCenter lookup + FROZEN (chain economics only).
 */

import { EVENT_TYPES } from "../../events/EventTypes.js";
import { DuplicateRecordError } from "../../persistence/TonFinancialPersistence.js";
import { isDeploymentCostSnapshotEnabled } from "./deploymentCostSnapshotConfig.js";
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
            "DeploymentCostService initialized (Stage D lookup+freeze)"
        );

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

            this._repository.updatePendingLookup(snapshot.recordId, {
                status: DEPLOYMENT_COST_SNAPSHOT_STATUS.PENDING_LOOKUP,
                errorReason: reason,
                lookupAttempts: attempts,
                nextLookupAt: Date.now() + Math.min(60_000, 1_000 * attempts)
            });

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

}
