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
    DEPLOY_FAILED: "DEPLOY_FAILED",
    // P6.8B — post-winner contract settlement.
    SETTLEMENT_PREPARING: "SETTLEMENT_PREPARING",
    SETTLEMENT_SUBMITTED: "SETTLEMENT_SUBMITTED",
    SETTLEMENT_PENDING: "SETTLEMENT_PENDING",
    SETTLEMENT_CONFIRMED: "SETTLEMENT_CONFIRMED",
    SETTLEMENT_COMPLETED: "SETTLEMENT_COMPLETED",
    SETTLEMENT_FAILED: "SETTLEMENT_FAILED",
    // T2.4 — terminal archive after completion or failure.
    ARCHIVED: "ARCHIVED"
});

/**
 * T2.4 conceptual domain aliases mapped onto GAME_CONTRACT_STATUS.
 * Existing statuses remain authoritative for settlement / start gate.
 */
export const GAME_CONTRACT_DOMAIN_STATE = Object.freeze({
    CREATED: GAME_CONTRACT_STATUS.CREATED,
    DEPLOYING: GAME_CONTRACT_STATUS.DEPLOYING,
    DEPLOYED: GAME_CONTRACT_STATUS.DEPLOYED,
    WAITING_PAYMENTS: GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS,
    PAYMENTS_COMPLETED: GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE,
    ACTIVE: GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE,
    WINNER_PENDING: GAME_CONTRACT_STATUS.SETTLEMENT_PREPARING,
    SETTLEMENT_PENDING: GAME_CONTRACT_STATUS.SETTLEMENT_PENDING,
    COMPLETED: GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED,
    FAILED: GAME_CONTRACT_STATUS.DEPLOY_FAILED,
    ARCHIVED: GAME_CONTRACT_STATUS.ARCHIVED
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
    [GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE]: Object.freeze([
        GAME_CONTRACT_STATUS.SETTLEMENT_PREPARING
    ]),
    [GAME_CONTRACT_STATUS.SETTLEMENT_PREPARING]: Object.freeze([
        GAME_CONTRACT_STATUS.SETTLEMENT_SUBMITTED,
        GAME_CONTRACT_STATUS.SETTLEMENT_FAILED
    ]),
    [GAME_CONTRACT_STATUS.SETTLEMENT_SUBMITTED]: Object.freeze([
        GAME_CONTRACT_STATUS.SETTLEMENT_PENDING,
        GAME_CONTRACT_STATUS.SETTLEMENT_FAILED
    ]),
    [GAME_CONTRACT_STATUS.SETTLEMENT_PENDING]: Object.freeze([
        GAME_CONTRACT_STATUS.SETTLEMENT_CONFIRMED,
        GAME_CONTRACT_STATUS.SETTLEMENT_FAILED
    ]),
    [GAME_CONTRACT_STATUS.SETTLEMENT_CONFIRMED]: Object.freeze([
        GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED
    ]),
    [GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED]: Object.freeze([
        GAME_CONTRACT_STATUS.ARCHIVED
    ]),
    [GAME_CONTRACT_STATUS.SETTLEMENT_FAILED]: Object.freeze([
        GAME_CONTRACT_STATUS.ARCHIVED
    ]),
    [GAME_CONTRACT_STATUS.DEPLOY_FAILED]: Object.freeze([
        GAME_CONTRACT_STATUS.ARCHIVED
    ]),
    [GAME_CONTRACT_STATUS.ARCHIVED]: Object.freeze([])
});

/**
 * P6.4/P6.5/T2.4 — Authoritative Game Smart Contract metadata.
 *
 * One contract per game. Snapshot is immutable after create.
 * P6.5 adds stub deployment + contractAddress (no live chain required).
 * T2.4 adds network, correlation, archive, and persistence metadata.
 */
export class GameContract {

    constructor({
        contractId,
        gameId,
        roomId,
        status = GAME_CONTRACT_STATUS.NOT_CREATED,
        snapshot = null,
        createdAt = null,
        updatedAt = null,
        contractAddress = null,
        deploymentStatus = null,
        deployedAt = null,
        deploymentTxId = null,
        deployError = null,
        paymentsCompletedAt = null,
        tonNetwork = null,
        correlationId = null,
        snapshotHash = null,
        version = 1,
        gameStartedAt = null,
        archivedAt = null,
        failureReason = null
    }) {

        this.contractId = contractId;

        this.gameId = gameId;

        this.roomId = roomId;

        this.status = status;

        this.snapshot = snapshot;

        this.createdAt = createdAt;

        this.updatedAt = updatedAt ?? createdAt;

        this.contractAddress = contractAddress;

        this.deploymentStatus = deploymentStatus;

        this.deployedAt = deployedAt;

        this.deploymentTxId = deploymentTxId;

        this.deployError = deployError;

        this.paymentsCompletedAt = paymentsCompletedAt;

        this.tonNetwork = tonNetwork;

        this.correlationId = correlationId;

        this.snapshotHash = snapshotHash;

        this.version = version ?? 1;

        this.gameStartedAt = gameStartedAt;

        this.archivedAt = archivedAt;

        this.failureReason = failureReason;

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

        this.updatedAt = Date.now();

        if (
            nextStatus === GAME_CONTRACT_STATUS.CREATED
            && this.createdAt == null
        ) {

            this.createdAt = this.updatedAt;

        }

        if (nextStatus === GAME_CONTRACT_STATUS.DEPLOYING) {

            this.deploymentStatus = "DEPLOYING";

            this.deployError = null;

            this.failureReason = null;

        }

        if (nextStatus === GAME_CONTRACT_STATUS.DEPLOY_FAILED) {

            this.deploymentStatus = "DEPLOY_FAILED";

        }

        if (nextStatus === GAME_CONTRACT_STATUS.DEPLOYED) {

            this.deploymentStatus = "DEPLOYED";

        }

        if (
            nextStatus === GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE
            && this.paymentsCompletedAt == null
        ) {

            this.paymentsCompletedAt = this.updatedAt;

        }

        if (nextStatus === GAME_CONTRACT_STATUS.ARCHIVED && this.archivedAt == null) {

            this.archivedAt = this.updatedAt;

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

        this.failureReason = null;

        this.updatedAt = Date.now();

    }

    applyDeploymentFailure(reason = "deploy_failed") {

        this.deploymentStatus = "DEPLOY_FAILED";

        this.deployError = reason;

        this.failureReason = reason;

        this.updatedAt = Date.now();

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
            updatedAt: this.updatedAt,
            contractAddress: this.contractAddress,
            deploymentStatus: this.deploymentStatus,
            deployedAt: this.deployedAt,
            paymentsCompletedAt: this.paymentsCompletedAt,
            deployError: this.deployError,
            tonNetwork: this.tonNetwork,
            correlationId: this.correlationId,
            snapshotHash: this.snapshotHash,
            version: this.version,
            gameStartedAt: this.gameStartedAt,
            archivedAt: this.archivedAt,
            failureReason: this.failureReason
        });

    }

    toSnapshot() {

        return Object.freeze({
            contractId: this.contractId,
            gameId: this.gameId,
            roomId: this.roomId,
            status: this.status,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            contractAddress: this.contractAddress,
            deploymentStatus: this.deploymentStatus,
            deployedAt: this.deployedAt,
            deploymentTxId: this.deploymentTxId,
            paymentsCompletedAt: this.paymentsCompletedAt,
            deployError: this.deployError,
            tonNetwork: this.tonNetwork,
            correlationId: this.correlationId,
            snapshotHash: this.snapshotHash,
            version: this.version,
            gameStartedAt: this.gameStartedAt,
            archivedAt: this.archivedAt,
            failureReason: this.failureReason,
            snapshot: this.snapshot
        });

    }

    /**
     * Developer dashboard / monitoring projection.
     */
    toDashboardSnapshot() {

        return Object.freeze({
            contractId: this.contractId,
            gameId: this.gameId,
            roomId: this.roomId,
            address: this.contractAddress,
            network: this.tonNetwork,
            state: this.status,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            deploymentStatus: this.deploymentStatus,
            deploymentTxId: this.deploymentTxId,
            failureReason: this.failureReason ?? this.deployError,
            snapshotHash: this.snapshotHash,
            version: this.version,
            correlationId: this.correlationId,
            archivedAt: this.archivedAt
        });

    }

}

export { GAME_CONTRACT_TRANSITIONS };
