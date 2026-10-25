/**
 * Restart-safe, read-only reconciliation worker for PRE-Page5 rooms.
 *
 * It scans quarantined Room Wallets independently of active rooms and stores
 * newly proven refund debts. Wallet quarantine remains in force after a
 * successful scan, even when no deposits were observed: neither indexer
 * freshness nor outgoing refund finality can be inferred from account
 * history alone.
 *
 * The worker never signs transfers, clears quarantines or releases wallets.
 * At most two wallets per sweep by default; each network request passes the
 * same shared provider budget as live payment fallback monitoring.
 */
import { Address } from "@ton/core";
import { buildExpiredRoomWalletRefundObligations } from "./RoomWalletExpiredRefundObligations.js";
import { fetchExpiredRoomWalletHistory } from "./RoomWalletExpiredChainScanner.js";

function sameAddress(a, b) {
    try {
        return Address.parse(a).equals(Address.parse(b));
    } catch {
        return false;
    }
}

export class RoomWalletExpiredReconciliationWorker {
    constructor({
        repository,
        financialPersistence,
        scanMutex = null,
        logger = null,
        scanner = fetchExpiredRoomWalletHistory,
        requestBudget = null,
        fetchImpl = globalThis.fetch,
        now = () => Date.now(),
        maxWalletsPerSweep = 2,
        sweepIntervalMs = 20_000,
        successRetryMs = 120_000,
        failureRetryMs = 30_000
    } = {}) {
        if (typeof repository?.listOpenQuarantines !== "function"
            || typeof repository?.persistReconciliation !== "function"
            || typeof financialPersistence?.loadPaymentSession !== "function"
            || (scanMutex != null && typeof scanMutex?.runExclusive !== "function")
            || typeof scanner !== "function" || typeof now !== "function"
            || typeof fetchImpl !== "function"
            || (requestBudget !== null && typeof requestBudget?.schedule !== "function")
            || !Number.isInteger(maxWalletsPerSweep)
            || maxWalletsPerSweep < 1 || maxWalletsPerSweep > 4
            || !Number.isInteger(sweepIntervalMs) || sweepIntervalMs < 1000
            || !Number.isInteger(successRetryMs) || successRetryMs < 1000
            || !Number.isInteger(failureRetryMs) || failureRetryMs < 1000) {
            throw new TypeError("Invalid expired Room Wallet reconciliation worker dependencies");
        }

        this._repository = repository;
        this._financialPersistence = financialPersistence;
        this._scanMutex = scanMutex;
        this._logger = logger;
        this._scanner = scanner;
        this._requestBudget = requestBudget;
        this._fetchImpl = fetchImpl;
        this._now = now;
        this._maxWallets = maxWalletsPerSweep;
        this._sweepIntervalMs = sweepIntervalMs;
        this._successRetryMs = successRetryMs;
        this._failureRetryMs = failureRetryMs;
        this._attempts = new Map();
        this._stopped = false;
        this._inFlight = false;
        this._timer = null;
    }

    start() {
        if (this._timer || this._stopped) return;
        this._timer = setInterval(() => {
            void this.runOnce().catch(error => {
                this._logger?.error?.(
                    "Room Wallet expired reconciliation sweep failed"
                    + " | code=" + (error?.code ?? error?.name ?? "unknown")
                );
            });
        }, this._sweepIntervalMs);
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
        const results = {
            attempted: 0,
            persisted: 0,
            newObligations: 0,
            failures: 0,
            pendingQuarantines: 0
        };
        try {
            const quarantines = this._repository.listOpenQuarantines();
            results.pendingQuarantines = quarantines.length;
            const at = this._now();
            const due = quarantines
                .filter(q => (this._attempts.get(q.recordId)?.nextAt ?? 0) <= at)
                .sort((a, b) => (
                    (this._attempts.get(a.recordId)?.nextAt ?? 0)
                    - (this._attempts.get(b.recordId)?.nextAt ?? 0)
                ) || a.recordId.localeCompare(b.recordId))
                .slice(0, this._maxWallets);

            for (const item of due) {
                if (this._stopped) break;
                results.attempted++;
                const previous = this._attempts.get(item.recordId);
                try {
                    const result = this._scanMutex
                        ? await this._scanMutex.runExclusive(
                            Number(item.payload.roomNumber),
                            () => this._reconcileOne(item))
                        : await this._reconcileOne(item);
                    if (this._stopped) break;
                    results.persisted++;
                    results.newObligations += result.obligationsCreated;
                    this._attempts.set(item.recordId, {
                        errors: 0,
                        nextAt: this._now() + this._successRetryMs
                    });
                } catch (error) {
                    if (this._stopped) break;
                    results.failures++;
                    const errors = Math.min(4, (previous?.errors ?? 0) + 1);
                    this._attempts.set(item.recordId, {
                        errors,
                        nextAt: this._now()
                            + Math.min(300_000, this._failureRetryMs * 2 ** (errors - 1))
                    });
                    this._logger?.warn?.(
                        "Room Wallet expired reconciliation pending"
                        + " | room=" + item.payload?.roomId
                        + " | walletNumber=" + item.payload?.roomNumber
                        + " | reason=" + (error?.code ?? error?.name ?? "unknown")
                    );
                }
            }
            return Object.freeze(results);
        } finally {
            this._inFlight = false;
        }
    }

    async _reconcileOne(quarantine) {
        const marker = quarantine?.payload;
        if (marker?.kind !== "ROOM_WALLET_REFUND_QUARANTINE"
            || marker?.network !== "testnet"
            || marker?.state !== "RECONCILIATION_REQUIRED"
            || !marker?.paymentSessionId) {
            throw new Error("QUARANTINE_IDENTITY_INVALID");
        }
        const record = this._financialPersistence.loadPaymentSession(marker.paymentSessionId);
        const session = record?.payload;
        if (!session || session.network !== "testnet"
            || session.roomId !== marker.roomId
            || session.paymentSessionId !== marker.paymentSessionId
            || session.gameId !== marker.gameId
            || Number(session.roomNumber) !== Number(marker.roomNumber)
            || !sameAddress(session.roomWalletAddress, marker.roomWallet)
            || !Array.isArray(session.participants) || session.participants.length !== 3) {
            throw new Error("RECOVERED_PAYMENT_SESSION_IDENTITY_MISMATCH");
        }
        if (!Number.isSafeInteger(Number(session.createdAt))) {
            throw new Error("RECOVERED_PAYMENT_SESSION_START_MISSING");
        }

        const history = await this._scanner({
            address: marker.roomWallet,
            sessionStartMs: Number(session.createdAt),
            fetchImpl: this._fetchImpl,
            requestBudget: this._requestBudget
        });
        if (this._stopped) {
            throw new Error("RECONCILIATION_SHUTDOWN");
        }
        if (history.historyComplete !== true) {
            throw new Error("RECONCILIATION_HISTORY_INCOMPLETE");
        }

        const plan = buildExpiredRoomWalletRefundObligations({
            session,
            chainEvidence: history,
            // The quarantine marker was durably written by the synchronous
            // pre-Page5 destruction guard after checking gameplay ownership.
            gameReachedPage5: false,
            historyComplete: history.historyComplete
        });
        if (!plan.quarantineRequired) {
            // Persisting a complete no-deposit scan is a later release step.
            // It still does NOT release a quarantined wallet in this worker.
            return { obligationsCreated: 0, quarantined: true };
        }
        const result = this._repository.persistReconciliation({
            plan,
            session,
            gameReachedPage5: false
        });
        return result;
    }
}
