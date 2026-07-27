/**
 * T2.2 — TonService typed infrastructure errors.
 */

export class TonServiceError extends Error {

    constructor(message, code = "TON_SERVICE_ERROR", details = null) {

        super(message);

        this.name = "TonServiceError";

        this.code = code;

        this.details = details ?? null;

    }

}

export class ConnectionError extends TonServiceError {

    constructor(message = "TON connection failed", details = null) {

        super(message, "CONNECTION_ERROR", details);

        this.name = "ConnectionError";

    }

}

export class RPCError extends TonServiceError {

    constructor(message, details = null, { retryable = false } = {}) {

        super(message, "RPC_ERROR", details);

        this.name = "RPCError";

        this.retryable = retryable === true;

    }

}

export class NetworkUnavailableError extends TonServiceError {

    constructor(message = "TON network unavailable", details = null) {

        super(message, "NETWORK_UNAVAILABLE", details);

        this.name = "NetworkUnavailableError";

    }

}

export class TimeoutError extends TonServiceError {

    constructor(message = "TON request timed out", details = null) {

        super(message, "TIMEOUT", details);

        this.name = "TimeoutError";

    }

}

export class BroadcastError extends TonServiceError {

    constructor(message = "TON broadcast failed", details = null) {

        super(message, "BROADCAST_ERROR", details);

        this.name = "BroadcastError";

    }

}

export class InvalidResponseError extends TonServiceError {

    constructor(message = "Invalid TON response", details = null) {

        super(message, "INVALID_RESPONSE", details);

        this.name = "InvalidResponseError";

    }

}

export class UnsupportedNetworkError extends TonServiceError {

    constructor(network) {

        super(
            `Unsupported TON network | network=${network}`,
            "UNSUPPORTED_NETWORK",
            { network }
        );

        this.name = "UnsupportedNetworkError";

    }

}

export class TonServiceNotInitializedError extends TonServiceError {

    constructor() {

        super("TonService is not initialized", "NOT_INITIALIZED");

        this.name = "TonServiceNotInitializedError";

    }

}

export class TonServiceNotConnectedError extends TonServiceError {

    constructor() {

        super("TonService is not connected", "NOT_CONNECTED");

        this.name = "TonServiceNotConnectedError";

    }

}
