/**
 * R9.0B — Maintenance window tracking (observational).
 */

import {
    MAINTENANCE_TYPE,
    MAINTENANCE_OUTCOME
} from "./OperationsConfiguration.js";
import {
    createMaintenanceWindow,
    withMaintenanceWindowPatch
} from "./models/MaintenanceWindow.js";

export class MaintenanceWindowManager {

    /**
     * @param {{ defaultDurationMinutes?: number }} [options]
     */
    constructor(options = {}) {

        this._defaultDurationMinutes = options.defaultDurationMinutes ?? 60;

        /** @type {ReturnType<typeof createMaintenanceWindow>[]} */
        this._windows = [];

        this._activeId = null;

    }

    clear() {

        this._windows = [];

        this._activeId = null;

    }

    list() {

        return [...this._windows].sort((a, b) => b.start - a.start);

    }

    getActive() {

        if (!this._activeId) {

            return null;

        }

        return this._windows.find((w) => w.id === this._activeId) ?? null;

    }

    /**
     * @param {{
     *   type?: string,
     *   reason?: string,
     *   start?: number,
     *   durationMinutes?: number
     * }} input
     */
    schedule(input = {}) {

        const durationMinutes = input.durationMinutes
            ?? this._defaultDurationMinutes;

        const start = Number.isFinite(input.start) ? input.start : Date.now();

        const end = start + (durationMinutes * 60 * 1000);

        const window = createMaintenanceWindow({
            type: input.type ?? MAINTENANCE_TYPE.SCHEDULED,
            start,
            end,
            durationMs: end - start,
            reason: input.reason,
            outcome: MAINTENANCE_OUTCOME.PENDING
        });

        this._windows.push(window);

        return window;

    }

    /**
     * @param {string} [id]
     */
    start(id) {

        const window = id
            ? this._windows.find((w) => w.id === id)
            : this._windows.find(
                (w) => w.outcome === MAINTENANCE_OUTCOME.PENDING
            );

        if (!window) {

            throw new Error("No maintenance window to start");

        }

        const updated = withMaintenanceWindowPatch(window, {
            outcome: MAINTENANCE_OUTCOME.IN_PROGRESS,
            start: Date.now()
        });

        this._replace(updated);

        this._activeId = updated.id;

        return updated;

    }

    /**
     * @param {{ id?: string, verification?: string }} [input]
     */
    verify(input = {}) {

        const window = this._requireActive(input.id);

        const updated = withMaintenanceWindowPatch(window, {
            verification: input.verification ?? "Verification completed",
            outcome: MAINTENANCE_OUTCOME.VERIFIED
        });

        this._replace(updated);

        return updated;

    }

    /**
     * @param {{ id?: string, outcome?: string }} [input]
     */
    complete(input = {}) {

        const window = this._requireActive(input.id);

        const end = Date.now();

        const updated = withMaintenanceWindowPatch(window, {
            end,
            durationMs: Math.max(0, end - window.start),
            outcome: input.outcome ?? MAINTENANCE_OUTCOME.COMPLETED
        });

        this._replace(updated);

        this._activeId = null;

        return updated;

    }

    summary() {

        const byOutcome = Object.create(null);

        for (const o of Object.values(MAINTENANCE_OUTCOME)) {

            byOutcome[o] = 0;

        }

        for (const w of this._windows) {

            byOutcome[w.outcome] = (byOutcome[w.outcome] ?? 0) + 1;

        }

        return Object.freeze({
            total: this._windows.length,
            active: this._activeId != null,
            byOutcome: Object.freeze({ ...byOutcome })
        });

    }

    getSafeStatus() {

        const active = this.getActive();

        return Object.freeze({
            active: active != null,
            activeId: active?.id ?? null,
            activeType: active?.type ?? null,
            activeOutcome: active?.outcome ?? null,
            summary: this.summary()
        });

    }

    _requireActive(id) {

        const window = id
            ? this._windows.find((w) => w.id === id)
            : this.getActive();

        if (!window) {

            throw new Error("No active maintenance window");

        }

        return window;

    }

    _replace(updated) {

        const idx = this._windows.findIndex((w) => w.id === updated.id);

        if (idx >= 0) {

            this._windows[idx] = updated;

        } else {

            this._windows.push(updated);

        }

    }

}
