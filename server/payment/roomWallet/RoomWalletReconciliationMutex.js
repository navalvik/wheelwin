/**
 * Serialize the read-only expired-history reconciler and quarantine closure
 * for a given room-number on WheelWin's ONE authoritative Railway writer.
 * This is an in-process async queue, NOT a cross-process TON signing lock.
 * The durable RoomWalletSingleWriterGate remains separately authoritative.
 */
export class RoomWalletReconciliationMutex {
    constructor() {
        this._pending = new Map();
    }

    async runExclusive(roomNumber, fn) {
        if (!Number.isInteger(roomNumber) || roomNumber < 1 || roomNumber > 64
            || typeof fn !== "function") {
            throw new TypeError("Invalid Room Wallet reconciliation mutex arguments");
        }
        const previous = this._pending.get(roomNumber) ?? Promise.resolve();
        let release;
        const current = new Promise(resolve => { release = resolve; });
        this._pending.set(roomNumber, current);
        await previous;
        try {
            return await fn();
        } finally {
            release();
            if (this._pending.get(roomNumber) === current) {
                this._pending.delete(roomNumber);
            }
        }
    }
}
