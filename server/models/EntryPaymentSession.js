export const ENTRY_PAYMENT_STATUS = Object.freeze({
    WAITING: "waiting",
    PAID: "paid",
    FAILED: "failed",
    CANCELLED: "cancelled"
});

export const ENTRY_SMART_CONTRACT_STATUS = Object.freeze({
    WAITING: "waiting",
    CREATING: "creating",
    CREATED: "created",
    FAILED: "failed"
});

/**
 * C5.8C — Authoritative Entry Payment Session (Page4).
 *
 * One session per room. Separate from winner-settlement PaymentEngine.
 * Does not perform blockchain / Telegram Wallet / smart-contract calls.
 */
export class EntryPaymentSession {

    constructor({
        roomId,
        createdAt = Date.now(),
        players = [],
        smartContractStatus = ENTRY_SMART_CONTRACT_STATUS.WAITING
    } = {}) {

        if (!roomId) {

            throw new Error("EntryPaymentSession requires roomId");

        }

        this.roomId = roomId;

        this.createdAt = createdAt;

        this.players = players.map((player) => Object.freeze({
            playerId: player.playerId,
            wallet: player.wallet ?? null,
            paymentStatus: player.paymentStatus
                ?? ENTRY_PAYMENT_STATUS.WAITING
        }));

        this.smartContractStatus = smartContractStatus;

        Object.freeze(this.players);

        Object.freeze(this);

    }

    /**
     * @param {string} roomId
     * @param {Array<{ playerId: string, wallet?: string|null }>} roster
     */
    static createInitial(roomId, roster = []) {

        const players = roster.map((entry) => ({
            playerId: entry.playerId,
            wallet: entry.wallet ?? null,
            paymentStatus: ENTRY_PAYMENT_STATUS.WAITING
        }));

        return new EntryPaymentSession({
            roomId,
            createdAt: Date.now(),
            players,
            smartContractStatus: ENTRY_SMART_CONTRACT_STATUS.WAITING
        });

    }

    toSnapshot() {

        return {
            roomId: this.roomId,
            createdAt: this.createdAt,
            players: this.players.map((player) => ({
                playerId: player.playerId,
                wallet: player.wallet,
                paymentStatus: player.paymentStatus
            })),
            smartContractStatus: this.smartContractStatus
        };

    }

}
