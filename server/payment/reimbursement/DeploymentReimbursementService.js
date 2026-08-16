/**
 * R17.8V.2P.M — Deployment reimbursement service foundation.
 *
 * Creates queue records from FROZEN cost snapshots only.
 * No TON transfer / wallet signing.
 */

import { DEPLOYMENT_COST_SNAPSHOT_STATUS } from "./deploymentCostSnapshotStates.js";
import { isDeploymentReimbursementEnabled } from "./deploymentReimbursementConfig.js";
import { DEPLOYMENT_REIMBURSEMENT_STATUS } from "./deploymentReimbursementStates.js";
import { DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT } from "./deploymentReimbursementServiceResults.js";
import { DuplicateRecordError } from "../../persistence/TonFinancialPersistence.js";

export class DeploymentReimbursementService {

    /**
     * @param {{
     *   repository: import("./DeploymentReimbursementRepository.js").DeploymentReimbursementRepository,
     *   reimbursementWallet?: string|null,
     *   logger?: object|null,
     *   env?: NodeJS.ProcessEnv
     * }} options
     */
    constructor({
        repository,
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

        const walletFromEnv = String(
            env?.TON_REIMBURSEMENT_EXPECTED_ADDRESS ?? ""
        ).trim();

        this._reimbursementWallet = reimbursementWallet
            ?? (walletFromEnv || null);

        this._logger = logger;

        this._env = env;

        this._initialized = false;

    }

    initialize() {

        this._initialized = true;

        this._logger?.debug?.(
            "DeploymentReimbursementService initialized (Stage M foundation)"
        );

    }

    shutdown() {

        this._initialized = false;

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

}
