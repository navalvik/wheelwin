/**
 * R9.0B — Post-launch operations coordinator (observational only).
 *
 * Does not mutate gameplay, networking, blockchain, release, certification,
 * launch orchestration, or monitoring engines.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
    SERVICE_LIFECYCLE,
    resolveOperationsConfig
} from "./OperationsConfiguration.js";
import { ServiceLifecycleManager } from "./ServiceLifecycleManager.js";
import { ServiceHealthManager } from "./ServiceHealthManager.js";
import { ServiceKPIManager } from "./ServiceKPIManager.js";
import { ServiceSLAManager } from "./ServiceSLAManager.js";
import { MaintenanceWindowManager } from "./MaintenanceWindowManager.js";
import { VersionLifecycleManager } from "./VersionLifecycleManager.js";
import { IncidentEscalationManager } from "./IncidentEscalationManager.js";
import { OperationalTrendAnalyzer } from "./OperationalTrendAnalyzer.js";
import { OperationalEvidenceRegistry } from "./OperationalEvidenceRegistry.js";
import { OperationalMetricsCollector } from "./OperationalMetricsCollector.js";
import { OperationalReportBuilder } from "./OperationalReportBuilder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class OperationsManager {

    static _instance = null;

    constructor() {

        this._config = resolveOperationsConfig();

        this._repoRoot = resolve(__dirname, "../..");

        this._providers = null;

        this._lifecycle = new ServiceLifecycleManager();

        this._health = new ServiceHealthManager();

        this._kpi = new ServiceKPIManager();

        this._sla = new ServiceSLAManager({
            availabilityTarget: this._config.slaAvailabilityTarget,
            latencyTargetMs: this._config.slaLatencyTargetMs,
            recoveryTarget: this._config.slaRecoveryTarget,
            settlementTarget: this._config.slaSettlementTarget
        });

        this._maintenance = new MaintenanceWindowManager({
            defaultDurationMinutes:
                this._config.maintenanceDefaultDurationMinutes
        });

        this._versions = new VersionLifecycleManager({
            supportWindowDays: this._config.versionSupportWindowDays
        });

        this._incidents = new IncidentEscalationManager({
            maxIncidents: this._config.maxIncidents
        });

        this._trends = new OperationalTrendAnalyzer({
            maxSamples: this._config.maxTrendSamples
        });

        this._evidence = new OperationalEvidenceRegistry();

        this._metrics = new OperationalMetricsCollector();

        this._reportBuilder = new OperationalReportBuilder();

        this._lastSnapshot = null;

        this._startedAt = null;

        this._lastCollectAt = 0;

    }

    static getInstance() {

        if (!OperationsManager._instance) {

            OperationsManager._instance = new OperationsManager();

        }

        return OperationsManager._instance;

    }

    static resetForTests() {

        OperationsManager._instance = null;

    }

    /**
     * @param {{
     *   repoRoot?: string,
     *   config?: object,
     *   providers?: object,
     *   initialVersion?: string
     * }} options
     */
    initialize(options = {}) {

        if (options.repoRoot) {

            this._repoRoot = options.repoRoot;

        }

        if (options.config) {

            this._config = Object.freeze({
                ...this._config,
                ...options.config
            });

            this._sla = new ServiceSLAManager({
                availabilityTarget: this._config.slaAvailabilityTarget,
                latencyTargetMs: this._config.slaLatencyTargetMs,
                recoveryTarget: this._config.slaRecoveryTarget,
                settlementTarget: this._config.slaSettlementTarget
            });

            this._maintenance = new MaintenanceWindowManager({
                defaultDurationMinutes:
                    this._config.maintenanceDefaultDurationMinutes
            });

            this._versions = new VersionLifecycleManager({
                supportWindowDays: this._config.versionSupportWindowDays
            });

            this._incidents = new IncidentEscalationManager({
                maxIncidents: this._config.maxIncidents
            });

            this._trends = new OperationalTrendAnalyzer({
                maxSamples: this._config.maxTrendSamples
            });

        }

        this._providers = options.providers ?? null;

        this._lifecycle.reset(SERVICE_LIFECYCLE.GA_ACTIVE);

        this._kpi.setServiceStartedAt(Date.now());

        this._startedAt = Date.now();

        const initialVersion = options.initialVersion
            ?? this._providers?.version?.()
            ?? this._providers?.releaseManager?.getSafeStatus?.()?.version
            ?? "1.0.0";

        this._versions.register({
            version: String(initialVersion),
            activate: true,
            gaTimestamp: Date.now(),
            releaseTimestamp: Date.now()
        });

        return this;

    }

    updateProviders(providers = {}) {

        this._providers = {
            ...(this._providers ?? {}),
            ...providers
        };

        return this;

    }

    getLifecycle() {

        return this._lifecycle.getLifecycle();

    }

    getConfig() {

        return this._config;

    }

    getLifecycleManager() {

        return this._lifecycle;

    }

    getKPIManager() {

        return this._kpi;

    }

    getSLAManager() {

        return this._sla;

    }

    getMaintenanceManager() {

        return this._maintenance;

    }

    getVersionManager() {

        return this._versions;

    }

    getIncidentManager() {

        return this._incidents;

    }

    getTrendAnalyzer() {

        return this._trends;

    }

    getEvidenceRegistry() {

        return this._evidence;

    }

    /**
     * Only OperationsManager controls lifecycle transitions.
     *
     * @param {string} next
     * @param {{ force?: boolean, notes?: string }} [opts]
     */
    transitionTo(next, opts = {}) {

        return this._lifecycle.transitionTo(next, opts).lifecycle;

    }

    enterNormalOperation(notes = null) {

        const current = this.getLifecycle();

        if (current === SERVICE_LIFECYCLE.GA_ACTIVE
            || current === SERVICE_LIFECYCLE.POST_MAINTENANCE_VERIFICATION) {

            return this.transitionTo(
                SERVICE_LIFECYCLE.NORMAL_OPERATION,
                { notes }
            );

        }

        if (current === SERVICE_LIFECYCLE.NORMAL_OPERATION) {

            return current;

        }

        throw new Error(
            `Cannot enter NORMAL_OPERATION from ${current}`
        );

    }

    /**
     * Schedule + optionally start a maintenance window with lifecycle sync.
     *
     * @param {{
     *   type?: string,
     *   reason?: string,
     *   durationMinutes?: number,
     *   startImmediately?: boolean
     * }} input
     */
    scheduleMaintenance(input = {}) {

        if (this.getLifecycle() === SERVICE_LIFECYCLE.NORMAL_OPERATION
            || this.getLifecycle() === SERVICE_LIFECYCLE.GA_ACTIVE) {

            if (this.getLifecycle() === SERVICE_LIFECYCLE.GA_ACTIVE) {

                this.transitionTo(SERVICE_LIFECYCLE.NORMAL_OPERATION, {
                    notes: "pre-maintenance"
                });

            }

            this.transitionTo(SERVICE_LIFECYCLE.MAINTENANCE_SCHEDULED, {
                notes: input.reason
            });

        }

        const window = this._maintenance.schedule(input);

        if (input.startImmediately) {

            this.startMaintenance(window.id);

        }

        return window;

    }

    startMaintenance(id) {

        if (this.getLifecycle() === SERVICE_LIFECYCLE.MAINTENANCE_SCHEDULED) {

            this.transitionTo(SERVICE_LIFECYCLE.MAINTENANCE_ACTIVE);

        }

        return this._maintenance.start(id);

    }

    verifyMaintenance(input = {}) {

        if (this.getLifecycle() === SERVICE_LIFECYCLE.MAINTENANCE_ACTIVE) {

            this.transitionTo(
                SERVICE_LIFECYCLE.POST_MAINTENANCE_VERIFICATION
            );

        }

        return this._maintenance.verify(input);

    }

    completeMaintenance(input = {}) {

        const window = this._maintenance.complete(input);

        if (
            this.getLifecycle()
                === SERVICE_LIFECYCLE.POST_MAINTENANCE_VERIFICATION
            || this.getLifecycle() === SERVICE_LIFECYCLE.MAINTENANCE_ACTIVE
        ) {

            this.transitionTo(SERVICE_LIFECYCLE.NORMAL_OPERATION, {
                force: this.getLifecycle()
                    === SERVICE_LIFECYCLE.MAINTENANCE_ACTIVE,
                notes: "maintenance complete"
            });

        }

        return window;

    }

    /**
     * Collect KPIs, evaluate SLAs, update trends/evidence/metrics.
     *
     * @param {object} [overrides]
     * @param {{ force?: boolean }} [opts]
     */
    collect(overrides = {}, opts = {}) {

        if (!opts.force
            && this._lastSnapshot
            && (Date.now() - this._lastCollectAt) < 1000) {

            return this._lastSnapshot;

        }

        const ctx = this._buildContext(overrides);

        const health = this._health.assess(ctx);

        const kpi = this._kpi.collect(ctx);

        const sla = this._sla.evaluate(kpi, ctx);

        const incidents = this._incidents.summary();

        const operationalScore = Math.round(
            (
                (health.score ?? 0)
                + (sla.score ?? 0)
                + Math.max(0, 100 - (incidents.openCritical * 25))
            ) / 3
        );

        const trends = this._trends.push({
            kpi,
            slaScore: sla.score,
            healthScore: health.score,
            incidentCount: incidents.open,
            operationalScore
        });

        this._evidence.record({
            operation: "collect",
            status: sla.failed > 0 ? "WARNING" : "OK",
            metricsSnapshot: {
                operationalScore,
                availability: kpi.availability,
                averageLatencyMs: kpi.averageLatencyMs,
                slaScore: sla.score,
                openIncidents: incidents.open
            },
            recommendations: this._recommendations({
                sla,
                incidents,
                kpi,
                operationalScore
            })
        });

        const metrics = this._metrics.collect({
            lifecycle: this.getLifecycle(),
            operationalScore,
            kpi,
            slaScore: sla.score,
            slaFailed: sla.failed,
            maintenanceActive: this._maintenance.getActive() != null,
            incidentOpen: incidents.open,
            incidentOpenCritical: incidents.openCritical,
            activeVersion: this._versions.getActive()?.version ?? null,
            evidenceCount: this._evidence.count()
        });

        this._lastSnapshot = Object.freeze({
            collectedAt: Date.now(),
            lifecycle: this.getLifecycle(),
            health,
            kpi,
            sla,
            trends,
            incidents,
            versions: this._versions.summary(),
            maintenance: this._maintenance.getSafeStatus(),
            operationalScore,
            metrics,
            evidence: this._evidence.summary()
        });

        this._lastCollectAt = Date.now();

        return this._lastSnapshot;

    }

    /**
     * @param {{ write?: boolean, reportPath?: string, overrides?: object }} [opts]
     */
    generateReport(opts = {}) {

        const snapshot = this.collect(opts.overrides ?? {}, { force: true });

        const recommendations = this._recommendations({
            sla: snapshot.sla,
            incidents: snapshot.incidents,
            kpi: snapshot.kpi,
            operationalScore: snapshot.operationalScore
        });

        let assessment = "STABLE";

        if (snapshot.incidents.openCritical > 0
            || snapshot.sla.failed >= 2) {

            assessment = "AT_RISK";

        } else if (snapshot.operationalScore < 70
            || snapshot.sla.failed > 0) {

            assessment = "NEEDS_ATTENTION";

        }

        const input = {
            lifecycle: snapshot.lifecycle,
            uptimeMs: this._lifecycle.getUptimeMs(),
            healthScore: snapshot.health.score,
            versions: snapshot.versions,
            kpi: snapshot.kpi,
            sla: snapshot.sla,
            maintenance: snapshot.maintenance,
            incidents: snapshot.incidents,
            trends: snapshot.trends,
            operationalScore: snapshot.operationalScore,
            recommendations,
            assessment
        };

        const markdown = this._reportBuilder.buildMarkdown(input);

        let path = null;

        if (opts.write !== false) {

            path = opts.reportPath
                ?? resolve(this._repoRoot, this._config.reportRelativePath);

            this._reportBuilder.writeReport(path, input);

        }

        return Object.freeze({ path, markdown, ...input, snapshot });

    }

    getSafeStatus() {

        if (this._config.enabled !== false) {

            this.collect();

        }

        const snap = this._lastSnapshot;

        return Object.freeze({
            enabled: this._config.enabled === true,
            lifecycle: this.getLifecycle(),
            operationalScore: snap?.operationalScore ?? 0,
            maintenanceActive: snap?.maintenance?.active === true,
            maintenanceState: snap?.maintenance?.activeOutcome
                ?? (snap?.maintenance?.active ? "ACTIVE" : "IDLE"),
            currentVersion: snap?.versions?.activeVersion ?? null,
            supportedVersions: snap?.versions?.byStatus?.SUPPORTED ?? 0,
            kpiSummary: snap?.kpi
                ? Object.freeze({
                    availability: snap.kpi.availability,
                    averageLatencyMs: snap.kpi.averageLatencyMs,
                    crashRate: snap.kpi.crashRate,
                    recoverySuccessRate: snap.kpi.recoverySuccessRate,
                    settlementSuccessRate: snap.kpi.settlementSuccessRate
                })
                : null,
            slaSummary: snap?.sla
                ? Object.freeze({
                    score: snap.sla.score,
                    passed: snap.sla.passed,
                    warned: snap.sla.warned,
                    failed: snap.sla.failed
                })
                : null,
            incidentSummary: snap?.incidents
                ? Object.freeze({
                    open: snap.incidents.open,
                    openCritical: snap.incidents.openCritical,
                    total: snap.incidents.total
                })
                : null,
            trendSampleCount: snap?.trends?.sampleCount ?? 0,
            uptimeMs: this._lifecycle.getUptimeMs(),
            evidenceHash: snap?.evidence?.aggregateHash
                ? String(snap.evidence.aggregateHash).slice(0, 16)
                : null,
            startedAt: this._startedAt
        });

    }

    getConsoleProjection() {

        const status = this.getSafeStatus();

        const snap = this._lastSnapshot;

        return Object.freeze({
            ...status,
            versions: snap?.versions?.versions ?? [],
            slaResults: (snap?.sla?.results ?? []).map((r) =>
                Object.freeze({
                    id: r.id,
                    name: r.name,
                    status: r.status,
                    target: r.target,
                    actual: r.actual
                })),
            trends: snap?.trends?.trends ?? null,
            recentIncidents: this._incidents.listIncidents().slice(0, 10)
                .map((i) => Object.freeze({
                    id: i.id,
                    severity: i.severity,
                    summary: i.summary,
                    open: i.open,
                    timestamp: i.timestamp
                }))
        });

    }

    _recommendations({ sla, incidents, kpi, operationalScore }) {

        const out = [];

        if ((incidents?.openCritical ?? 0) > 0) {

            out.push("Escalate and resolve open CRITICAL incidents first.");

        }

        if ((sla?.failed ?? 0) > 0) {

            out.push("Investigate failing SLA targets before expanding load.");

        }

        if ((kpi?.averageLatencyMs ?? 0) > (this._config.slaLatencyTargetMs ?? 250)) {

            out.push("Latency exceeds SLA target — review network and event-loop metrics.");

        }

        if ((kpi?.crashRate ?? 0) > 0.05) {

            out.push("Crash rate elevated — review crash collector and recent releases.");

        }

        if (operationalScore >= 90 && out.length === 0) {

            out.push("Service operating within targets — continue continuous supervision.");

        }

        if (out.length === 0) {

            out.push("Monitor trends and keep maintenance windows documented.");

        }

        return out;

    }

    _buildContext(overrides = {}) {

        const p = this._providers ?? {};

        return {
            metricsService: overrides.metricsService
                ?? p.metricsService
                ?? null,
            metricsSnapshot: overrides.metricsSnapshot
                ?? p.metricsService?.getSnapshot?.()
                ?? null,
            monitoringSnapshot: overrides.monitoringSnapshot
                ?? p.monitoringManager?.getSnapshot?.()
                ?? null,
            monitoring: overrides.monitoring
                ?? p.monitoringManager?.getHealthStatus?.()
                ?? null,
            health: overrides.health
                ?? p.healthSnapshot?.()
                ?? null,
            deployment: overrides.deployment
                ?? p.deploymentHealth?.()
                ?? null,
            closedBeta: overrides.closedBeta
                ?? p.closedBetaManager?.getSafeStatus?.()
                ?? null,
            ga: overrides.ga
                ?? p.generalAvailabilityManager?.getSafeStatus?.()
                ?? null,
            activeSessions: overrides.activeSessions
                ?? p.gameManager?.getGames?.()?.length
                ?? 0,
            ...overrides
        };

    }

}

export {
    SERVICE_LIFECYCLE,
    resolveOperationsConfig
};
