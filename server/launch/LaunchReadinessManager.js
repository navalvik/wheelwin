/**
 * R8.0E — Launch readiness coordinator (observational only).
 *
 * Single owner of launch lifecycle transitions. Does not mutate gameplay,
 * networking, blockchain, release, certification, telemetry, or monitoring.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
    LAUNCH_LIFECYCLE,
    LAUNCH_LIFECYCLE_ORDER,
    LAUNCH_DECISION,
    resolveLaunchConfig
} from "./LaunchConfiguration.js";
import { LaunchEvidenceRegistry } from "./LaunchEvidenceRegistry.js";
import { LaunchChecklist } from "./LaunchChecklist.js";
import { LaunchGateEvaluator } from "./LaunchGateEvaluator.js";
import { OpenBetaReadinessEvaluator } from "./OpenBetaReadinessEvaluator.js";
import { ProductionLaunchEvaluator } from "./ProductionLaunchEvaluator.js";
import { LaunchDecisionManager } from "./LaunchDecisionManager.js";
import { LaunchMetricsCollector } from "./LaunchMetricsCollector.js";
import { LaunchReportBuilder } from "./LaunchReportBuilder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function lifecycleIndex(state) {

    return LAUNCH_LIFECYCLE_ORDER.indexOf(state);

}

export class LaunchReadinessManager {

    static _instance = null;

    constructor() {

        this._config = resolveLaunchConfig();

        this._lifecycle = LAUNCH_LIFECYCLE.NOT_EVALUATED;

        this._repoRoot = resolve(__dirname, "../..");

        this._providers = null;

        this._evidence = new LaunchEvidenceRegistry();

        this._gateEvaluator = new LaunchGateEvaluator();

        this._decisionManager = new LaunchDecisionManager();

        this._metrics = new LaunchMetricsCollector();

        this._reportBuilder = new LaunchReportBuilder();

        this._openBetaEvaluator = null;

        this._productionEvaluator = null;

        this._checklist = null;

        this._lastOpenBeta = null;

        this._lastProduction = null;

        this._lastDecision = null;

        this._lastMetrics = null;

        this._startedAt = null;

        this._transitionLog = [];

        this._lastEvaluationDurationMs = 0;

    }

    static getInstance() {

        if (!LaunchReadinessManager._instance) {

            LaunchReadinessManager._instance = new LaunchReadinessManager();

        }

        return LaunchReadinessManager._instance;

    }

    static resetForTests() {

        LaunchReadinessManager._instance = null;

    }

    /**
     * @param {{
     *   repoRoot?: string,
     *   config?: object,
     *   providers?: object
     * }} options
     */
    initialize(options = {}) {

        if (options.repoRoot) {

            this._repoRoot = options.repoRoot;

        }

        if (options.config) {

            this._config = Object.freeze({
                ...this._config,
                ...options.config,
                thresholds: Object.freeze({
                    ...this._config.thresholds,
                    ...(options.config.thresholds ?? {})
                })
            });

        }

        this._providers = options.providers ?? null;

        this._checklist = new LaunchChecklist({ repoRoot: this._repoRoot });

        this._openBetaEvaluator = new OpenBetaReadinessEvaluator({
            repoRoot: this._repoRoot,
            thresholds: this._config.thresholds,
            closedBetaReportRelativePath:
                this._config.closedBetaReportRelativePath
        });

        this._productionEvaluator = new ProductionLaunchEvaluator({
            repoRoot: this._repoRoot,
            thresholds: this._config.thresholds,
            openBetaReportRelativePath:
                this._config.openBetaReportRelativePath,
            requireMainnetForGa: this._config.requireMainnetForGa
        });

        this._startedAt = Date.now();

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

        return this._lifecycle;

    }

    getConfig() {

        return this._config;

    }

    getEvidenceRegistry() {

        return this._evidence;

    }

    getChecklist() {

        return this._checklist;

    }

    getGateEvaluator() {

        return this._gateEvaluator;

    }

    getDecisionManager() {

        return this._decisionManager;

    }

    getMetricsCollector() {

        return this._metrics;

    }

    /**
     * Only the manager may advance lifecycle (forward-only).
     *
     * @param {string} next
     * @param {{ force?: boolean, reason?: string }} [opts]
     */
    transitionTo(next, opts = {}) {

        const target = LAUNCH_LIFECYCLE[next] ?? next;

        if (!Object.values(LAUNCH_LIFECYCLE).includes(target)) {

            throw new Error(`Unknown launch lifecycle state: ${next}`);

        }

        if (target === this._lifecycle) {

            return this._lifecycle;

        }

        const fromIdx = lifecycleIndex(this._lifecycle);

        const toIdx = lifecycleIndex(target);

        if (!opts.force && toIdx !== fromIdx + 1) {

            throw new Error(
                `Invalid launch transition ${this._lifecycle} → ${target}`
            );

        }

        if (
            target === LAUNCH_LIFECYCLE.OPEN_BETA_APPROVED
            && !opts.force
        ) {

            const decision = this._lastDecision ?? this.evaluate().decision;

            if (
                decision.decision !== LAUNCH_DECISION.READY_FOR_OPEN_BETA
                && decision.decision !== LAUNCH_DECISION.READY_FOR_GA
                && decision.decision !== LAUNCH_DECISION.READY_FOR_PRODUCTION
            ) {

                throw new Error(
                    `Cannot approve Open Beta while decision=${decision.decision}`
                );

            }

        }

        if (
            target === LAUNCH_LIFECYCLE.PRODUCTION_READY
            && !opts.force
        ) {

            const decision = this._lastDecision ?? this.evaluate().decision;

            if (decision.decision !== LAUNCH_DECISION.READY_FOR_PRODUCTION) {

                throw new Error(
                    `Cannot mark PRODUCTION_READY while decision=${decision.decision}`
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

    /**
     * Full deterministic evaluation: Open Beta gates + Production gates + decision.
     */
    evaluate(overrides = {}) {

        const started = Date.now();

        const ctx = this._buildContext(overrides);

        this._evidence.clear();

        const openBeta = this._openBetaEvaluator.evaluate(ctx);

        for (const gate of openBeta.gates) {

            this._evidence.recordFromGate(gate);

        }

        const production = this._productionEvaluator.evaluate({
            ...ctx,
            lifecycle: this._lifecycle,
            openBeta,
            openBetaReportPresent: overrides.openBetaReportPresent === true
        });

        for (const gate of production.gates) {

            this._evidence.recordFromGate(gate);

        }

        const evidenceSummary = this._evidence.summary();

        const decision = this._decisionManager.decide({
            openBeta,
            production,
            evidenceHash: evidenceSummary.aggregateHash
        });

        this._lastOpenBeta = openBeta;

        this._lastProduction = production;

        this._lastDecision = decision;

        this._lastEvaluationDurationMs = Date.now() - started;

        this._lastMetrics = this._metrics.collect({
            openBeta,
            production,
            decision,
            evidenceSummary,
            durationMs: this._lastEvaluationDurationMs,
            lifecycle: this._lifecycle,
            monitoringStatus: ctx.monitoring,
            health: ctx.health
        });

        return Object.freeze({
            openBeta,
            production,
            decision,
            evidenceSummary,
            metrics: this._lastMetrics,
            durationMs: this._lastEvaluationDurationMs
        });

    }

    /**
     * @param {{ write?: boolean, kind?: "open_beta"|"production"|"both" }} [opts]
     */
    generateReports(opts = {}) {

        const kind = opts.kind ?? "both";

        let evaluation = this.evaluate(opts.overrides ?? {});

        const buildInput = (evalResult) => ({
            lifecycle: this._lifecycle,
            rcVersion: this._resolveRcVersion(),
            closedBeta: this._providers?.closedBetaManager?.getSafeStatus?.()
                ?? opts.overrides?.closedBeta
                ?? null,
            openBeta: evalResult.openBeta,
            production: evalResult.production,
            decision: evalResult.decision,
            certification: this._providers?.certificationManager?.getSafeStatus?.()
                ?? opts.overrides?.certification
                ?? null,
            monitoring: this._providers?.monitoringManager?.getHealthStatus?.()
                ?? null,
            health: this._providers?.healthSnapshot?.() ?? null,
            deployment: this._providers?.deploymentHealth?.() ?? null,
            ton: this._providers?.tonConfig?.()
                ?? opts.overrides?.ton
                ?? null
        });

        const results = {};

        if (kind === "open_beta" || kind === "both") {

            const path = opts.openBetaReportPath
                ?? resolve(
                    this._repoRoot,
                    this._config.openBetaReportRelativePath
                );

            if (opts.write !== false) {

                results.openBeta = this._reportBuilder.writeReport(
                    path,
                    "open_beta",
                    buildInput(evaluation)
                );

            } else {

                results.openBeta = {
                    path: null,
                    markdown: this._reportBuilder.buildMarkdown(
                        "open_beta",
                        buildInput(evaluation)
                    )
                };

            }

        }

        // Re-evaluate after Open Beta report exists on disk for production gates
        if (kind === "production" || kind === "both") {

            evaluation = this.evaluate({
                ...(opts.overrides ?? {}),
                openBetaReportPresent: true
            });

            const path = opts.productionReportPath
                ?? resolve(
                    this._repoRoot,
                    this._config.productionReportRelativePath
                );

            if (opts.write !== false) {

                results.production = this._reportBuilder.writeReport(
                    path,
                    "production",
                    buildInput(evaluation)
                );

            } else {

                results.production = {
                    path: null,
                    markdown: this._reportBuilder.buildMarkdown(
                        "production",
                        buildInput(evaluation)
                    )
                };

            }

        }

        return Object.freeze({
            ...results,
            evaluation
        });

    }

    /**
     * Safe status for Health / Console / Monitoring (no secrets / stacks).
     */
    getSafeStatus() {

        if (this._config.enabled !== false) {

            this.evaluate();

        }

        const decision = this._lastDecision;

        const openBeta = this._lastOpenBeta;

        const production = this._lastProduction;

        const metrics = this._lastMetrics;

        const gateSummary = this._gateEvaluator.summarize([
            ...(openBeta?.gates ?? []),
            ...(production?.gates ?? [])
        ]);

        return Object.freeze({
            enabled: this._config.enabled === true,
            lifecycle: this._lifecycle,
            decision: decision?.decision ?? LAUNCH_DECISION.NOT_READY,
            decisionReason: decision?.reason ?? null,
            readinessScore: decision?.score ?? 0,
            openBetaReady: decision?.openBetaReady === true,
            gaReady: decision?.gaReady === true,
            productionReady: decision?.productionReady === true,
            openBetaScore: openBeta?.score ?? 0,
            productionScore: production?.score ?? 0,
            documentationCompleteness:
                production?.documentationCompleteness ?? 0,
            gateSummary: Object.freeze({
                total: gateSummary.total,
                passed: gateSummary.passed,
                failed: gateSummary.failed,
                passRate: gateSummary.passRate,
                criticalBlockers: gateSummary.criticalBlockers,
                highBlockers: gateSummary.highBlockers
            }),
            blockerSummary: Object.freeze({
                total: decision?.blockers?.length ?? 0,
                critical: (decision?.blockers ?? []).filter(
                    (b) => b.severity === "CRITICAL"
                ).length,
                high: (decision?.blockers ?? []).filter(
                    (b) => b.severity === "HIGH"
                ).length
            }),
            evidenceHash: decision?.evidenceHash
                ? String(decision.evidenceHash).slice(0, 16)
                : null,
            evaluationDurationMs: this._lastEvaluationDurationMs,
            rcVersion: this._resolveRcVersion(),
            startedAt: this._startedAt,
            metrics: metrics
                ? Object.freeze({
                    gatePassRate: metrics.gatePassRate,
                    gateFailureCount: metrics.gateFailureCount,
                    criticalBlockers: metrics.criticalBlockers,
                    highBlockers: metrics.highBlockers,
                    operationalReadinessScore:
                        metrics.operationalReadinessScore,
                    documentationCompleteness:
                        metrics.documentationCompleteness
                })
                : null
        });

    }

    getConsoleProjection() {

        const status = this.getSafeStatus();

        return Object.freeze({
            ...status,
            openBetaGates: (this._lastOpenBeta?.gates ?? []).slice(0, 30)
                .map((g) => Object.freeze({
                    id: g.id,
                    name: g.name,
                    status: g.status,
                    severity: g.severity
                })),
            productionGates: (this._lastProduction?.gates ?? []).slice(0, 40)
                .map((g) => Object.freeze({
                    id: g.id,
                    name: g.name,
                    status: g.status,
                    severity: g.severity
                })),
            blockers: (this._lastDecision?.blockers ?? []).slice(0, 30)
                .map((b) => Object.freeze({
                    id: b.id,
                    name: b.name,
                    severity: b.severity,
                    category: b.category
                }))
        });

    }

    _buildContext(overrides = {}) {

        const p = this._providers ?? {};

        return {
            closedBeta: overrides.closedBeta
                ?? p.closedBetaManager?.getSafeStatus?.()
                ?? null,
            certification: overrides.certification
                ?? p.certificationManager?.getSafeStatus?.()
                ?? null,
            release: overrides.release
                ?? p.releaseManager?.getSafeStatus?.()
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
            ton: overrides.ton
                ?? p.tonConfig?.()
                ?? null,
            safeConfiguration: overrides.safeConfiguration
                ?? p.safeConfiguration?.()
                ?? null,
            logging: overrides.logging
                ?? p.logging?.()
                ?? null,
            failurePolicy: overrides.failurePolicy
                ?? p.failurePolicy?.()
                ?? null,
            developerConsole: overrides.developerConsole
                ?? p.developerConsole?.()
                ?? null,
            securityHighOpen: overrides.securityHighOpen ?? 0,
            releaseBlockers: overrides.releaseBlockers ?? [],
            skipMainnetCheck: overrides.skipMainnetCheck === true,
            releaseArtifactsVerified:
                overrides.releaseArtifactsVerified === true,
            rollbackVerified: overrides.rollbackVerified === true,
            recoveryVerified: overrides.recoveryVerified === true,
            blockchainVerified: overrides.blockchainVerified === true,
            openBetaReportPresent: overrides.openBetaReportPresent === true,
            ...overrides
        };

    }

    _resolveRcVersion() {

        return this._providers?.releaseManager?.getSafeStatus?.()?.version
            ?? this._providers?.version?.()
            ?? null;

    }

}

export {
    LAUNCH_LIFECYCLE,
    LAUNCH_DECISION,
    resolveLaunchConfig
};
