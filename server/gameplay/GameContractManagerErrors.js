/**
 * T2.4 — GameContractManager typed domain errors.
 */

export class GameContractManagerError extends Error {

    constructor(message, code = "GAME_CONTRACT_MANAGER_ERROR", details = null) {

        super(message);

        this.name = "GameContractManagerError";

        this.code = code;

        this.details = details ?? null;

    }

}

export class ContractAlreadyExistsError extends GameContractManagerError {

    constructor(roomId, gameId = null) {

        super(
            `Game contract already exists | roomId=${roomId}`,
            "CONTRACT_ALREADY_EXISTS",
            { roomId, gameId }
        );

        this.name = "ContractAlreadyExistsError";

    }

}

export class ContractNotFoundError extends GameContractManagerError {

    constructor(identifier) {

        super(
            `Game contract not found | id=${identifier}`,
            "CONTRACT_NOT_FOUND",
            { identifier }
        );

        this.name = "ContractNotFoundError";

    }

}

export class InvalidContractStateTransitionError extends GameContractManagerError {

    constructor(contractId, fromStatus, toStatus) {

        super(
            `Invalid contract state transition | contractId=${contractId} | `
                + `from=${fromStatus} | to=${toStatus}`,
            "INVALID_CONTRACT_STATE_TRANSITION",
            { contractId, fromStatus, toStatus }
        );

        this.name = "InvalidContractStateTransitionError";

    }

}

export class DeploymentFailedError extends GameContractManagerError {

    constructor(contractId, reason = "deploy_failed") {

        super(
            `Contract deployment failed | contractId=${contractId} | reason=${reason}`,
            "DEPLOYMENT_FAILED",
            { contractId, reason }
        );

        this.name = "DeploymentFailedError";

    }

}

export class PersistenceFailureError extends GameContractManagerError {

    constructor(message, details = null) {

        super(message, "PERSISTENCE_FAILURE", details);

        this.name = "PersistenceFailureError";

    }

}

export class ContractRecoveryError extends GameContractManagerError {

    constructor(message, details = null) {

        super(message, "CONTRACT_RECOVERY_ERROR", details);

        this.name = "ContractRecoveryError";

    }

}

export class ContractStateMismatchError extends GameContractManagerError {

    constructor(contractId, expected, actual) {

        super(
            `Contract state mismatch | contractId=${contractId}`,
            "CONTRACT_STATE_MISMATCH",
            { contractId, expected, actual }
        );

        this.name = "ContractStateMismatchError";

    }

}

export class ContractOperationInProgressError extends GameContractManagerError {

    constructor(contractId, operation) {

        super(
            `Contract operation already in progress | contractId=${contractId} | `
                + `operation=${operation}`,
            "CONTRACT_OPERATION_IN_PROGRESS",
            { contractId, operation }
        );

        this.name = "ContractOperationInProgressError";

    }

}
