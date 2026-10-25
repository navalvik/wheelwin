/**
 * Restart-safe READ-ONLY confirmation worker for already-signed native GRAM
 * Room Wallet transfers. It CANNOT send or retry a BOC.
 *
 * Scans BOTH independent Testnet indexers, verifies exact signed message +
 * receipt, rechecks authoritative seqno, and finishes durable journal state
 * through the same RoomWalletOutboundChainFinalizer as the guarded sender.
 *
 * All provider requests pass the shared read budget used by other 50-room
 * payment observers. The worker is OFF unless explicitly started.
 */
import { fetchOutgoingConfirmationHistory } from "./RoomWalletOutgoingChainScanner.js";

export class RoomWalletOutboundConfirmationWorker {
    constructor({
        journal, walletGate, finalizer,
        requestBudget = null,
        scanner = fetchOutgoingConfirmationHistory,
        fetchImpl = globalThis.fetch,
        logger = null,
        now = () => Date.now(),
        maxIntentsPerSweep = 2,
        sweepIntervalMs = 15_000,
        unknownRetryMs = 45_000,
        failureRetryMs = 30_000
    } = {}) {
        if (typeof journal?.listUnresolvedSignedIntents !== "function"
            || typeof walletGate?.recoverConfirmedLocks !== "function"
            || typeof finalizer?.reconcile !== "function"
            || typeof scanner !== "function"
            || typeof fetchImpl !== "function"
            || (requestBudget !== null && typeof requestBudget?.schedule !== "function")
            || typeof now !== "function"
            || !Number.isInteger(maxIntentsPerSweep)
            || maxIntentsPerSweep < 1 || maxIntentsPerSweep > 4
            || !Number.isInteger(sweepIntervalMs) || sweepIntervalMs < 1000
            || !Number.isInteger(unknownRetryMs) || unknownRetryMs < 1000
            || !Number.isInteger(failureRetryMs) || failureRetryMs < 1000) {
            throw new TypeError("Invalid Room Wallet outbound confirmation worker dependencies");
        }
        this._journal = journal;
        this._gate = walletGate;
        this._finalizer = finalizer;
        this._scanner = scanner;
        this._requestBudget = requestBudget;
        this._fetchImpl = fetchImpl;
        this._logger = logger;
        this._now = now;
        this._maxIntents = maxIntentsPerSweep;
        this._interval = sweepIntervalMs;
        this._unknownRetry = unknownRetryMs;
        this._failureRetry = failureRetryMs;
        this._attempts = new Map();
        this._inFlight = false;
        this._stopped = false;
        this._timer = null;
    }

    start() {
        if (this._stopped || this._timer) return;
        this._timer = setInterval(() => {
            void this.runOnce().catch(error => {
                this._logger?.error?.(
                    "Room Wallet outgoing confirmation sweep failed"
                    + " | code=" + (error?.code ?? error?.name ?? "unknown")
                );
            });
        }, this._interval);
        this._timer.unref?.();
    }

    shutdown() {
        this._stopped = true;
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
    }

    async runOnce() {
        if (this._stopped) {
            return Object.freeze({ skipped: "stopped", attempted: 0 });
        }
        if (this._inFlight) {
            return Object.freeze({ skipped: "in_flight", attempted: 0 });
        }
        this._inFlight = true;
        const report = {
            attempted: 0,
            confirmed: 0,
            unknown: 0,
            failed: 0,
            pending: 0,
            recoveredSettledLocks: 0,
            unreadableLocks: 0
        };
        try {
            // Filesystem cleanup is allowed ONLY for exact already-finalized
            // records. No timeout/restart releases signed unknown transfers.
            const locks = this._gate.recoverConfirmedLocks();
            report.recoveredSettledLocks = locks.released;
            report.unreadableLocks = locks.failed;
            if (locks.failed > 0) {
                this._logger?.warn?.(
                    "Room Wallet signing locks need manual reconciliation"
                    + " | unreadable=" + locks.failed
                );
            }
            const pending = this._journal.listUnresolvedSignedIntents();
            report.pending = pending.length;
            const at = this._now();
            const due = pending
                .filter(item => (this._attempts.get(item.recordId)?.nextAt ?? 0) <= at)
                .sort((a, b) => {
                    const delta = (this._attempts.get(a.recordId)?.nextAt ?? 0)
                        - (this._attempts.get(b.recordId)?.nextAt ?? 0);
                    return delta || a.recordId.localeCompare(b.recordId);
                }).slice(0, this._maxIntents);

            for (const item of due) {
                if (this._stopped) break;
                report.attempted++;
                const current = this._attempts.get(item.recordId);
                try {
                    const record = item.payload;
                    if (!Number.isSafeInteger(record.signedValidUntil)
                        || record.signedValidUntil < 360
                        || typeof record.signedExternalMessageHash !== "string") {
                        throw new Error("OUTBOUND_WORKER_SIGNED_TIME_UNAVAILABLE");
                    }
                    // Signing TTL <=300s; start conservatively 60s earlier.
                    const history = await this._scanner({
                        roomWallet: record.roomWallet,
                        cutoffUnixSeconds: record.signedValidUntil - 360,
                        requestBudget: this._requestBudget,
                        fetchImpl: this._fetchImpl
                    });
                    if (this._stopped) break;
                    if (history.historyComplete !== true) {
                        throw new Error("OUTBOUND_WORKER_HISTORY_INCOMPLETE");
                    }
                    const result = await this._finalizer.reconcile({
                        intentId: item.recordId,
                        tonapiTransactions: history.tonapiTransactions,
                        toncenterTransactions: history.toncenterTransactions
                    });
                    if (result.state === "CHAIN_CONFIRMED") {
                        report.confirmed++;
                        this._attempts.delete(item.recordId);
                    } else {
                        report.unknown++;
                        this._attempts.set(item.recordId, {
                            failures: 0, nextAt: this._now() + this._unknownRetry
                        });
                    }
                } catch (error) {
                    if (this._stopped) break;
                    report.failed++;
                    const failures = Math.min(4, (current?.failures ?? 0) + 1);
                    this._attempts.set(item.recordId, {
                        failures,
                        nextAt: this._now()
                            + Math.min(300_000, this._failureRetry * 2 ** (failures - 1))
                    });
                    // No successful send is inferred from a failed HTTP read,
                    // and no missing receipt authorizes re-broadcast.
                    this._logger?.warn?.(
                        "Room Wallet outgoing confirmation still pending"
                        + " | intent=" + item.recordId
                        + " | reason=" + (error?.code ?? error?.name ?? "unknown")
                    );
                }
            }
            return Object.freeze(report);
        } finally {
            this._inFlight = false;
        }
    }
}
