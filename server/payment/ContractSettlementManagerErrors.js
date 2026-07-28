/**
 * T2.8 — ContractSettlementManager typed errors.
 */

export class ContractSettlementManagerError extends Error {

    constructor(message, code = "CONTRACT_SETTLEMENT_MANAGER_ERROR", details = null) {

        super(message);

        this.name = "ContractSettlementManagerError";

        this.code = code;

        this.details = details ?? null;

    }

}

export class SettlementAlreadyExistsError extends ContractSettlementManagerError {

    constructor(gameId, roomId = null) {

        super(
            `Settlement session already exists | gameId=${gameId}`,
            "SETTLEMENT_ALREADY_EXISTS",
            { gameId, roomId }
        );

        this.name = "SettlementAlreadyExistsError";

    }

}

export class SettlementNotFoundError extends ContractSettlementManagerError {

    constructor(identifier) {

        super(
            `Settlement session not found | id=${identifier}`,
            "SETTLEMENT_NOT_FOUND",
            { identifier }
        );

        this.name = "SettlementNotFoundError";

    }

}

export class SettlementValidationError extends ContractSettlementManagerError {

    constructor(message, details = null) {

        super(message, "SETTLEMENT_VALIDATION_ERROR", details);

        this.name = "SettlementValidationError";

    }

}

export class DuplicateSettlementError extends ContractSettlementManagerError {

    constructor(settlementSessionId, txHash = null) {

        super(
            `Duplicate settlement confirmation | session=${settlementSessionId}`,
            "DUPLICATE_SETTLEMENT",
            { settlementSessionId, txHash }
        );

        this.name = "DuplicateSettlementError";

    }

}

export class SettlementTimeoutError extends ContractSettlementManagerError {

    constructor(settlementSessionId) {

        super(
            `Settlement session timed out | settlementSessionId=${settlementSessionId}`,
            "SETTLEMENT_TIMEOUT",
            { settlementSessionId }
        );

        this.name = "SettlementTimeoutError";

    }

}

export class SettlementRecoveryError extends ContractSettlementManagerError {

    constructor(message, details = null) {

        super(message, "SETTLEMENT_RECOVERY_ERROR", details);

        this.name = "SettlementRecoveryError";

    }

}

export class InvalidSettlementStateTransitionError extends ContractSettlementManagerError {

    constructor(settlementSessionId, fromStatus, toStatus) {

        super(
            `Invalid settlement session transition | id=${settlementSessionId} | `
                + `from=${fromStatus} | to=${toStatus}`,
            "INVALID_SETTLEMENT_STATE_TRANSITION",
            { settlementSessionId, fromStatus, toStatus }
        );

        this.name = "InvalidSettlementStateTransitionError";

    }

}
