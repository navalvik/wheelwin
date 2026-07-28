/**
 * T2.6 — WalletManager / SessionWalletStore typed errors.
 */

export class WalletManagerError extends Error {

    constructor(message, code = "WALLET_MANAGER_ERROR", details = null) {

        super(message);

        this.name = "WalletManagerError";

        this.code = code;

        this.details = details ?? null;

    }

}

export class WalletAlreadyExistsError extends WalletManagerError {

    constructor(playerId, roomId = null) {

        super(
            `Wallet session already exists | playerId=${playerId}`,
            "WALLET_ALREADY_EXISTS",
            { playerId, roomId }
        );

        this.name = "WalletAlreadyExistsError";

    }

}

export class WalletNotFoundError extends WalletManagerError {

    constructor(identifier) {

        super(
            `Wallet session not found | id=${identifier}`,
            "WALLET_NOT_FOUND",
            { identifier }
        );

        this.name = "WalletNotFoundError";

    }

}

export class WalletValidationError extends WalletManagerError {

    constructor(message, details = null) {

        super(message, "WALLET_VALIDATION_ERROR", details);

        this.name = "WalletValidationError";

    }

}

export class WalletNetworkMismatchError extends WalletManagerError {

    constructor(walletNetwork, activeNetwork) {

        super(
            `Wallet network mismatch | wallet=${walletNetwork} | active=${activeNetwork}`,
            "WALLET_NETWORK_MISMATCH",
            { walletNetwork, activeNetwork }
        );

        this.name = "WalletNetworkMismatchError";

    }

}

export class WalletVerificationError extends WalletManagerError {

    constructor(message, details = null) {

        super(message, "WALLET_VERIFICATION_ERROR", details);

        this.name = "WalletVerificationError";

    }

}

export class WalletSessionExpiredError extends WalletManagerError {

    constructor(walletSessionId) {

        super(
            `Wallet session expired | walletSessionId=${walletSessionId}`,
            "WALLET_SESSION_EXPIRED",
            { walletSessionId }
        );

        this.name = "WalletSessionExpiredError";

    }

}

export class WalletSessionConflictError extends WalletManagerError {

    constructor(message, details = null) {

        super(message, "WALLET_SESSION_CONFLICT", details);

        this.name = "WalletSessionConflictError";

    }

}

export class InvalidWalletStateTransitionError extends WalletManagerError {

    constructor(walletSessionId, fromStatus, toStatus) {

        super(
            `Invalid wallet session transition | id=${walletSessionId} | `
                + `from=${fromStatus} | to=${toStatus}`,
            "INVALID_WALLET_STATE_TRANSITION",
            { walletSessionId, fromStatus, toStatus }
        );

        this.name = "InvalidWalletStateTransitionError";

    }

}
