/**
 * R7.0D — Async-local / explicit correlation context for logs.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const storage = new AsyncLocalStorage();

const CONTEXT_KEYS = Object.freeze([
    "traceId",
    "roomId",
    "gameId",
    "playerId",
    "contractId",
    "paymentId",
    "setupSessionId",
    "resultSessionId",
    "recoveryId",
    "simulationId",
    "lifecycleState"
]);

export class LogContext {

    static getStore() {

        return storage.getStore() ?? null;

    }

    static get() {

        const store = LogContext.getStore();

        if (!store) {

            return {};

        }

        const out = {};

        for (const key of CONTEXT_KEYS) {

            if (store[key] != null && store[key] !== "") {

                out[key] = store[key];

            }

        }

        return out;

    }

    static run(context, fn) {

        const parent = LogContext.getStore() ?? {};

        const next = {
            ...parent,
            ...context,
            traceId: context.traceId || parent.traceId || randomUUID()
        };

        return storage.run(next, fn);

    }

    static createTraceId() {

        return randomUUID();

    }

    static keys() {

        return CONTEXT_KEYS;

    }

}
