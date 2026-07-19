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

const SMART_CONTRACT_TRANSITIONS = Object.freeze({
    [ENTRY_SMART_CONTRACT_STATUS.WAITING]: Object.freeze([
        ENTRY_SMART_CONTRACT_STATUS.CREATING
    ]),
    [ENTRY_SMART_CONTRACT_STATUS.CREATING]: Object.freeze([
        ENTRY_SMART_CONTRACT_STATUS.CREATED
    ]),
    [ENTRY_SMART_CONTRACT_STATUS.CREATED]: Object.freeze([]),
    [ENTRY_SMART_CONTRACT_STATUS.FAILED]: Object.freeze([])
});

/**
 * C5.8C/D — Authoritative Entry Payment Session (Page4).
 *
 * One session per room. Separate from winner-settlement PaymentEngine.
 * Immutable snapshots; lifecycle advances via with* replacements.
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

    areAllPlayersPaid() {

        return this.players.length > 0
            && this.players.every(
                (player) => player.paymentStatus === ENTRY_PAYMENT_STATUS.PAID
            );

    }

    /**
     * waiting → paid for one player. Idempotent / no-op otherwise.
     */
    withPlayerPaid(playerId) {

        if (!playerId) {

            return this;

        }

        const index = this.players.findIndex(
            (player) => player.playerId === playerId
        );

        if (index < 0) {

            return this;

        }

        const current = this.players[index];

        if (current.paymentStatus === ENTRY_PAYMENT_STATUS.PAID) {

            return this;

        }

        if (current.paymentStatus !== ENTRY_PAYMENT_STATUS.WAITING) {

            return this;

        }

        const players = this.players.map((player, playerIndex) => {

            if (playerIndex !== index) {

                return {
                    playerId: player.playerId,
                    wallet: player.wallet,
                    paymentStatus: player.paymentStatus
                };

            }

            return {
                playerId: player.playerId,
                wallet: player.wallet,
                paymentStatus: ENTRY_PAYMENT_STATUS.PAID
            };

        });

        return new EntryPaymentSession({
            roomId: this.roomId,
            createdAt: this.createdAt,
            players,
            smartContractStatus: this.smartContractStatus
        });

    }

    /**
     * Smart contract: waiting → creating → created only.
     */
    withSmartContractStatus(nextStatus) {

        if (!nextStatus || nextStatus === this.smartContractStatus) {

            return this;

        }

        const allowed = SMART_CONTRACT_TRANSITIONS[this.smartContractStatus]
            ?? [];

        if (!allowed.includes(nextStatus)) {

            return this;

        }

        return new EntryPaymentSession({
            roomId: this.roomId,
            createdAt: this.createdAt,
            players: this.players.map((player) => ({
                playerId: player.playerId,
                wallet: player.wallet,
                paymentStatus: player.paymentStatus
            })),
            smartContractStatus: nextStatus
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
