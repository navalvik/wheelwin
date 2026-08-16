/**
 * R17.8V.2P.M / O / P — Deployment reimbursement worker.
 *
 * Send queue: PENDING / FAILED_RETRY (no txHash) → send → markSent.
 * Confirmation queue: PROCESSING+txHash → confirmation service (never marks CONFIRMED here).
 */

import { isDeploymentReimbursementEnabled } from "./deploymentReimbursementConfig.js";
import { DEPLOYMENT_REIMBURSEMENT_STATUS } from "./deploymentReimbursementStates.js";
import {
    REIMBURSEMENT_TRANSFER_RESULT
} from "./ReimbursementTransferService.js";

export class DeploymentReimbursementWorker {

    /**
     * @param {{
     *   repository: import("./DeploymentReimbursementRepository.js").DeploymentReimbursementRepository,
     *   transferService?: import("./ReimbursementTransferService.js").ReimbursementTransferService|null,
     *   confirmationService?: import("./ReimbursementConfirmationService.js").ReimbursementConfirmationService|null,
     *   logger?: object|null,
     *   env?: NodeJS.ProcessEnv,
     *   pollIntervalMs?: number
     * }} options
     */
    constructor({
        repository,
        transferService = null,
        confirmationService = null,
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

        this._confirmationService = confirmationService;

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
            "DeploymentReimbursementWorker initialized (Stage P confirmation)"
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
     * @returns {Promise<{
     *   scanned: number,
     *   claimed: number,
     *   results: object[],
     *   confirmation?: object
     * }>}
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

                // Guard: never send when txHash already present.
                if (String(record.payload?.txHash ?? "").trim()) {

                    results.push({
                        ok: false,
                        recordId: record.recordId,
                        message: "skip_send_has_txhash"
                    });

                    continue;

                }

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

                let transfer;

                try {

                    transfer = await this._transferService?.sendReimbursement?.(
                        claimedRecord
                    );

                } catch (error) {

                    transfer = {
                        ok: false,
                        code: REIMBURSEMENT_TRANSFER_RESULT.FAILED,
                        errorReason: error?.message ?? "transfer_threw"
                    };

                }

                if (!transfer) {

                    transfer = {
                        ok: false,
                        code: REIMBURSEMENT_TRANSFER_RESULT.FAILED,
                        errorReason: "no_transfer_service"
                    };

                }

                try {

                    if (
                        transfer.ok
                        && transfer.code === REIMBURSEMENT_TRANSFER_RESULT.SENT
                    ) {

                        const sent = this._repository.markSent(claimedRecord.recordId, {
                            txHash: transfer.txHash,
                            processedAt: Date.now()
                        });

                        results.push({
                            ok: true,
                            recordId: claimedRecord.recordId,
                            transfer,
                            code: REIMBURSEMENT_TRANSFER_RESULT.SENT
                        });

                        // Enqueue confirmation asynchronously — worker never marks CONFIRMED.
                        if (this._confirmationService?.confirmTransaction) {

                            void this._confirmationService
                                .confirmTransaction(sent)
                                .catch((error) => {

                                    this._logger?.error?.(
                                        `Confirmation after send failed | `
                                            + `${error?.message ?? error}`
                                    );

                                });

                        }

                        continue;

                    }

                    this._repository.markFailed(claimedRecord.recordId, {
                        terminal: false,
                        errorReason: transfer.errorReason
                            ?? transfer.code
                            ?? "transfer_failed"
                    });

                    results.push({
                        ok: false,
                        recordId: claimedRecord.recordId,
                        transfer,
                        code: transfer.code ?? REIMBURSEMENT_TRANSFER_RESULT.FAILED
                    });

                } catch (error) {

                    results.push({
                        ok: false,
                        recordId: claimedRecord.recordId,
                        transfer,
                        message: error?.message ?? "status_update_failed"
                    });

                }

            }

            let confirmation = null;

            if (this._confirmationService?.recoverPendingConfirmations) {

                confirmation = await this._confirmationService
                    .recoverPendingConfirmations();

            }

            return {
                scanned: pending.length,
                claimed,
                results,
                confirmation
            };

        } finally {

            this._processing = false;

        }

    }

}
