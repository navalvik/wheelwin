/**
 * R8.0D — Closed Beta operations coordinator (observational only).
 *
 * Single owner of lifecycle transitions. Does not mutate gameplay,
 * networking, blockchain, release packaging, or certification engines.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
    BETA_LIFECYCLE,
    BETA_LIFECYCLE_ORDER,
    BETA_READINESS,
    resolveBetaConfig
} from "./BetaConfiguration.js";
import { BetaParticipantRegistry } from "./BetaParticipantRegistry.js";
import { BetaTelemetryManager } from "./BetaTelemetryManager.js";
import { BetaFeedbackManager } from "./BetaFeedbackManager.js";
import { BetaIncidentManager } from "./BetaIncidentManager.js";
import { BetaCrashCollector } from "./BetaCrashCollector.js";
import { BetaMetricsCollector } from "./BetaMetricsCollector.js";
import { BetaReadinessEvaluator } from "./BetaReadinessEvaluator.js";
import { BetaReportBuilder } from "./BetaReportBuilder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function lifecycleIndex(state) {

    return BETA_LIFECYCLE_ORDER.indexOf(state);

}

export class ClosedBetaManager {

    static _instance = null;

    constructor() {

        this._config = resolveBetaConfig();

        this._lifecycle = BETA_LIFECYCLE.NOT_STARTED;

        this._repoRoot = resolve(__dirname, "../..");

        this._providers = null;

        this._participants = new BetaParticipantRegistry({
            maxParticipants: this._config.maxParticipants
        });

        this._telemetry = new BetaTelemetryManager();

        this._feedback = new BetaFeedbackManager({
            maxFeedback: this._config.maxFeedback
        });

        this._incidents = new BetaIncidentManager({
            maxIncidents: this._config.maxIncidents
        });

        this._crashes = new BetaCrashCollector({
            maxCrashReports: this._config.maxCrashReports
        });

        this._metrics = new BetaMetricsCollector({
            telemetryManager: this._telemetry,
            participantRegistry: this._participants,
            feedbackManager: this._feedback,
            incidentManager: this._incidents,
            crashCollector: this._crashes
        });

        this._readiness = new BetaReadinessEvaluator();

        this._reportBuilder = new BetaReportBuilder();

        this._lastReadiness = null;

        this._lastMetrics = null;

        this._startedAt = null;

        this._transitionLog = [];

    }

    static getInstance() {

        if (!ClosedBetaManager._instance) {

            ClosedBetaManager._instance = new ClosedBetaManager();

        }

        return ClosedBetaManager._instance;

    }

    static resetForTests() {

        if (ClosedBetaManager._instance) {

            ClosedBetaManager._instance.shutdown();

        }

        ClosedBetaManager._instance = null;

    }

    /**
     * @param {{
     *   repoRoot?: string,
     *   config?: object,
     *   providers?: object,
     *   installCrashHandlers?: boolean
     * }} options
     */
    initialize(options = {}) {

        if (options.repoRoot) {

            this._repoRoot = options.repoRoot;

        }

        if (options.config) {

            this._config = Object.freeze({ ...this._config, ...options.config });

            this._participants = new BetaParticipantRegistry({
                maxParticipants: this._config.maxParticipants
            });

            this._feedback = new BetaFeedbackManager({
                maxFeedback: this._config.maxFeedback
            });

            this._incidents = new BetaIncidentManager({
                maxIncidents: this._config.maxIncidents
            });

            this._crashes = new BetaCrashCollector({
                maxCrashReports: this._config.maxCrashReports
            });

            this._metrics = new BetaMetricsCollector({
                telemetryManager: this._telemetry,
                participantRegistry: this._participants,
                feedbackManager: this._feedback,
                incidentManager: this._incidents,
                crashCollector: this._crashes
            });

        }

        this._providers = options.providers ?? null;

        this._telemetry.setProviders(this._providers);

        this._crashes.setProviders({
            rcVersionProvider: () => this._resolveRcVersion(),
            environmentProvider: () => ({
                nodeEnv: this._providers?.environment?.() ?? null,
                profile: this._providers?.profile?.() ?? null
            })
        });

        if (this._config.enabled && options.installCrashHandlers !== false) {

            this._crashes.installProcessHandlers();

        }

        this._startedAt = Date.now();

        return this;

    }

    /**
     * Merge additional read-only providers after late subsystems start.
     * @param {object} providers
     */
    updateProviders(providers = {}) {

        this._providers = {
            ...(this._providers ?? {}),
            ...providers
        };

        this._telemetry.setProviders(this._providers);

        this._crashes.setProviders({
            rcVersionProvider: () => this._resolveRcVersion(),
            environmentProvider: () => ({
                nodeEnv: this._providers?.environment?.() ?? null,
                profile: this._providers?.profile?.() ?? null
            })
        });

        return this;

    }

    shutdown() {

        this._crashes.uninstallProcessHandlers();

    }

    getLifecycle() {

        return this._lifecycle;

    }

    getConfig() {

        return this._config;

    }

    getParticipantRegistry() {

        return this._participants;

    }

    getFeedbackManager() {

        return this._feedback;

    }

    getIncidentManager() {

        return this._incidents;

    }

    getCrashCollector() {

        return this._crashes;

    }

    getTelemetryManager() {

        return this._telemetry;

    }

    /**
     * Only the manager may advance lifecycle. Forward-only along the chain,
     * except COMPLETED may move to OPEN_BETA_READY after readiness check.
     *
     * @param {string} next
     * @param {{ force?: boolean, reason?: string }} [opts]
     */
    transitionTo(next, opts = {}) {

        if (!BETA_LIFECYCLE[next] && !Object.values(BETA_LIFECYCLE).includes(next)) {

            throw new Error(`Unknown Closed Beta lifecycle state: ${next}`);

        }

        const target = BETA_LIFECYCLE[next] ?? next;

        if (target === this._lifecycle) {

            return this._lifecycle;

        }

        const fromIdx = lifecycleIndex(this._lifecycle);

        const toIdx = lifecycleIndex(target);

        if (toIdx < 0) {

            throw new Error(`Unknown Closed Beta lifecycle state: ${target}`);

        }

        if (!opts.force && toIdx !== fromIdx + 1) {

            throw new Error(
                `Invalid Closed Beta transition ${this._lifecycle} → ${target}`
            );

        }

        if (
            target === BETA_LIFECYCLE.ACTIVE
            && this._config.requireCertification
            && !opts.force
        ) {

            const cert = this._providers?.certificationManager?.getSafeStatus?.()
                ?? null;

            if (cert && cert.betaReady !== true) {

                throw new Error(
                    "Cannot enter ACTIVE Closed Beta without certified RC (betaReady)"
                );

            }

        }

        if (
            target === BETA_LIFECYCLE.OPEN_BETA_READY
            && !opts.force
        ) {

            const evaluation = this.evaluateReadiness();

            if (evaluation.readiness !== BETA_READINESS.READY_FOR_OPEN_BETA) {

                throw new Error(
                    `Cannot mark OPEN_BETA_READY while readiness=${evaluation.readiness}`
                );

            }

        }

        const previous = this._lifecycle;

        this._lifecycle = target;

        this._transitionLog.push(Object.freeze({
            at: Date.now(),
            from: previous,
            to: target,
            reason: opts.reason ? String(opts.reason).slice(0, 200) : null
        }));

        return this._lifecycle;

    }

    /** Convenience starters */
    startInvitations() {

        return this.transitionTo(BETA_LIFECYCLE.INVITATION);

    }

    activateBeta() {

        return this.transitionTo(BETA_LIFECYCLE.ACTIVE);

    }

    enterMonitoring() {

        return this.transitionTo(BETA_LIFECYCLE.MONITORING);

    }

    markReadyForReview() {

        return this.transitionTo(BETA_LIFECYCLE.READY_FOR_REVIEW);

    }

    completeBeta() {

        return this.transitionTo(BETA_LIFECYCLE.COMPLETED);

    }

    markOpenBetaReady() {

        return this.transitionTo(BETA_LIFECYCLE.OPEN_BETA_READY);

    }

    refreshMetrics() {

        const metrics = this._metrics.collect();

        const openHighFeedback = this._feedback.openHighSeverityCount();

        this._lastMetrics = Object.freeze({
            ...metrics,
            feedbackHighOpen: openHighFeedback
        });

        return this._lastMetrics;

    }

    evaluateReadiness() {

        const metrics = this.refreshMetrics();

        const certification = this._providers?.certificationManager?.getSafeStatus?.()
            ?? null;

        this._lastReadiness = this._readiness.evaluate({
            metrics,
            lifecycle: this._lifecycle,
            certification,
            openHighFeedback: metrics.feedbackHighOpen
        });

        return this._lastReadiness;

    }

    /**
     * Generate the Closed Beta report (markdown + optional disk write).
     *
     * @param {{ write?: boolean, reportPath?: string }} [opts]
     */
    generateReport(opts = {}) {

        const metrics = this.refreshMetrics();

        const readiness = this.evaluateReadiness();

        const input = {
            lifecycle: this._lifecycle,
            rcVersion: this._resolveRcVersion(),
            certification: this._providers?.certificationManager?.getSafeStatus?.()
                ?? null,
            participants: this._participants.summary(),
            metrics,
            readiness,
            feedbackSummary: this._feedback.summary(),
            incidentSummary: this._incidents.summary(),
            crashSummary: this._crashes.summary()
        };

        const markdown = this._reportBuilder.buildMarkdown(input);

        let path = null;

        if (opts.write !== false) {

            path = opts.reportPath
                ?? resolve(this._repoRoot, this._config.reportRelativePath);

            this._reportBuilder.writeReport(path, input);

        }

        return Object.freeze({ path, markdown, readiness, metrics });

    }

    /**
     * Safe status for Health / Console / Monitoring (no PII, no stacks).
     */
    getSafeStatus() {

        const metrics = this._lastMetrics ?? this.refreshMetrics();

        const readiness = this._lastReadiness ?? this.evaluateReadiness();

        const certification = this._providers?.certificationManager?.getSafeStatus?.()
            ?? null;

        return Object.freeze({
            enabled: this._config.enabled === true,
            lifecycle: this._lifecycle,
            rcVersion: this._resolveRcVersion(),
            certificationStatus: certification?.status ?? null,
            certificationBetaReady: certification?.betaReady === true,
            participantCount: this._participants.count(),
            participants: this._participants.summary(),
            activeSessions: metrics.activeSessions ?? 0,
            incidentCount: this._incidents.count(),
            incidents: this._incidents.summary(),
            crashCount: this._crashes.count(),
            crashes: this._crashes.summary(),
            feedbackCount: this._feedback.count(),
            feedback: this._feedback.summary(),
            crashRate: metrics.crashRate ?? 0,
            readiness: readiness.readiness,
            readinessScore: readiness.score,
            telemetry: Object.freeze({
                gamesStarted: metrics.telemetry?.session?.gamesStarted ?? 0,
                gamesCompleted: metrics.telemetry?.session?.gamesCompleted ?? 0,
                reconnectCount: metrics.telemetry?.session?.reconnectCount ?? 0,
                averageLatencyMs:
                    metrics.telemetry?.network?.averageLatencyMs ?? 0,
                recoverySuccessRate:
                    metrics.telemetry?.recovery?.recoverySuccessRate ?? 0,
                settlementSuccessRate:
                    metrics.telemetry?.payment?.settlementSuccessRate ?? 0,
                desynchronizationCount:
                    metrics.telemetry?.gameplay?.desynchronizationCount ?? 0
            }),
            startedAt: this._startedAt,
            transitionCount: this._transitionLog.length
        });

    }

    /**
     * Richer console panel projection (still no PII / stacks).
     */
    getConsoleProjection() {

        const status = this.getSafeStatus();

        return Object.freeze({
            ...status,
            participantsList: this._participants.getSafeList().slice(0, 50),
            recentFeedback: this._feedback.list().slice(0, 20).map((f) =>
                Object.freeze({
                    id: f.id,
                    category: f.category,
                    severity: f.severity,
                    status: f.status,
                    summary: f.summary,
                    timestamp: f.timestamp
                })),
            recentIncidents: this._incidents.list().slice(0, 20).map((i) =>
                Object.freeze({
                    id: i.id,
                    category: i.category,
                    severity: i.severity,
                    status: i.status,
                    description: i.description.slice(0, 120),
                    timestamp: i.timestamp
                })),
            recentCrashes: this._crashes.list().slice(0, 20).map((c) =>
                Object.freeze({
                    id: c.id,
                    kind: c.kind,
                    source: c.source,
                    message: c.message.slice(0, 120),
                    fatal: c.fatal,
                    timestamp: c.timestamp
                })),
            readinessChecks: this._lastReadiness?.checks ?? []
        });

    }

    _resolveRcVersion() {

        return this._providers?.releaseManager?.getSafeStatus?.()?.version
            ?? this._providers?.version?.()
            ?? null;

    }

}

export {
    BETA_LIFECYCLE,
    BETA_READINESS,
    resolveBetaConfig
};
