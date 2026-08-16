/**
 * R17.8V.2P.M / O / P / Q — Deployment reimbursement worker.
 *
 * Send queue: PENDING / FAILED_RETRY (no txHash) → send → markSent | awaiting hash.
 * Confirmation queue: PROCESSING+txHash / AWAITING_TRANSACTION_HASH recovery.
 * Emergency stop: no send, no FAILED_RETRY corruption, queue remains.
 */

import { isDeploymentReimbursementEnabled } from "./deploymentReimbursementConfig.js";
import { isReimbursementSendAllowed } from "./ReimbursementWalletConfig.js";
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
            "DeploymentReimbursementWorker initialized (Stage Q safety)"
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
     * @returns {Promise<object>}
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

            const results = [];
            let claimed = 0;
            let scanned = 0;

            // Confirmation / hash recovery always allowed when master flag is on.
            let confirmation = null;

            if (this._confirmationService?.recoverPendingConfirmations) {

                confirmation = await this._confirmationService
                    .recoverPendingConfirmations();

            }

            // Operational pause: do not send, do not FAIL_RETRY, leave queue intact.
            if (!isReimbursementSendAllowed(this._env)) {

                return {
                    scanned: 0,
                    claimed: 0,
                    results: [],
                    confirmation,
                    skipped: "send_paused"
                };

            }

            const pending = this._repository.listPending();

            scanned = pending.length;

            for (const record of pending) {

                if (String(record.payload?.txHash ?? "").trim()) {

                    results.push({
                        ok: false,
                        recordId: record.recordId,
                        message: "skip_send_has_txhash"
                    });

                    continue;

                }

                if (
                    record.payload?.status
                        === DEPLOYMENT_REIMBURSEMENT_STATUS.AWAITING_TRANSACTION_HASH
                ) {

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
                        transfer.code
                            === REIMBURSEMENT_TRANSFER_RESULT.FEATURE_DISABLED
                    ) {

                        // Emergency / policy pause — restore PENDING, no retry corruption.
                        this._repository.updateStatus(claimedRecord.recordId, {
                            status: DEPLOYMENT_REIMBURSEMENT_STATUS.PENDING,
                            errorReason: null,
                            processedAt: null
                        });

                        results.push({
                            ok: false,
                            recordId: claimedRecord.recordId,
                            transfer,
                            code: REIMBURSEMENT_TRANSFER_RESULT.FEATURE_DISABLED
                        });

                        continue;

                    }

                    if (
                        transfer.ok
                        && transfer.code === REIMBURSEMENT_TRANSFER_RESULT.SENT
                        && transfer.txHash
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

                    if (
                        transfer.ok
                        && transfer.code
                            === REIMBURSEMENT_TRANSFER_RESULT.AWAITING_TRANSACTION_HASH
                    ) {

                        this._repository.markAwaitingTransactionHash(
                            claimedRecord.recordId,
                            {
                                processedAt: Date.now(),
                                seqno: transfer.seqno ?? null
                            }
                        );

                        results.push({
                            ok: true,
                            recordId: claimedRecord.recordId,
                            transfer,
                            code: REIMBURSEMENT_TRANSFER_RESULT.AWAITING_TRANSACTION_HASH
                        });

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

            return {
                scanned,
                claimed,
                results,
                confirmation
            };

        } finally {

            this._processing = false;

        }

    }

    /**
     * R17.8V.2P.S — recover PROCESSING orphans without txHash (no blind resend).
     *
     * @returns {Promise<object>}
     */
    async recoverProcessingWithoutHash() {

        if (!this._confirmationService?.recoverProcessingWithoutHash) {

            return { scanned: 0, results: [], skipped: "no_confirmation_service" };

        }

        return this._confirmationService.recoverProcessingWithoutHash();

    }

}
