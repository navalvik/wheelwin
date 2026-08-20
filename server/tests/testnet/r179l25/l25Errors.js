/**
 * R17.9L.25 — TEST-ONLY error taxonomy for player-signed Deposit E2E.
 * Not used by production modules.
 */

export const L25_ERROR_CODES = Object.freeze({
    ENV_DISABLED: "ENV_DISABLED",
    ENV_MISSING: "ENV_MISSING",
    ADDRESS_MISMATCH: "ADDRESS_MISMATCH",
    DERIVATION_UNCONFIRMED: "DERIVATION_UNCONFIRMED",
    READINESS_BLOCKED: "READINESS_BLOCKED",
    WALLET_INVALID: "WALLET_INVALID",
    WALLET_RESERVED: "WALLET_RESERVED",
    WALLET_UNDERFUNDED: "WALLET_UNDERFUNDED",
    STATEINIT_MISMATCH: "STATEINIT_MISMATCH",
    SENDER_FORBIDDEN: "SENDER_FORBIDDEN",
    SEAT_MISMATCH: "SEAT_MISMATCH",
    AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
    PHASE_FAILED: "PHASE_FAILED",
    TIMEOUT: "TIMEOUT",
    ZERO_SPEND_VIOLATION: "ZERO_SPEND_VIOLATION"
});

export class L25TestError extends Error {

    constructor(message, code = L25_ERROR_CODES.PHASE_FAILED, details = null) {

        super(message);

        this.name = "L25TestError";

        this.code = code;

        this.details = details ?? null;

    }

}
