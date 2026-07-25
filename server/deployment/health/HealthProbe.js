/**
 * R7.0G — Base health probe.
 */

import { PROBE_STATUS } from "../probeTypes.js";

export class HealthProbe {

    /**
     * @param {{ name: string, type: string }} options
     */
    constructor({ name, type }) {

        this.name = name;

        this.type = type;

        this._lastResult = null;

        this._lastLatencyMs = 0;

        this._failureCount = 0;

        this._successCount = 0;

    }

    /**
     * @param {object} signals
     * @returns {object}
     */
    evaluate(signals) {

        const started = performance.now();

        let result;

        try {

            result = this.check(signals);

        } catch (error) {

            result = {
                status: PROBE_STATUS.FAIL,
                ok: false,
                reason: error?.message ?? "probe_error"
            };

        }

        const latencyMs = Number((performance.now() - started).toFixed(3));

        this._lastLatencyMs = latencyMs;

        const normalized = Object.freeze({
            name: this.name,
            type: this.type,
            status: result.status ?? (result.ok ? PROBE_STATUS.PASS : PROBE_STATUS.FAIL),
            ok: result.ok === true,
            reason: result.reason ?? null,
            details: result.details ? Object.freeze({ ...result.details }) : null,
            latencyMs,
            checkedAt: Date.now()
        });

        this._lastResult = normalized;

        if (normalized.ok) {

            this._successCount += 1;

        } else {

            this._failureCount += 1;

        }

        return normalized;

    }

    /**
     * @param {object} _signals
     * @returns {{ ok: boolean, status?: string, reason?: string|null, details?: object }}
     */
    check(_signals) {

        throw new Error(`Probe ${this.name} must implement check()`);

    }

    getLastResult() {

        return this._lastResult;

    }

    getMetrics() {

        return {
            name: this.name,
            type: this.type,
            lastLatencyMs: this._lastLatencyMs,
            successCount: this._successCount,
            failureCount: this._failureCount
        };

    }

}
