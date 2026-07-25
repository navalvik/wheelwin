/**
 * R7.0G — Startup probe (latches permanently once init succeeds).
 */

import { HealthProbe } from "./HealthProbe.js";
import { PROBE_STATUS, PROBE_TYPE } from "../probeTypes.js";

export class StartupProbe extends HealthProbe {

    constructor() {

        super({ name: "startup", type: PROBE_TYPE.STARTUP });

        this._latched = false;

        this._latchedAt = null;

    }

    check(signals) {

        if (this._latched) {

            return {
                ok: true,
                status: PROBE_STATUS.PASS,
                reason: "startup_complete",
                details: { latchedAt: this._latchedAt }
            };

        }

        const checks = {
            configuration: signals.configurationLoaded === true,
            lifecycle: signals.lifecycleInitialized === true,
            logging: signals.loggingActive === true,
            monitoring: signals.monitoringInitialized === true,
            failurePolicy: signals.failurePolicyInitialized === true,
            socket: signals.socketListening === true,
            http: signals.httpListening === true
        };

        const ok = Object.values(checks).every(Boolean);

        if (ok) {

            this._latched = true;

            this._latchedAt = Date.now();

        }

        return {
            ok,
            status: ok ? PROBE_STATUS.PASS : PROBE_STATUS.FAIL,
            reason: ok ? "startup_complete" : "startup_incomplete",
            details: checks
        };

    }

    isComplete() {

        return this._latched === true;

    }

    getLatchedAt() {

        return this._latchedAt;

    }

}
