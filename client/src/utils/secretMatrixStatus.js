/**
 * Client mirror of server SecretMatrixStatus (R7.7A).
 * Display only — server remains authoritative.
 */
export const SECRET_MATRIX_STATUS = Object.freeze({
    NOT_SUBMITTED: "NOT_SUBMITTED",
    SUBMITTED: "SUBMITTED",
    MATCH_ACCEPTED: "MATCH_ACCEPTED",
    MATCH_REJECTED: "MATCH_REJECTED"
});

export const SECRET_MATRIX_STATUS_REASONS = Object.freeze({
    SOCKET_NOT_AUTHORIZED: "SOCKET_NOT_AUTHORIZED",
    INVALID_SECRET_MATRIX: "INVALID_SECRET_MATRIX",
    SECRET_MATRIX_MISMATCH: "SECRET_MATRIX_MISMATCH",
    SUBMITTED: "SUBMITTED",
    MATCH_ACCEPTED: "MATCH_ACCEPTED",
    RESTORED: "RESTORED"
});

export function createEmptyMatrixStatus() {

    return {
        status: SECRET_MATRIX_STATUS.NOT_SUBMITTED,
        submittedCount: 0,
        requiredPlayers: 0,
        selfSubmitted: false,
        reason: null,
        revision: 0
    };

}

export function canSubmitMatrixStatus(status) {

    return status === SECRET_MATRIX_STATUS.NOT_SUBMITTED
        || status === SECRET_MATRIX_STATUS.MATCH_REJECTED;

}
