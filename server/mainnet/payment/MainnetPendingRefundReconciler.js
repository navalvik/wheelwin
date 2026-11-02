import { MAINNET_GLOBAL_ID } from "../config/MainnetRuntimeConfig.js";

const ELIGIBLE_STATES = new Set(["SUBMISSION_UNKNOWN", "SUBMITTED"]);

/** Bounded scheduler for the existing read-only MainnetRefundLifecycle reconciliation. */
export class MainnetPendingRefundReconciler {
    constructor({ financialLedger, refundLifecycle, maxPerPass = 2, logger = null } = {}) {
        if (financialLedger?.network !== "mainnet" || financialLedger?.globalId !== MAINNET_GLOBAL_ID
            || typeof financialLedger.listPendingRefunds !== "function"
            || typeof refundLifecycle?.reconcileRefund !== "function"
            || !Number.isSafeInteger(maxPerPass) || maxPerPass < 1 || maxPerPass > 2) {
            throw new Error("MAINNET_REFUND_RECONCILER_CONFIG_INVALID");
        }
        this._ledger = financialLedger;
        this._lifecycle = refundLifecycle;
        this._max = maxPerPass;
        this._logger = logger;
        this._cursor = 0;
        this._running = false;
        this._stopped = false;
    }

    async runPass() {
        if (this._stopped) return Object.freeze({ status: "RECONCILIATION_STOPPED", scanned: 0,
            results: Object.freeze([]) });
        if (this._running) return Object.freeze({ status: "RECONCILIATION_IN_PROGRESS", scanned: 0,
            results: Object.freeze([]) });
        this._running = true;
        try {
            const pending = this._ledger.listPendingRefunds();
            if (!Array.isArray(pending)) throw new Error("MAINNET_REFUND_LEDGER_RESPONSE_INVALID");
            const eligible = pending.filter(item => item?.network === "mainnet"
                && item.globalId === MAINNET_GLOBAL_ID && ELIGIBLE_STATES.has(item.state)
                && typeof item.obligationId === "string" && item.obligationId.length > 0);
            if (eligible.length === 0) {
                this._cursor = 0;
                return Object.freeze({ status: "NO_SUBMITTED_REFUNDS", scanned: 0,
                    results: Object.freeze([]) });
            }

            const count = Math.min(eligible.length, this._max);
            const results = [];
            for (let index = 0; index < count; index += 1) {
                const obligation = eligible[(this._cursor + index) % eligible.length];
                try {
                    const result = await this._lifecycle.reconcileRefund(obligation.obligationId);
                    results.push(Object.freeze({ obligationId: obligation.obligationId,
                        outcome: result?.outcome ?? "REFUND_RECONCILIATION_RETRY_LATER" }));
                } catch (error) {
                    this._logger?.warn?.("MAINNET_REFUND_RECONCILIATION_RETRY_LATER"
                        + ` | code=${error?.code ?? "PROVIDER_UNAVAILABLE"}`);
                    results.push(Object.freeze({ obligationId: obligation.obligationId,
                        outcome: "REFUND_RECONCILIATION_RETRY_LATER" }));
                }
            }
            this._cursor = (this._cursor + count) % eligible.length;
            return Object.freeze({ status: "READ_ONLY_REFUND_PASS_COMPLETE", scanned: count,
                results: Object.freeze(results) });
        } finally {
            this._running = false;
        }
    }

    stop() { this._stopped = true; }
}
