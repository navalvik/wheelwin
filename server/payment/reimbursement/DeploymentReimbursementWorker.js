/**
 * R17.8V.2P.M — Deployment reimbursement worker skeleton.
 *
 * Polls PENDING records and claims PROCESSING. Does not send TON.
 */

import { isDeploymentReimbursementEnabled } from "./deploymentReimbursementConfig.js";
import { DEPLOYMENT_REIMBURSEMENT_STATUS } from "./deploymentReimbursementStates.js";
import { DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT } from "./deploymentReimbursementServiceResults.js";

export class DeploymentReimbursementWorker {

    /**
     * @param {{
     *   repository: import("./DeploymentReimbursementRepository.js").DeploymentReimbursementRepository,
     *   transferService?: import("./ReimbursementTransferService.js").ReimbursementTransferService|null,
     *   logger?: object|null,
     *   env?: NodeJS.ProcessEnv,
     *   pollIntervalMs?: number
     * }} options
     */
    constructor({
        repository,
        transferService = null,
        logger = null,
        env = process.env,
        pollIntervalMs = 5_000
    } = {}) {

        if (!repository) {

            throw new Error(
                "DeploymentReimbursementWorker requires DeploymentReimbursementRepository"
            );

        }

        this._repository = repository;

        this._transferService = transferService;

        this._logger = logger;

        this._env = env;

        this._pollIntervalMs = Number.isFinite(Number(pollIntervalMs))
            ? Math.max(1_000, Number(pollIntervalMs))
            : 5_000;

        this._initialized = false;

        this._timer = null;

        this._processing = false;

    }

    initialize() {

        if (this._initialized) {

            return;

        }

        this._initialized = true;

        this._logger?.debug?.(
            "DeploymentReimbursementWorker initialized (Stage M skeleton)"
        );

        if (isDeploymentReimbursementEnabled(this._env)) {

            this._timer = setInterval(() => {

                void this.processQueue().catch((error) => {

                    this._logger?.error?.(
                        `DeploymentReimbursementWorker processQueue error | `
                            + `${error?.message ?? error}`
                    );

                });

            }, this._pollIntervalMs);

            if (typeof this._timer.unref === "function") {

                this._timer.unref();

            }

        }

    }

    shutdown() {

        if (this._timer) {

            clearInterval(this._timer);

            this._timer = null;

        }

        this._initialized = false;

    }

    /**
     * Claim pending items and invoke transfer boundary (NOT_IMPLEMENTED in Stage M).
     *
     * @returns {Promise<{ scanned: number, claimed: number, results: object[] }>}
     */
    async processQueue() {

        if (!this._initialized) {

            return { scanned: 0, claimed: 0, results: [], skipped: "not_initialized" };

        }

        if (!isDeploymentReimbursementEnabled(this._env)) {

            return { scanned: 0, claimed: 0, results: [], skipped: "feature_disabled" };

        }

        if (this._processing) {

            return { scanned: 0, claimed: 0, results: [], skipped: "busy" };

        }

        this._processing = true;

        try {

            const pending = this._repository.listPending();
            let claimed = 0;
            const results = [];

            for (const record of pending) {

                let claimedRecord = null;

                try {

                    claimedRecord = this._repository.updateStatus(record.recordId, {
                        status: DEPLOYMENT_REIMBURSEMENT_STATUS.PROCESSING,
                        processedAt: Date.now()
                    });

                    claimed += 1;

                } catch (error) {

                    results.push({
                        ok: false,
                        recordId: record.recordId,
                        message: error?.message ?? "claim_failed"
                    });

                    continue;

                }

                const transfer = this._transferService?.sendReimbursement?.(claimedRecord)
                    ?? {
                        ok: false,
                        code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.NOT_IMPLEMENTED,
                        message: "No transfer service"
                    };

                // Stage M: roll back to PENDING / FAILED_RETRY — never CONFIRMED.
                try {

                    this._repository.updateStatus(claimedRecord.recordId, {
                        status: DEPLOYMENT_REIMBURSEMENT_STATUS.FAILED_RETRY,
                        errorReason: transfer.code
                            ?? transfer.message
                            ?? "transfer_not_implemented",
                        retryCount: Number(claimedRecord.payload?.retryCount ?? 0) + 1,
                        nextRetryAt: Date.now() + 60_000
                    });

                } catch (error) {

                    results.push({
                        ok: false,
                        recordId: claimedRecord.recordId,
                        transfer,
                        message: error?.message ?? "status_update_failed"
                    });

                    continue;

                }

                results.push({
                    ok: false,
                    recordId: claimedRecord.recordId,
                    transfer,
                    code: DEPLOYMENT_REIMBURSEMENT_SERVICE_RESULT.NOT_IMPLEMENTED
                });

            }

            return {
                scanned: pending.length,
                claimed,
                results
            };

        } finally {

            this._processing = false;

        }

    }

}
