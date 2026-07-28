/**
 * T2.9 — TonFinancialRecovery error types.
 */

export class FinancialRecoveryError extends Error {

    constructor(message, details = null) {

        super(message);

        this.name = "FinancialRecoveryError";

        this.details = details ?? null;

    }

}

export class RecoveryValidationError extends FinancialRecoveryError {

    constructor(message, details = null) {

        super(message, details);

        this.name = "RecoveryValidationError";

    }

}

export class RecoveryConsistencyError extends FinancialRecoveryError {

    constructor(message, details = null) {

        super(message, details);

        this.name = "RecoveryConsistencyError";

    }

}

export class RecoveryOrderError extends FinancialRecoveryError {

    constructor(message, details = null) {

        super(message, details);

        this.name = "RecoveryOrderError";

    }

}

export class RecoveryCheckpointError extends FinancialRecoveryError {

    constructor(message, details = null) {

        super(message, details);

        this.name = "RecoveryCheckpointError";

    }

}

export class RecoveryManagerUnavailableError extends FinancialRecoveryError {

    constructor(managerName, details = null) {

        super(`${managerName} is not available`, details);

        this.name = "RecoveryManagerUnavailableError";

        this.managerName = managerName;

    }

}
