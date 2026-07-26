/**
 * R8.0D — Crash / fatal collection with redaction.
 */

import { createBetaCrashReport } from "./models/BetaCrashReport.js";

export class BetaCrashCollector {

    /**
     * @param {{ maxCrashReports?: number }} [options]
     */
    constructor(options = {}) {

        this._max = options.maxCrashReports ?? 200;

        /** @type {ReturnType<typeof createBetaCrashReport>[]} */
        this._reports = [];

        this._handlersInstalled = false;

        this._onUncaught = null;

        this._onRejection = null;

        this._rcVersionProvider = null;

        this._environmentProvider = null;

    }

    /**
     * @param {{
     *   rcVersionProvider?: () => string|null,
     *   environmentProvider?: () => object|null
     * }} providers
     */
    setProviders(providers = {}) {

        this._rcVersionProvider = providers.rcVersionProvider ?? null;

        this._environmentProvider = providers.environmentProvider ?? null;

    }

    clear() {

        this._reports = [];

    }

    count() {

        return this._reports.length;

    }

    list() {

        return [...this._reports].sort((a, b) => b.timestamp - a.timestamp);

    }

    /**
     * @param {Parameters<typeof createBetaCrashReport>[0]} input
     */
    record(input = {}) {

        const report = createBetaCrashReport({
            ...input,
            rcVersion: input.rcVersion
                ?? this._rcVersionProvider?.()
                ?? null,
            environment: input.environment
                ?? this._environmentProvider?.()
                ?? null
        });

        this._reports.push(report);

        if (this._reports.length > this._max) {

            this._reports.splice(0, this._reports.length - this._max);

        }

        return report;

    }

    /**
     * Record from an Error-like value.
     * @param {unknown} error
     * @param {{ source?: string, fatal?: boolean, kind?: string }} [meta]
     */
    recordError(error, meta = {}) {

        const err = error instanceof Error
            ? error
            : new Error(String(error));

        return this.record({
            source: meta.source ?? "server",
            kind: meta.kind ?? err.name ?? "Error",
            message: err.message,
            stack: err.stack ?? null,
            fatal: meta.fatal === true
        });

    }

    /**
     * Install observational process handlers (does not exit the process).
     */
    installProcessHandlers() {

        if (this._handlersInstalled || typeof process === "undefined") {

            return;

        }

        this._onUncaught = (error) => {

            try {

                this.recordError(error, {
                    source: "process",
                    kind: "uncaughtException",
                    fatal: true
                });

            } catch {

                // ignore secondary failures while recording
            }

            // Preserve fatal process semantics after observational capture.
            process.exit(1);

        };

        this._onRejection = (reason) => {

            this.recordError(reason, {
                source: "process",
                kind: "unhandledRejection",
                fatal: false
            });

        };

        process.on("uncaughtException", this._onUncaught);

        process.on("unhandledRejection", this._onRejection);

        this._handlersInstalled = true;

    }

    uninstallProcessHandlers() {

        if (!this._handlersInstalled || typeof process === "undefined") {

            return;

        }

        if (this._onUncaught) {

            process.off("uncaughtException", this._onUncaught);

        }

        if (this._onRejection) {

            process.off("unhandledRejection", this._onRejection);

        }

        this._handlersInstalled = false;

        this._onUncaught = null;

        this._onRejection = null;

    }

    summary() {

        const byKind = Object.create(null);

        let fatal = 0;

        for (const r of this._reports) {

            byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

            if (r.fatal) {

                fatal += 1;

            }

        }

        const windowMs = 60 * 60 * 1000;

        const since = Date.now() - windowMs;

        const recent = this._reports.filter((r) => r.timestamp >= since).length;

        return Object.freeze({
            total: this._reports.length,
            fatal,
            recentHour: recent,
            byKind: Object.freeze({ ...byKind })
        });

    }

    /**
     * Crashes per completed game (observational rate).
     * @param {number} gamesCompleted
     */
    crashRate(gamesCompleted) {

        const completed = Math.max(0, Number(gamesCompleted) || 0);

        if (completed <= 0) {

            return this._reports.length > 0 ? 1 : 0;

        }

        return Number((this._reports.length / completed).toFixed(4));

    }

}
