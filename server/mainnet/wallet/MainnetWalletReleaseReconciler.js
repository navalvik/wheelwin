/** Bounded release worker for destroyed Mainnet rooms with settled obligations. */
export class MainnetWalletReleaseReconciler {
    constructor({ walletPool, financialLedger, roomManager, snapshotDir,
        nowProvider = Date.now, maxPerPass = 3, logger = null } = {}) {
        if (walletPool?.network !== "mainnet"
            || typeof walletPool.releaseForMainnetOutcome !== "function"
            || typeof walletPool.getReservationForRoom !== "function"
            || typeof walletPool.persistSnapshot !== "function"
            || financialLedger?.network !== "mainnet" || financialLedger?.globalId !== -239
            || typeof financialLedger.listClosedRooms !== "function"
            || typeof financialLedger.listPayouts !== "function"
            || typeof financialLedger.getOutcome !== "function"
            || typeof financialLedger.countWalletBlockingObligations !== "function"
            || typeof roomManager?.getRoom !== "function"
            || typeof snapshotDir !== "string" || !snapshotDir
            || typeof nowProvider !== "function"
            || !Number.isSafeInteger(maxPerPass) || maxPerPass < 1 || maxPerPass > 10) {
            throw new Error("MAINNET_WALLET_RELEASE_RECONCILER_CONFIG_INVALID");
        }
        Object.assign(this, { walletPool, financialLedger, roomManager, snapshotDir,
            nowProvider, maxPerPass, logger });
        this.running = false;
        this.stopped = false;
        this.cursor = 0;
    }

    stop() { this.stopped = true; }

    async runPass() {
        if (this.stopped) return Object.freeze({ status: "STOPPED", checked: 0, released: 0, blocked: 0, errors: 0 });
        if (this.running) return Object.freeze({ status: "ALREADY_RUNNING", checked: 0, released: 0, blocked: 0, errors: 0 });
        this.running = true;
        const counts = { status: "COMPLETED", checked: 0, released: 0, blocked: 0, errors: 0 };
        try {
            const candidates = this._closedOutcomeRooms();
            if (!candidates.length) return Object.freeze({ ...counts, status: "NO_CLOSED_ROOMS" });
            const start = this.cursor % candidates.length;
            const count = Math.min(this.maxPerPass, candidates.length);
            for (let offset = 0; offset < count; offset++) {
                if (this.stopped) break;
                const { roomId, outcome } = candidates[(start + offset) % candidates.length];
                counts.checked++;
                try {
                    const room = this.roomManager.getRoom(roomId);
                    if (room !== null) {
                        counts.blocked++;
                        continue;
                    }
                    if (this.financialLedger.getOutcome(roomId)?.kind !== outcome.kind) {
                        counts.blocked++;
                        continue;
                    }
                    const reservation = this.walletPool.getReservationForRoom(roomId);
                    if (!reservation) continue;
                    const blockers = this.financialLedger.countWalletBlockingObligations(roomId);
                    if (!Number.isSafeInteger(blockers) || blockers < 0) {
                        throw new Error("MAINNET_WALLET_FINANCIAL_STATE_UNAVAILABLE");
                    }
                    if (blockers > 0) {
                        counts.blocked++;
                        continue;
                    }
                    const now = this.nowProvider();
                    if (!Number.isSafeInteger(now) || now < 0) {
                        throw new Error("MAINNET_WALLET_RELEASE_TIME_UNAVAILABLE");
                    }
                    const result = this.walletPool.releaseForMainnetOutcome({
                        roomId, financialLedger: this.financialLedger, now
                    });
                    if (result.released) {
                        try {
                            this.walletPool.persistSnapshot(this.snapshotDir);
                        } catch (persistError) {
                            // Keep an unpersisted release unavailable in memory as well.
                            this.walletPool.reserve({ roomId, network: "mainnet",
                                walletId: reservation.walletId, now });
                            throw persistError;
                        }
                        counts.released++;
                        this.logger?.info?.("MAINNET_ROOM_WALLET_RELEASED"
                            + ` | roomId=${roomId} | walletId=${result.walletId}`);
                    }
                } catch (error) {
                    counts.errors++;
                    this.logger?.warn?.("MAINNET_ROOM_WALLET_RELEASE_PENDING"
                        + ` | roomId=${roomId} | code=${error?.code ?? error?.message ?? "RELEASE_CHECK_FAILED"}`);
                }
            }
            this.cursor = (start + count) % candidates.length;
            return Object.freeze({ ...counts });
        } finally {
            this.running = false;
        }
    }

    _closedOutcomeRooms() {
        const byRoom = new Map();
        for (const room of this.financialLedger.listClosedRooms()) {
            if (room?.kind === "REFUND" && typeof room.roomId === "string" && room.roomId) {
                byRoom.set(room.roomId, { roomId: room.roomId, outcome: room });
            }
        }
        for (const payout of this.financialLedger.listPayouts()) {
            if (!payout || typeof payout.roomId !== "string" || !payout.roomId) continue;
            const outcome = this.financialLedger.getOutcome(payout.roomId);
            if (outcome?.kind === "PAYOUT") byRoom.set(payout.roomId, { roomId: payout.roomId, outcome });
        }
        return [...byRoom.values()];
    }
}
