import { MAINNET_GLOBAL_ID } from "../config/MainnetRuntimeConfig.js";

/** Bounded executor for new Mainnet PENDING refunds; unknown sends are reconciled elsewhere. */
export class MainnetPendingRefundExecutor {
    constructor({ paymentRuntime, maxPerPass = 3, logger = null } = {}) {
        if (paymentRuntime?.network !== "mainnet" || paymentRuntime?.globalId !== MAINNET_GLOBAL_ID
            || typeof paymentRuntime.liveOperationsEnabled !== "boolean"
            || paymentRuntime.financialLedger?.network !== "mainnet"
            || paymentRuntime.financialLedger?.globalId !== MAINNET_GLOBAL_ID
            || typeof paymentRuntime.financialLedger.listPendingRefunds !== "function"
            || typeof paymentRuntime.refundLifecycle?.submitRefund !== "function"
            || !Number.isSafeInteger(maxPerPass) || maxPerPass < 1 || maxPerPass > 3) {
            throw new Error("MAINNET_PENDING_REFUND_EXECUTOR_CONFIG_INVALID");
        }
        this._runtime = paymentRuntime;
        this._max = maxPerPass;
        this._logger = logger;
        this._cursor = 0;
        this._running = false;
        this._stopped = false;
    }

    async runPass() {
        if (this._stopped) return Object.freeze({ status: "EXECUTOR_STOPPED", attempted: 0,
            results: Object.freeze([]) });
        if (this._running) return Object.freeze({ status: "EXECUTOR_IN_PROGRESS", attempted: 0,
            results: Object.freeze([]) });
        if (this._runtime.liveOperationsEnabled !== true) {
            return Object.freeze({ status: "LIVE_OPERATIONS_DISABLED", attempted: 0,
                results: Object.freeze([]) });
        }

        this._running = true;
        try {
            const pending = this._runtime.financialLedger.listPendingRefunds();
            if (!Array.isArray(pending)) throw new Error("MAINNET_REFUND_LEDGER_RESPONSE_INVALID");
            const eligible = pending.filter(item => item?.network === "mainnet"
                && item.globalId === MAINNET_GLOBAL_ID && item.state === "PENDING"
                && typeof item.obligationId === "string" && item.obligationId.length > 0);
            if (eligible.length === 0) {
                this._cursor = 0;
                return Object.freeze({ status: "NO_PENDING_REFUNDS", attempted: 0,
                    results: Object.freeze([]) });
            }

            const start = this._cursor % eligible.length;
            const count = Math.min(this._max, eligible.length);
            const results = [];
            for (let index = 0; index < count; index += 1) {
                const obligation = eligible[(start + index) % eligible.length];
                try {
                    const result = await this._runtime.refundLifecycle.submitRefund(obligation.obligationId);
                    results.push(Object.freeze({ obligationId: obligation.obligationId,
                        outcome: result?.outcome ?? "REFUND_SUBMISSION_RETRY_LATER" }));
                } catch (error) {
                    this._logger?.warn?.("MAINNET_PENDING_REFUND_SUBMISSION_RETRY_LATER"
                        + ` | code=${error?.code ?? "SUBMISSION_FAILED"}`);
                    results.push(Object.freeze({ obligationId: obligation.obligationId,
                        outcome: "REFUND_SUBMISSION_RETRY_LATER" }));
                }
            }
            this._cursor = (start + count) % eligible.length;
            return Object.freeze({ status: "REFUND_EXECUTION_PASS_COMPLETE", attempted: count,
                results: Object.freeze(results) });
        } finally {
            this._running = false;
        }
    }

    stop() { this._stopped = true; }
}
