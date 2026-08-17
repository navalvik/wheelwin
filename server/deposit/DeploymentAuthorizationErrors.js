/**
 * R17.9L.5A — DeploymentAuthorization typed errors.
 */

export class DeploymentAuthorizationError extends Error {

    constructor(message, code = "DEPLOYMENT_AUTHORIZATION_ERROR", details = null) {

        super(message);

        this.name = "DeploymentAuthorizationError";

        this.code = code;

        this.details = details ?? null;

    }

}

export class InvalidDeploymentAuthorizationError extends DeploymentAuthorizationError {

    constructor(reason, details = null) {

        super(reason, "INVALID_DEPLOYMENT_AUTHORIZATION", details);

        this.name = "InvalidDeploymentAuthorizationError";

    }

}

export class InvalidDeploymentAuthorizationTransitionError extends DeploymentAuthorizationError {

    constructor(authorizationId, fromStatus, toStatus) {

        super(
            `Invalid deployment authorization transition | id=${authorizationId} | `
                + `from=${fromStatus} | to=${toStatus}`,
            "INVALID_DEPLOYMENT_AUTHORIZATION_TRANSITION",
            { authorizationId, fromStatus, toStatus }
        );

        this.name = "InvalidDeploymentAuthorizationTransitionError";

    }

}
