/**
 * R7.0G — Readiness probe (accept new traffic only when RUNNING + deps ready).
 */

import { HealthProbe } from "./HealthProbe.js";
import { PROBE_STATUS, PROBE_TYPE } from "../probeTypes.js";

export class ReadinessProbe extends HealthProbe {

    /**
     * @param {{ strict?: boolean }} [options]
     */
    constructor({ strict = true } = {}) {

        super({ name: "readiness", type: PROBE_TYPE.READINESS });

        this._strict = strict === true;

    }

    check(signals) {

        const lifecycle = signals.lifecycleState;

        if (lifecycle === "DRAINING" || lifecycle === "STOPPED") {

            return {
                ok: false,
                status: PROBE_STATUS.FAIL,
                reason: lifecycle === "DRAINING"
                    ? "draining"
                    : "stopped",
                details: { lifecycle }
            };

        }

        const checks = {
            lifecycleRunning: lifecycle === "RUNNING",
            configuration: signals.configurationLoaded === true,
            logging: signals.loggingActive === true,
            monitoring: this._monitoringOk(signals),
            failurePolicy: signals.failurePolicyInitialized === true,
            socket: signals.socketListening === true,
            http: signals.httpListening === true
        };

        if (!this._strict) {

            // Development: allow readiness if lifecycle RUNNING and HTTP bound,
            // even when optional ops subsystems are still warming.
            const ok = checks.lifecycleRunning
                && checks.http
                && checks.configuration
                && checks.logging;

            return {
                ok,
                status: ok ? PROBE_STATUS.PASS : PROBE_STATUS.FAIL,
                reason: ok ? "ready" : "not_ready",
                details: checks
            };

        }

        const ok = Object.values(checks).every(Boolean);

        return {
            ok,
            status: ok ? PROBE_STATUS.PASS : PROBE_STATUS.FAIL,
            reason: ok ? "ready" : "not_ready",
            details: checks
        };

    }

    _monitoringOk(signals) {

        // Intentionally disabled monitoring satisfies the readiness gate.
        if (signals.monitoringRequired === false) {

            return true;

        }

        return signals.monitoringActive === true;

    }

}
