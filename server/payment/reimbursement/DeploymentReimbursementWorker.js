/**
 * R17.8V.2P.M / O / P / Q — Deployment reimbursement worker.
 *
 * Residues role migration: send is permanently retired.
 * Historical PENDING / FAILED_RETRY records remain readable and are never
 * paid. Confirmation recovery does not sign or broadcast.
 */

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

        this._logger?.info?.(
            "DeploymentReimbursementWorker initialized | send permanently retired | no timer"
        );

    }

    shutdown() {

        if (this._timer) {

            clearInterval(this._timer);
            this._timer = null;

        }

        this._initialized = false;

    }

    /**
     * Never sends TON. Flags, pending records, and restart cannot revive spend.
     *
     * @returns {Promise<object>}
     */
    async processQueue() {

        if (!this._initialized) {

            return { scanned: 0, claimed: 0, results: [], skipped: "not_initialized" };

        }

        void this._env;
        void this._transferService;
        void this._processing;
        void this._pollIntervalMs;

        this._logger?.debug?.(
            "DeploymentReimbursementWorker processQueue skipped | send permanently retired"
        );

        return {
            scanned: 0,
            claimed: 0,
            results: [],
            skipped: "send_permanently_retired"
        };

    }

    /**
     * Observe-only hash recovery. Never signs or broadcasts.
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
