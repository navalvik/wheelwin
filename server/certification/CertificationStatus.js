/**
 * R8.0C — Certification status constants.
 */

export const CERTIFICATION_STATUS = Object.freeze({
    NOT_CERTIFIED: "NOT_CERTIFIED",
    RUNNING: "RUNNING",
    PASSED: "PASSED",
    PASSED_WITH_WARNINGS: "PASSED_WITH_WARNINGS",
    FAILED: "FAILED"
});

export const CHECK_STATUS = Object.freeze({
    PASS: "PASS",
    WARN: "WARN",
    FAIL: "FAIL",
    SKIP: "SKIP"
});

export function isCertifiableStatus(status) {

    return status === CERTIFICATION_STATUS.PASSED
        || status === CERTIFICATION_STATUS.PASSED_WITH_WARNINGS;

}
