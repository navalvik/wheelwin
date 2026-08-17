/**
 * R17.9L.5A — DeploymentAuthorization lifecycle states.
 * Domain only. No TON, no GameContractManager, no deploy gate.
 */

export const DEPLOYMENT_AUTHORIZATION_STATUS = Object.freeze({
    CREATED: "CREATED",
    VALID: "VALID",
    CONSUMED: "CONSUMED",
    REVOKED: "REVOKED"
});

export const DEPLOYMENT_AUTHORIZATION_TRANSITIONS = Object.freeze({
    [DEPLOYMENT_AUTHORIZATION_STATUS.CREATED]: Object.freeze([
        DEPLOYMENT_AUTHORIZATION_STATUS.VALID
    ]),
    [DEPLOYMENT_AUTHORIZATION_STATUS.VALID]: Object.freeze([
        DEPLOYMENT_AUTHORIZATION_STATUS.CONSUMED,
        DEPLOYMENT_AUTHORIZATION_STATUS.REVOKED
    ]),
    [DEPLOYMENT_AUTHORIZATION_STATUS.CONSUMED]: Object.freeze([]),
    [DEPLOYMENT_AUTHORIZATION_STATUS.REVOKED]: Object.freeze([])
});

export const TERMINAL_DEPLOYMENT_AUTHORIZATION_STATUSES = Object.freeze([
    DEPLOYMENT_AUTHORIZATION_STATUS.CONSUMED,
    DEPLOYMENT_AUTHORIZATION_STATUS.REVOKED
]);

export const RESTORABLE_DEPLOYMENT_AUTHORIZATION_STATUSES = Object.freeze([
    DEPLOYMENT_AUTHORIZATION_STATUS.CREATED,
    DEPLOYMENT_AUTHORIZATION_STATUS.VALID,
    DEPLOYMENT_AUTHORIZATION_STATUS.CONSUMED
]);

export function canTransitionDeploymentAuthorizationStatus(fromStatus, toStatus) {

    const allowed = DEPLOYMENT_AUTHORIZATION_TRANSITIONS[fromStatus] ?? [];

    return allowed.includes(toStatus);

}

export function isDeploymentAuthorizationTerminal(status) {

    return TERMINAL_DEPLOYMENT_AUTHORIZATION_STATUSES.includes(status);

}

export function isRestorableDeploymentAuthorizationStatus(status) {

    return RESTORABLE_DEPLOYMENT_AUTHORIZATION_STATUSES.includes(status);

}
