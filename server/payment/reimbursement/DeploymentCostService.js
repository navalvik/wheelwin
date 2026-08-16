/**
 * R17.8V.2P.I — Deployment Cost Snapshot service foundation (Stage B).
 *
 * Creates PENDING_LOOKUP snapshots via repository only.
 * No EventBus wiring, blockchain lookup, freeze, or reimbursement.
 */

import { DuplicateRecordError } from "../../persistence/TonFinancialPersistence.js";
import { isDeploymentCostSnapshotEnabled } from "./deploymentCostSnapshotConfig.js";
import { DEPLOYMENT_COST_SNAPSHOT_STATUS } from "./deploymentCostSnapshotStates.js";
import { validateDeploymentCostSnapshotCreateInput } from "./deploymentCostSnapshotSchema.js";
import { DEPLOYMENT_COST_SERVICE_RESULT } from "./deploymentCostServiceResults.js";

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
 */

export class DeploymentCostService {

    /**
     * @param {{
     *   repository: import("./DeploymentCostSnapshotRepository.js").DeploymentCostSnapshotRepository,
     *   logger?: { debug?: Function, info?: Function, warn?: Function, error?: Function }|null,
     *   env?: NodeJS.ProcessEnv
     * }} options
     */
    constructor({
        repository,
        logger = null,
        env = process.env
    } = {}) {

        if (!repository) {

            throw new Error("DeploymentCostService requires DeploymentCostSnapshotRepository");

        }

        this._repository = repository;

        this._logger = logger;

        this._env = env;

        this._initialized = false;

    }

    initialize() {

        this._initialized = true;

        this._logger?.debug?.("DeploymentCostService initialized (Stage B skeleton)");

    }

    shutdown() {

        this._initialized = false;

        this._logger?.debug?.("DeploymentCostService shutdown");

    }

    /**
     * Primary Stage B entry: validate + create PENDING_LOOKUP (or return existing).
     * Non-blocking result object — does not throw for business outcomes.
     *
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
     * Create PENDING_LOOKUP snapshot. Idempotent on deploymentTxHash.
     *
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

}
