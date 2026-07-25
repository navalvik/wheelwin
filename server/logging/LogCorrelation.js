/**
 * R7.0D — Correlation helpers (traceId inheritance).
 */

import { LogContext } from "./LogContext.js";

export class LogCorrelation {

    /**
     * Merge explicit fields with ambient async context.
     * Explicit fields win; ambient fills gaps; ensures traceId.
     */
    static resolve(explicit = {}) {

        const ambient = LogContext.get();

        const merged = {
            ...ambient,
            ...explicit
        };

        if (!merged.traceId) {

            merged.traceId = LogContext.createTraceId();

        }

        return merged;

    }

    /**
     * Run work under a correlated context (inherits parent traceId).
     */
    static withContext(context, fn) {

        return LogContext.run(context, fn);

    }

}
