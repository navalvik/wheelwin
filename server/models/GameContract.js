export const GAME_CONTRACT_STATUS = Object.freeze({
    NOT_CREATED: "NOT_CREATED",
    CREATING: "CREATING",
    CREATED: "CREATED",
    AWAITING_PAYMENTS: "AWAITING_PAYMENTS",
    READY_FOR_BLOCKCHAIN: "READY_FOR_BLOCKCHAIN"
});

const GAME_CONTRACT_TRANSITIONS = Object.freeze({
    [GAME_CONTRACT_STATUS.NOT_CREATED]: Object.freeze([
        GAME_CONTRACT_STATUS.CREATING
    ]),
    [GAME_CONTRACT_STATUS.CREATING]: Object.freeze([
        GAME_CONTRACT_STATUS.CREATED
    ]),
    [GAME_CONTRACT_STATUS.CREATED]: Object.freeze([
        GAME_CONTRACT_STATUS.AWAITING_PAYMENTS
    ]),
    [GAME_CONTRACT_STATUS.AWAITING_PAYMENTS]: Object.freeze([
        GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN
    ]),
    [GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN]: Object.freeze([])
});

/**
 * P6.4 — Authoritative Game Smart Contract metadata (architecture only).
 *
 * One contract per game. Snapshot is immutable after create.
 * No blockchain deployment in this stage.
 */
export class GameContract {

    constructor({
        contractId,
        gameId,
        roomId,
        status = GAME_CONTRACT_STATUS.NOT_CREATED,
        snapshot = null,
        createdAt = null
    }) {

        this.contractId = contractId;

        this.gameId = gameId;

        this.roomId = roomId;

        this.status = status;

        this.snapshot = snapshot;

        this.createdAt = createdAt;

    }

    canTransitionTo(nextStatus) {

        const allowed = GAME_CONTRACT_TRANSITIONS[this.status] ?? [];

        return allowed.includes(nextStatus);

    }

    transitionTo(nextStatus) {

        if (!this.canTransitionTo(nextStatus)) {

            return false;

        }

        this.status = nextStatus;

        if (
            nextStatus === GAME_CONTRACT_STATUS.CREATED
            && this.createdAt == null
        ) {

            this.createdAt = Date.now();

        }

        return true;

    }

    /**
     * Client-facing payload: identifier + state only (no snapshot body).
     */
    toClientSnapshot() {

        return Object.freeze({
            contractId: this.contractId,
            gameId: this.gameId,
            roomId: this.roomId,
            status: this.status,
            createdAt: this.createdAt
        });

    }

    /**
     * Server debug / internal view including immutable snapshot.
     */
    toSnapshot() {

        return Object.freeze({
            contractId: this.contractId,
            gameId: this.gameId,
            roomId: this.roomId,
            status: this.status,
            createdAt: this.createdAt,
            snapshot: this.snapshot
        });

    }

}

export { GAME_CONTRACT_TRANSITIONS };
