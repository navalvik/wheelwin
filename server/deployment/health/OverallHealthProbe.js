/**
 * R7.0G — Overall health probe (component summary, never secrets).
 */

import { HealthProbe } from "./HealthProbe.js";
import { PROBE_STATUS, PROBE_TYPE } from "../probeTypes.js";

export class OverallHealthProbe extends HealthProbe {

    constructor() {

        super({ name: "health", type: PROBE_TYPE.HEALTH });

    }

    check(signals) {

        const components = {
            lifecycle: signals.lifecycleState ?? null,
            configuration: signals.configurationLoaded === true,
            logging: signals.loggingActive === true,
            monitoring: signals.monitoringActive === true
                || signals.monitoringRequired === false,
            failurePolicy: signals.failurePolicyInitialized === true,
            socket: signals.socketListening === true,
            http: signals.httpListening === true
        };

        const ready = signals.lifecycleState === "RUNNING"
            && components.configuration
            && components.logging
            && components.monitoring
            && components.failurePolicy
            && components.socket
            && components.http;

        const live = signals.unrecoverableFailure !== true;

        let status;

        let overall;

        if (!live) {

            status = PROBE_STATUS.FAIL;

            overall = "unhealthy";

        } else if (signals.lifecycleState === "DRAINING"
            || signals.lifecycleState === "STOPPED"
            || signals.lifecycleState === "STARTING"
            || !ready) {

            status = PROBE_STATUS.FAIL;

            overall = "not_ready";

        } else {

            status = PROBE_STATUS.PASS;

            overall = "ok";

        }

        return {
            ok: status === PROBE_STATUS.PASS,
            status,
            reason: overall,
            details: {
                overall,
                components,
                memory: signals.memory
                    ? {
                        heapUsed: signals.memory.heapUsed ?? null,
                        heapTotal: signals.memory.heapTotal ?? null,
                        rss: signals.memory.rss ?? null
                    }
                    : null,
                eventLoopDelayMs: signals.eventLoopDelayMs ?? null,
                activeGames: signals.activeGames ?? 0,
                activeRooms: signals.activeRooms ?? 0
            }
        };

    }

}
