/**
 * R6.2 — Read-only service status normalization for console diagnostics.
 */

export const SERVICE_STATUS = Object.freeze({
    HEALTHY: "Healthy",
    WARNING: "Warning",
    OFFLINE: "Offline",
    INITIALIZING: "Initializing",
    ERROR: "Error"
});

export function mapTonServiceStatus(health) {

    if (!health) {

        return SERVICE_STATUS.OFFLINE;

    }

    if (health.connected === true) {

        return health.lastFailure ? SERVICE_STATUS.WARNING : SERVICE_STATUS.HEALTHY;

    }

    return SERVICE_STATUS.OFFLINE;

}

export function mapMonitorStatus(health) {

    if (!health) {

        return SERVICE_STATUS.OFFLINE;

    }

    if (health.state === "INITIALIZING") {

        return SERVICE_STATUS.INITIALIZING;

    }

    if (health.state === "ERROR") {

        return SERVICE_STATUS.ERROR;

    }

    if (health.connected === true) {

        return health.lastFailure ? SERVICE_STATUS.WARNING : SERVICE_STATUS.HEALTHY;

    }

    return SERVICE_STATUS.OFFLINE;

}

export function mapManagerStatus(health, { initialized = true } = {}) {

    if (!initialized) {

        return SERVICE_STATUS.OFFLINE;

    }

    if (!health) {

        return SERVICE_STATUS.INITIALIZING;

    }

    return SERVICE_STATUS.HEALTHY;

}

export function mapRecoveryStatus(snapshot, { initialized = true } = {}) {

    if (!initialized) {

        return SERVICE_STATUS.OFFLINE;

    }

    if (!snapshot) {

        return SERVICE_STATUS.INITIALIZING;

    }

    if ((snapshot.errors?.length ?? 0) > 0) {

        return SERVICE_STATUS.ERROR;

    }

    if ((snapshot.warnings?.length ?? 0) > 0) {

        return SERVICE_STATUS.WARNING;

    }

    return SERVICE_STATUS.HEALTHY;

}
