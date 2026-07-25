/**
 * R7.0F — Async retry scheduler (no gameplay-blocking loops).
 */

import { randomUUID } from "node:crypto";

export class RetryScheduler {

    constructor() {

        this._pending = new Map();

        this._timers = new Map();

    }

    get queueSize() {

        return this._pending.size;

    }

    /**
     * @param {{
     *   delayMs: number,
     *   context: object,
     *   execute: () => (void|Promise<void>),
     *   onCancel?: () => void
     * }} job
     * @returns {string} jobId
     */
    schedule({ delayMs, context, execute, onCancel = null }) {

        const jobId = randomUUID();

        const handle = setTimeout(() => {

            this._timers.delete(jobId);

            this._pending.delete(jobId);

            setImmediate(() => {

                Promise.resolve()
                    .then(() => execute())
                    .catch(() => {
                        // caller / policy logs failures
                    });

            });

        }, Math.max(0, delayMs));

        if (typeof handle.unref === "function") {

            handle.unref();

        }

        this._timers.set(jobId, handle);

        this._pending.set(jobId, {
            jobId,
            scheduledAt: Date.now(),
            delayMs,
            context,
            onCancel
        });

        return jobId;

    }

    cancel(jobId) {

        const handle = this._timers.get(jobId);

        if (handle) {

            clearTimeout(handle);

            this._timers.delete(jobId);

        }

        const pending = this._pending.get(jobId);

        if (pending) {

            this._pending.delete(jobId);

            try {

                pending.onCancel?.();

            } catch {

                // ignore
            }

            return true;

        }

        return false;

    }

    cancelAll() {

        for (const jobId of [...this._pending.keys()]) {

            this.cancel(jobId);

        }

    }

    listPending() {

        return [...this._pending.values()].map((job) => ({
            jobId: job.jobId,
            scheduledAt: job.scheduledAt,
            delayMs: job.delayMs,
            component: job.context?.component ?? null,
            operation: job.context?.operation ?? null
        }));

    }

}
