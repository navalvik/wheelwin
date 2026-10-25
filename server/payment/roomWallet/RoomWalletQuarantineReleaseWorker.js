/**
 * Bounded, opt-in automatic removal of VERIFIED financial quarantines.
 *
 * Pre-Page5 and post-Page5 sessions use the same proof gate:
 * independent scanner histories + latest wallet-account head from both
 * indexers; no unresolved refund/settlement/sweep; 15-minute quiet period;
 * atomic durable closure before RoomManager may reallocate a wallet.
 *
 * At most two quarantines per sweep. Cannot sign or transfer tokens.
 * Uses an in-process per-wallet scanner mutex with the expired-room worker;
 * NEVER bypasses RoomWalletSingleWriterGate for outbound transfers.
 */
export class RoomWalletQuarantineReleaseWorker {
    constructor({
        repository,
        releaseGuard,
        scanMutex,
        logger = null,
        now = () => Date.now(),
        maxWalletsPerSweep = 2,
        intervalMs = 30_000,
        successRetryMs = 90_000,
        failureRetryMs = 45_000
    } = {}) {
        if (typeof repository?.listAllocationBlocks !== "function"
            || typeof releaseGuard?.tryRelease !== "function"
            || typeof scanMutex?.runExclusive !== "function"
            || typeof now !== "function"
            || !Number.isInteger(maxWalletsPerSweep)
            || maxWalletsPerSweep < 1 || maxWalletsPerSweep > 4
            || !Number.isInteger(intervalMs) || intervalMs < 1000
            || !Number.isInteger(successRetryMs) || successRetryMs < 1000
            || !Number.isInteger(failureRetryMs) || failureRetryMs < 1000) {
            throw new TypeError("Room Wallet quarantine release worker dependencies invalid");
        }
        this._repository = repository;
        this._guard = releaseGuard;
        this._mutex = scanMutex;
        this._logger = logger;
        this._now = now;
        this._maxWallets = maxWalletsPerSweep;
        this._interval = intervalMs;
        this._successRetry = successRetryMs;
        this._failureRetry = failureRetryMs;
        this._backoff = new Map();
        this._stopped = false;
        this._running = false;
        this._timer = null;
    }

    start() {
        if (this._stopped || this._timer) return;
        this._timer = setInterval(() => {
            void this.runOnce().catch(error => this._logger?.error?.(
                "Wallet closure sweep failed | code="
                + (error?.code ?? error?.name ?? "unknown")
            ));
        }, this._interval);
        this._timer.unref?.();
    }

    shutdown() {
        this._stopped = true;
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
    }

    async runOnce() {
        if (this._stopped) return Object.freeze({ skipped: "stopped", attempted: 0 });
        if (this._running) return Object.freeze({ skipped: "in_flight", attempted: 0 });
        this._running = true;
        const report = {
            attempted: 0, closed: 0, blocked: 0, pending: 0, skipped: 0
        };
        try {
            const holds = this._repository.listAllocationBlocks();
            report.pending = holds.length;
            const now = this._now();
            const due = holds.filter(item =>
                (this._backoff.get(item.recordId)?.nextAt ?? 0) <= now
            ).sort((a, b) =>
                (this._backoff.get(a.recordId)?.nextAt ?? 0)
                - (this._backoff.get(b.recordId)?.nextAt ?? 0)
                || a.recordId.localeCompare(b.recordId)
            ).slice(0, this._maxWallets);
            for (const item of due) {
                if (this._stopped) break;
                report.attempted++;
                const prev = this._backoff.get(item.recordId);
                try {
                    const result = await this._mutex.runExclusive(
                        Number(item.payload.roomNumber),
                        async () => {
                            // Re-read after acquiring the shared scanner
                            // mutex: expired worker may have closed it while
                            // we were waiting.
                            const stillHeld = this._repository
                                .listAllocationBlocks()
                                .some(x => x.recordId === item.recordId);
                            if (!stillHeld) return { skipped: true };
                            return this._guard.tryRelease({ recordId: item.recordId });
                        }
                    );
                    if (this._stopped) break;
                    if (result.skipped) report.skipped++;
                    else if (result.changed) report.closed++;
                    this._backoff.delete(item.recordId);
                } catch (error) {
                    if (this._stopped) break;
                    report.blocked++;
                    const attempts = Math.min(4, (prev?.attempts ?? 0) + 1);
                    this._backoff.set(item.recordId, {
                        attempts,
                        nextAt: this._now() + Math.min(
                            300_000,
                            (error?.code === "QUARANTINE_RELEASE_QUIET_WINDOW_NOT_ELAPSED"
                                ? this._successRetry
                                : this._failureRetry * 2 ** (attempts - 1))
                        )
                    });
                    // Do not log PII or blockchain wallet keys; only codes.
                    this._logger?.warn?.(
                        "Room Wallet still quarantined"
                        + " | walletNumber=" + item.payload.roomNumber
                        + " | code=" + (error?.code ?? error?.name ?? "unknown")
                    );
                }
            }
            return Object.freeze(report);
        } finally {
            this._running = false;
        }
    }
}
