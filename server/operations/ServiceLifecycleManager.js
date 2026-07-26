/**
 * R9.0B — Service lifecycle transitions (controlled via OperationsManager).
 */

import { SERVICE_LIFECYCLE } from "./OperationsConfiguration.js";
import { createServiceState } from "./models/ServiceState.js";

/**
 * Allowed forward transitions (NORMAL_OPERATION is re-entrant after maintenance).
 */
const ALLOWED = Object.freeze({
    [SERVICE_LIFECYCLE.GA_ACTIVE]: [
        SERVICE_LIFECYCLE.NORMAL_OPERATION,
        SERVICE_LIFECYCLE.SERVICE_RETIREMENT
    ],
    [SERVICE_LIFECYCLE.NORMAL_OPERATION]: [
        SERVICE_LIFECYCLE.MAINTENANCE_SCHEDULED,
        SERVICE_LIFECYCLE.SERVICE_RETIREMENT
    ],
    [SERVICE_LIFECYCLE.MAINTENANCE_SCHEDULED]: [
        SERVICE_LIFECYCLE.MAINTENANCE_ACTIVE,
        SERVICE_LIFECYCLE.NORMAL_OPERATION
    ],
    [SERVICE_LIFECYCLE.MAINTENANCE_ACTIVE]: [
        SERVICE_LIFECYCLE.POST_MAINTENANCE_VERIFICATION
    ],
    [SERVICE_LIFECYCLE.POST_MAINTENANCE_VERIFICATION]: [
        SERVICE_LIFECYCLE.NORMAL_OPERATION
    ],
    [SERVICE_LIFECYCLE.SERVICE_RETIREMENT]: []
});

export class ServiceLifecycleManager {

    constructor() {

        this._state = createServiceState({
            lifecycle: SERVICE_LIFECYCLE.GA_ACTIVE
        });

        this._history = [];

        this._startedAt = Date.now();

    }

    reset(lifecycle = SERVICE_LIFECYCLE.GA_ACTIVE) {

        this._state = createServiceState({ lifecycle });

        this._history = [];

        this._startedAt = Date.now();

    }

    getLifecycle() {

        return this._state.lifecycle;

    }

    getState() {

        return this._state;

    }

    getUptimeMs() {

        return Math.max(0, Date.now() - this._startedAt);

    }

    /**
     * @param {string} next
     * @param {{ force?: boolean, notes?: string }} [opts]
     */
    transitionTo(next, opts = {}) {

        const target = SERVICE_LIFECYCLE[next] ?? next;

        if (!Object.values(SERVICE_LIFECYCLE).includes(target)) {

            throw new Error(`Unknown service lifecycle: ${next}`);

        }

        const current = this._state.lifecycle;

        if (target === current) {

            return this._state;

        }

        const allowed = ALLOWED[current] ?? [];

        if (!opts.force && !allowed.includes(target)) {

            throw new Error(
                `Invalid service transition ${current} → ${target}`
            );

        }

        this._history.push(Object.freeze({
            at: Date.now(),
            from: current,
            to: target,
            notes: opts.notes ? String(opts.notes).slice(0, 200) : null
        }));

        this._state = createServiceState({
            lifecycle: target,
            notes: opts.notes ?? null
        });

        return this._state;

    }

    getSafeStatus() {

        return Object.freeze({
            lifecycle: this._state.lifecycle,
            since: this._state.since,
            uptimeMs: this.getUptimeMs(),
            transitionCount: this._history.length
        });

    }

}
