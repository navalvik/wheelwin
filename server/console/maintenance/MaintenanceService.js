/**
 * R6.2 — Maintenance mode preparation (no runtime behaviour).
 */

export const MAINTENANCE_STATE = Object.freeze({
    INACTIVE: "INACTIVE",
    SCHEDULED: "SCHEDULED",
    ACTIVE: "ACTIVE",
    COMPLETING: "COMPLETING"
});

/**
 * Future Maintenance Mode service — API surface only.
 */
export class MaintenanceService {

    constructor({ logger = null } = {}) {

        this._logger = logger;

        this._state = MAINTENANCE_STATE.INACTIVE;

    }

    getState() {

        return this._state;

    }

    getStatus() {

        return Object.freeze({
            enabled: false,
            state: this._state,
            message: "Maintenance Mode is not implemented. Architecture prepared for a future stage.",
            scheduledAt: null,
            activeSince: null,
            estimatedEndAt: null
        });

    }

    /**
     * Placeholder — not implemented.
     */
    scheduleMaintenance() {

        return {
            ok: false,
            status: 501,
            error: "Maintenance Mode is not implemented"
        };

    }

    /**
     * Placeholder — not implemented.
     */
    activateMaintenance() {

        return {
            ok: false,
            status: 501,
            error: "Maintenance Mode is not implemented"
        };

    }

    /**
     * Placeholder — not implemented.
     */
    deactivateMaintenance() {

        return {
            ok: false,
            status: 501,
            error: "Maintenance Mode is not implemented"
        };

    }

}
