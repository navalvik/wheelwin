export const GAME_CONTRACT_STATUS = Object.freeze({
    NOT_CREATED: "NOT_CREATED",
    CREATING: "CREATING",
    CREATED: "CREATED",
    AWAITING_PAYMENTS: "AWAITING_PAYMENTS",
    READY_FOR_BLOCKCHAIN: "READY_FOR_BLOCKCHAIN",
    // P6.5 — deployment & on-chain payment collection.
    DEPLOYING: "DEPLOYING",
    DEPLOYED: "DEPLOYED",
    AWAITING_PLAYER_PAYMENTS: "AWAITING_PLAYER_PAYMENTS",
    PAYMENTS_COMPLETE: "PAYMENTS_COMPLETE",
    DEPLOY_FAILED: "DEPLOY_FAILED"
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
    [GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN]: Object.freeze([
        GAME_CONTRACT_STATUS.DEPLOYING
    ]),
    [GAME_CONTRACT_STATUS.DEPLOYING]: Object.freeze([
        GAME_CONTRACT_STATUS.DEPLOYED,
        GAME_CONTRACT_STATUS.DEPLOY_FAILED
    ]),
    [GAME_CONTRACT_STATUS.DEPLOYED]: Object.freeze([
        GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS
    ]),
    [GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS]: Object.freeze([
        GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE
    ]),
    [GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE]: Object.freeze([]),
    [GAME_CONTRACT_STATUS.DEPLOY_FAILED]: Object.freeze([])
});

/**
 * P6.4/P6.5 — Authoritative Game Smart Contract metadata.
 *
 * One contract per game. Snapshot is immutable after create.
 * P6.5 adds stub deployment + contractAddress (no live chain required).
 */
export class GameContract {

    constructor({
        contractId,
        gameId,
        roomId,
        status = GAME_CONTRACT_STATUS.NOT_CREATED,
        snapshot = null,
        createdAt = null,
        contractAddress = null,
        deploymentStatus = null,
        deployedAt = null,
        deploymentTxId = null,
        deployError = null
    }) {

        this.contractId = contractId;

        this.gameId = gameId;

        this.roomId = roomId;

        this.status = status;

        this.snapshot = snapshot;

        this.createdAt = createdAt;

        this.contractAddress = contractAddress;

        this.deploymentStatus = deploymentStatus;

        this.deployedAt = deployedAt;

        this.deploymentTxId = deploymentTxId;

        this.deployError = deployError;

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

        if (nextStatus === GAME_CONTRACT_STATUS.DEPLOYING) {

            this.deploymentStatus = "DEPLOYING";

            this.deployError = null;

        }

        if (nextStatus === GAME_CONTRACT_STATUS.DEPLOY_FAILED) {

            this.deploymentStatus = "DEPLOY_FAILED";

        }

        if (nextStatus === GAME_CONTRACT_STATUS.DEPLOYED) {

            this.deploymentStatus = "DEPLOYED";

        }

        return true;

    }

    applyDeploymentSuccess({
        contractAddress,
        deploymentTxId = null,
        deployedAt = Date.now()
    }) {

        this.contractAddress = contractAddress;

        this.deploymentTxId = deploymentTxId;

        this.deployedAt = deployedAt;

        this.deploymentStatus = "DEPLOYED";

        this.deployError = null;

    }

    applyDeploymentFailure(reason = "deploy_failed") {

        this.deploymentStatus = "DEPLOY_FAILED";

        this.deployError = reason;

    }

    /**
     * Client-facing payload: identifier, address, deployment status.
     * Never includes the immutable snapshot body.
     */
    toClientSnapshot() {

        return Object.freeze({
            contractId: this.contractId,
            gameId: this.gameId,
            roomId: this.roomId,
            status: this.status,
            createdAt: this.createdAt,
            contractAddress: this.contractAddress,
            deploymentStatus: this.deploymentStatus,
            deployedAt: this.deployedAt,
            deployError: this.deployError
        });

    }

    toSnapshot() {

        return Object.freeze({
            contractId: this.contractId,
            gameId: this.gameId,
            roomId: this.roomId,
            status: this.status,
            createdAt: this.createdAt,
            contractAddress: this.contractAddress,
            deploymentStatus: this.deploymentStatus,
            deployedAt: this.deployedAt,
            deploymentTxId: this.deploymentTxId,
            deployError: this.deployError,
            snapshot: this.snapshot
        });

    }

}

export { GAME_CONTRACT_TRANSITIONS };
