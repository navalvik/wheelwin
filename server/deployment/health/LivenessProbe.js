/**
 * R7.0G — Liveness probe (fails only on unrecoverable internal failure).
 */

import { HealthProbe } from "./HealthProbe.js";
import { PROBE_STATUS, PROBE_TYPE } from "../probeTypes.js";

export class LivenessProbe extends HealthProbe {

    constructor() {

        super({ name: "liveness", type: PROBE_TYPE.LIVENESS });

    }

    check(signals) {

        if (signals.unrecoverableFailure === true) {

            return {
                ok: false,
                status: PROBE_STATUS.FAIL,
                reason: "unrecoverable_failure",
                details: {
                    reason: signals.unrecoverableFailureReason ?? null
                }
            };

        }

        // DRAINING / STOPPED still count as alive until process exits —
        // k8s must not restart pods that are draining gracefully.
        return {
            ok: true,
            status: PROBE_STATUS.PASS,
            reason: "alive",
            details: {
                lifecycle: signals.lifecycleState ?? null
            }
        };

    }

}
