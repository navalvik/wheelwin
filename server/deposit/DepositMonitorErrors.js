/**
 * R17.9L.7 — DepositMonitor typed errors.
 */

export class DepositMonitorError extends Error {

    constructor(message, code = "DEPOSIT_MONITOR_ERROR", details = null) {

        super(message);

        this.name = "DepositMonitorError";

        this.code = code;

        this.details = details ?? null;

    }

}

export class DepositMonitorNotStartedError extends DepositMonitorError {

    constructor() {

        super("DepositMonitor is not started", "DEPOSIT_MONITOR_NOT_STARTED");

        this.name = "DepositMonitorNotStartedError";

    }

}

export class InvalidDepositObservationError extends DepositMonitorError {

    constructor(reason, details = null) {

        super(reason, "INVALID_DEPOSIT_OBSERVATION", details);

        this.name = "InvalidDepositObservationError";

    }

}

export class DepositWatchNotFoundError extends DepositMonitorError {

    constructor(depositId) {

        super(
            `Deposit watch not found | depositId=${depositId}`,
            "DEPOSIT_WATCH_NOT_FOUND",
            { depositId }
        );

        this.name = "DepositWatchNotFoundError";

    }

}

export class DepositWatchNotAuthorizedError extends DepositMonitorError {

    constructor(depositId) {

        super(
            "DepositMonitor watch requires activation verification",
            "ACTIVATION_NOT_VERIFIED",
            { depositId }
        );

        this.name = "DepositWatchNotAuthorizedError";

    }

}
