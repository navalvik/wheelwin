import { MAINNET_GLOBAL_ID } from "../config/MainnetRuntimeConfig.js";

const RECONCILABLE_LEG_STATES = new Set(["SUBMISSION_UNKNOWN", "SUBMITTED"]);

/** Bounded scheduler for existing read-only MainnetPayoutLifecycle reconciliation. */
export class MainnetPendingPayoutReconciler {
    constructor({ financialLedger, payoutLifecycle, maxPerPass = 2, logger = null } = {}) {
        if (financialLedger?.network !== "mainnet" || financialLedger?.globalId !== MAINNET_GLOBAL_ID
            || typeof financialLedger.listPayouts !== "function"
            || typeof payoutLifecycle?.reconcilePayout !== "function"
            || !Number.isSafeInteger(maxPerPass) || maxPerPass < 1 || maxPerPass > 2) {
            throw new Error("MAINNET_PAYOUT_RECONCILER_CONFIG_INVALID");
        }
        this._ledger = financialLedger;
        this._lifecycle = payoutLifecycle;
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
            const payouts = this._ledger.listPayouts();
            if (!Array.isArray(payouts)) throw new Error("MAINNET_PAYOUT_LEDGER_RESPONSE_INVALID");
            const eligible = payouts.filter(payout => typeof payout?.payoutId === "string"
                && payout.payoutId.length > 0
                && [payout.winner, payout.owner].some(leg =>
                    RECONCILABLE_LEG_STATES.has(leg?.state)));
            if (eligible.length === 0) {
                this._cursor = 0;
                return Object.freeze({ status: "NO_SUBMITTED_PAYOUTS", scanned: 0,
                    results: Object.freeze([]) });
            }

            const count = Math.min(eligible.length, this._max);
            const results = [];
            for (let index = 0; index < count; index += 1) {
                const payout = eligible[(this._cursor + index) % eligible.length];
                try {
                    const result = await this._lifecycle.reconcilePayout(payout.payoutId);
                    results.push(Object.freeze({ payoutId: payout.payoutId,
                        status: result?.status ?? "PAYOUT_RECONCILIATION_RETRY_LATER",
                        winnerState: result?.winnerState ?? null,
                        ownerState: result?.ownerState ?? null }));
                } catch (error) {
                    this._logger?.warn?.("MAINNET_PAYOUT_RECONCILIATION_RETRY_LATER"
                        + ` | code=${error?.code ?? "PROVIDER_UNAVAILABLE"}`);
                    results.push(Object.freeze({ payoutId: payout.payoutId,
                        status: "PAYOUT_RECONCILIATION_RETRY_LATER" }));
                }
            }
            this._cursor = (this._cursor + count) % eligible.length;
            return Object.freeze({ status: "READ_ONLY_PAYOUT_PASS_COMPLETE", scanned: count,
                results: Object.freeze(results) });
        } finally {
            this._running = false;
        }
    }

    stop() { this._stopped = true; }
}
