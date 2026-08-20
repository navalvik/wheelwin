/**
 * R17.9L.23 — DepositOrchestrator classified errors (fail closed).
 */

export const DEPOSIT_ORCHESTRATOR_ERROR_CODES = Object.freeze({
    ROOM_NOT_FOUND: "ROOM_NOT_FOUND",
    GAME_NOT_FOUND: "GAME_NOT_FOUND",
    INVALID_PLAYER_COUNT: "INVALID_PLAYER_COUNT",
    WALLET_UNAVAILABLE: "WALLET_UNAVAILABLE",
    FINANCIAL_CONFIG_UNAVAILABLE: "FINANCIAL_CONFIG_UNAVAILABLE",
    FINANCIAL_PROFILE_MISMATCH: "FINANCIAL_PROFILE_MISMATCH",
    SESSION_INCOMPATIBLE: "SESSION_INCOMPATIBLE",
    STATE_INIT_FAILED: "STATE_INIT_FAILED",
    PACKAGE_PERSISTENCE_FAILED: "PACKAGE_PERSISTENCE_FAILED",
    ACTIVATION_VERIFICATION_FAILED: "ACTIVATION_VERIFICATION_FAILED"
});

export class DepositOrchestratorError extends Error {

    constructor(message, code = "DEPOSIT_ORCHESTRATOR_ERROR", details = null) {

        super(message);

        this.name = "DepositOrchestratorError";

        this.code = code;

        this.details = details ?? null;

    }

}
