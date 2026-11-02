import { MAINNET_GLOBAL_ID } from "../config/MainnetRuntimeConfig.js";
import { mainnetAddressIdentity } from "./MainnetAddress.js";

/** Bounded Mainnet payout submission for plans whose next leg is still PENDING. */
export class MainnetPendingPayoutExecutor {
    constructor({ paymentRuntime, walletPool, maxPerPass = 2, logger = null } = {}) {
        if (paymentRuntime?.network !== "mainnet" || paymentRuntime?.globalId !== MAINNET_GLOBAL_ID
            || typeof paymentRuntime.liveOperationsEnabled !== "boolean"
            || paymentRuntime.financialLedger?.network !== "mainnet"
            || paymentRuntime.financialLedger?.globalId !== MAINNET_GLOBAL_ID
            || typeof paymentRuntime.financialLedger.listPayouts !== "function"
            || typeof paymentRuntime.payoutLifecycle?.submitPayout !== "function"
            || walletPool?.network !== "mainnet"
            || typeof walletPool.getReservationForRoom !== "function"
            || !Number.isSafeInteger(maxPerPass) || maxPerPass < 1 || maxPerPass > 2) {
            throw new Error("MAINNET_PENDING_PAYOUT_EXECUTOR_CONFIG_INVALID");
        }
        this._runtime = paymentRuntime;
        this._walletPool = walletPool;
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
            const payouts = this._runtime.financialLedger.listPayouts();
            if (!Array.isArray(payouts)) throw new Error("MAINNET_PAYOUT_LEDGER_RESPONSE_INVALID");
            const eligible = payouts.filter(payout => typeof payout?.payoutId === "string"
                && payout.payoutId.length > 0
                && (payout.winner?.state === "PENDING"
                    || (payout.winner?.state === "CONFIRMED" && payout.owner?.state === "PENDING")));
            if (eligible.length === 0) {
                this._cursor = 0;
                return Object.freeze({ status: "NO_PENDING_PAYOUT_SUBMISSIONS", attempted: 0,
                    results: Object.freeze([]) });
            }

            const start = this._cursor % eligible.length;
            const count = Math.min(this._max, eligible.length);
            const results = [];
            for (let index = 0; index < count; index += 1) {
                const payout = eligible[(start + index) % eligible.length];
                const reservation = this._getOwnedReservation(payout);
                if (!reservation) {
                    results.push(Object.freeze({ payoutId: payout.payoutId,
                        status: "PAYOUT_WALLET_RESERVATION_MISSING_HOLD" }));
                    continue;
                }
                try {
                    const outcome = await this._runtime.payoutLifecycle.submitPayout(payout.payoutId);
                    results.push(Object.freeze({ payoutId: payout.payoutId,
                        status: outcome?.status ?? "PAYOUT_SUBMISSION_RETRY_LATER" }));
                } catch (error) {
                    this._logger?.warn?.("MAINNET_PENDING_PAYOUT_SUBMISSION_RETRY_LATER"
                        + ` | code=${error?.code ?? "SUBMISSION_FAILED"}`);
                    results.push(Object.freeze({ payoutId: payout.payoutId,
                        status: "PAYOUT_SUBMISSION_RETRY_LATER" }));
                }
            }
            this._cursor = (start + count) % eligible.length;
            return Object.freeze({ status: "PAYOUT_EXECUTION_PASS_COMPLETE", attempted: count,
                results: Object.freeze(results) });
        } finally {
            this._running = false;
        }
    }

    _getOwnedReservation(payout) {
        try {
            const reservation = this._walletPool.getReservationForRoom(payout.roomId);
            if (!reservation || reservation.network !== "mainnet"
                || reservation.roomNumber !== payout.roomNumber || reservation.roomNumber === 1
                || typeof reservation.walletId !== "string" || !reservation.walletId
                || reservation.reservedByRoomId !== payout.roomId
                || mainnetAddressIdentity(reservation.address)
                    !== mainnetAddressIdentity(payout.sourceWalletAddress)) return null;
            return reservation;
        } catch {
            return null;
        }
    }

    stop() { this._stopped = true; }
}
