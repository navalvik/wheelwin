/**
 * R9.0A — Production operational state mirror (observational).
 */

import { GA_LIFECYCLE } from "./ProductionConfiguration.js";

export class ProductionStateManager {

    constructor() {

        this._lifecycle = GA_LIFECYCLE.READY_FOR_RELEASE;

        this._releaseActive = false;

        this._gaActiveAt = null;

        this._stableAt = null;

    }

    reset() {

        this._lifecycle = GA_LIFECYCLE.READY_FOR_RELEASE;

        this._releaseActive = false;

        this._gaActiveAt = null;

        this._stableAt = null;

    }

    setLifecycle(lifecycle) {

        this._lifecycle = lifecycle;

        if (lifecycle === GA_LIFECYCLE.GA_ACTIVE && !this._gaActiveAt) {

            this._gaActiveAt = Date.now();

            this._releaseActive = true;

        }

        if (lifecycle === GA_LIFECYCLE.STABLE_RELEASE) {

            this._stableAt = Date.now();

            this._releaseActive = true;

        }

        if (lifecycle === GA_LIFECYCLE.READY_FOR_RELEASE) {

            this._releaseActive = false;

        }

    }

    getLifecycle() {

        return this._lifecycle;

    }

    getUptimeMs() {

        if (!this._gaActiveAt) {

            return 0;

        }

        return Math.max(0, Date.now() - this._gaActiveAt);

    }

    getSafeStatus() {

        return Object.freeze({
            lifecycle: this._lifecycle,
            releaseActive: this._releaseActive,
            gaActiveAt: this._gaActiveAt,
            stableAt: this._stableAt,
            uptimeMs: this.getUptimeMs()
        });

    }

}
