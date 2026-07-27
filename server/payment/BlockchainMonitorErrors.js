/**
 * T2.5 — BlockchainMonitor typed infrastructure errors.
 */

export class BlockchainMonitorError extends Error {

    constructor(message, code = "BLOCKCHAIN_MONITOR_ERROR", details = null) {

        super(message);

        this.name = "BlockchainMonitorError";

        this.code = code;

        this.details = details ?? null;

    }

}

export class MonitorNotStartedError extends BlockchainMonitorError {

    constructor() {

        super("BlockchainMonitor is not running", "MONITOR_NOT_STARTED");

        this.name = "MonitorNotStartedError";

    }

}

export class BlockchainUnavailableError extends BlockchainMonitorError {

    constructor(message = "TON blockchain unavailable", details = null) {

        super(message, "BLOCKCHAIN_UNAVAILABLE", details);

        this.name = "BlockchainUnavailableError";

    }

}

export class ObservationTimeoutError extends BlockchainMonitorError {

    constructor(message = "Blockchain observation timed out", details = null) {

        super(message, "OBSERVATION_TIMEOUT", details);

        this.name = "ObservationTimeoutError";

    }

}

export class DuplicateObservationError extends BlockchainMonitorError {

    constructor(observationKey) {

        super(
            `Duplicate blockchain observation | key=${observationKey}`,
            "DUPLICATE_OBSERVATION",
            { observationKey }
        );

        this.name = "DuplicateObservationError";

    }

}

export class InvalidBlockchainDataError extends BlockchainMonitorError {

    constructor(message = "Invalid blockchain data", details = null) {

        super(message, "INVALID_BLOCKCHAIN_DATA", details);

        this.name = "InvalidBlockchainDataError";

    }

}

export class MonitorRecoveryError extends BlockchainMonitorError {

    constructor(message = "BlockchainMonitor recovery failed", details = null) {

        super(message, "MONITOR_RECOVERY_ERROR", details);

        this.name = "MonitorRecoveryError";

    }

}
