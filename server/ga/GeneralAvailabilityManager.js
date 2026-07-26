/**
 * R9.0A — General Availability release orchestration coordinator.
 *
 * Observational only: does not mutate gameplay, networking, blockchain,
 * release packaging, certification, telemetry, or monitoring engines.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
    GA_LIFECYCLE,
    GA_LIFECYCLE_ORDER,
    VERIFICATION_STATUS,
    resolveGaConfig
} from "./ProductionConfiguration.js";
import { ReleaseOrchestrator } from "./ReleaseOrchestrator.js";
import { RolloutManager } from "./RolloutManager.js";
import { ProductionVerificationManager } from "./ProductionVerificationManager.js";
import { RollbackCoordinator } from "./RollbackCoordinator.js";
import { ProductionStateManager } from "./ProductionStateManager.js";
import { ReleaseAnnouncementManager } from "./ReleaseAnnouncementManager.js";
import { ProductionEvidenceRegistry } from "./ProductionEvidenceRegistry.js";
import { ProductionMetricsCollector } from "./ProductionMetricsCollector.js";
import { ProductionReportBuilder } from "./ProductionReportBuilder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function lifecycleIndex(state) {

    return GA_LIFECYCLE_ORDER.indexOf(state);

}

export class GeneralAvailabilityManager {

    static _instance = null;

    constructor() {

        this._config = resolveGaConfig();

        this._repoRoot = resolve(__dirname, "../..");

        this._providers = null;

        this._orchestrator = new ReleaseOrchestrator();

        this._rollout = new RolloutManager({
            mode: this._config.rolloutMode
        });

        this._verifier = new ProductionVerificationManager({
            requireCertification: this._config.requireCertification
        });

        this._rollback = new RollbackCoordinator();

        this._state = new ProductionStateManager();

        this._announcement = new ReleaseAnnouncementManager();

        this._evidence = new ProductionEvidenceRegistry();

        this._metrics = new ProductionMetricsCollector();

        this._reportBuilder = new ProductionReportBuilder();

        this._lastVerification = null;

        this._lastRollback = null;

        this._lastMetrics = null;

        this._transitionLog = [];

        this._startedAt = null;

    }

    static getInstance() {

        if (!GeneralAvailabilityManager._instance) {

            GeneralAvailabilityManager._instance =
                new GeneralAvailabilityManager();

        }

        return GeneralAvailabilityManager._instance;

    }

    static resetForTests() {

        GeneralAvailabilityManager._instance = null;

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
                ...options.config
            });

            this._rollout = new RolloutManager({
                mode: this._config.rolloutMode
            });

            this._verifier = new ProductionVerificationManager({
                requireCertification: this._config.requireCertification
            });

        }

        this._providers = options.providers ?? null;

        this._state.reset();

        this._state.setLifecycle(GA_LIFECYCLE.READY_FOR_RELEASE);

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

        return this._state.getLifecycle();

    }

    getConfig() {

        return this._config;

    }

    getOrchestrator() {

        return this._orchestrator;

    }

    getRolloutManager() {

        return this._rollout;

    }

    getVerificationManager() {

        return this._verifier;

    }

    getRollbackCoordinator() {

        return this._rollback;

    }

    getEvidenceRegistry() {

        return this._evidence;

    }

    getMetricsCollector() {

        return this._metrics;

    }

    /**
     * @param {string} next
     * @param {{ force?: boolean, reason?: string }} [opts]
     */
    transitionTo(next, opts = {}) {

        const target = GA_LIFECYCLE[next] ?? next;

        if (!Object.values(GA_LIFECYCLE).includes(target)) {

            throw new Error(`Unknown GA lifecycle state: ${next}`);

        }

        const current = this._state.getLifecycle();

        if (target === current) {

            return current;

        }

        const fromIdx = lifecycleIndex(current);

        const toIdx = lifecycleIndex(target);

        if (!opts.force && toIdx !== fromIdx + 1) {

            throw new Error(
                `Invalid GA transition ${current} → ${target}`
            );

        }

        if (
            target === GA_LIFECYCLE.GA_ACTIVE
            && !opts.force
            && this._config.verifyAfterRelease
        ) {

            const verification = this._lastVerification
                ?? this.verifyProduction().verification;

            if (
                verification.status !== VERIFICATION_STATUS.PASSED
                && verification.status
                    !== VERIFICATION_STATUS.PASSED_WITH_WARNINGS
            ) {

                throw new Error(
                    `Cannot enter GA_ACTIVE while verification=${verification.status}`
                );

            }

            const rollback = this._lastRollback
                ?? this.evaluateRollback().rollback;

            if (rollback.recommend) {

                throw new Error(
                    "Cannot enter GA_ACTIVE while rollback is recommended"
                );

            }

        }

        this._state.setLifecycle(target);

        this._transitionLog.push(Object.freeze({
            at: Date.now(),
            from: current,
            to: target,
            reason: opts.reason ? String(opts.reason).slice(0, 200) : null
        }));

        return this._state.getLifecycle();

    }

    /**
     * Full deterministic GA release workflow (observational).
     *
     * @param {{
     *   autoAdvanceLifecycle?: boolean,
     *   completeRollout?: boolean,
     *   overrides?: object
     * }} [opts]
     */
    runRelease(opts = {}) {

        const auto = opts.autoAdvanceLifecycle !== false;

        const ctx = this._buildContext(opts.overrides ?? {});

        if (auto && this.getLifecycle() === GA_LIFECYCLE.READY_FOR_RELEASE) {

            this.transitionTo(GA_LIFECYCLE.RELEASE_STARTED, {
                reason: "runRelease"
            });

        }

        this._orchestrator.initialize(ctx);

        if (auto && this.getLifecycle() === GA_LIFECYCLE.RELEASE_STARTED) {

            this.transitionTo(GA_LIFECYCLE.ROLLOUT, { reason: "runRelease" });

        }

        this._rollout.start();

        if (opts.completeRollout !== false) {

            this._rollout.completeAll();

        }

        if (auto && this.getLifecycle() === GA_LIFECYCLE.ROLLOUT) {

            this.transitionTo(GA_LIFECYCLE.PRODUCTION_VERIFICATION, {
                reason: "runRelease"
            });

        }

        const verificationResult = this.verifyProduction(opts.overrides ?? {});

        const verification = verificationResult.verification;

        const orchestration = this._orchestrator.orchestrate({
            artifactOk: this._checkPassed(verification, "manifest")
                || this._checkPassed(verification, "release_version"),
            manifestOk: this._checkPassed(verification, "manifest"),
            certificateOk: this._checkPassed(verification, "release_certificate"),
            deploymentOk: this._checkPassed(verification, "configuration_profile")
                || this._checkPassed(verification, "readiness"),
            verificationOk:
                verification.status === VERIFICATION_STATUS.PASSED
                || verification.status
                    === VERIFICATION_STATUS.PASSED_WITH_WARNINGS,
            verificationRef: verification.evidenceHash
        });

        const announcement = this._announcement.announce({
            version: orchestration.release.version,
            channel: orchestration.release.channel,
            commit: orchestration.release.commit,
            fingerprint: orchestration.release.fingerprint,
            certificationRef: orchestration.release.certificationRef,
            verificationRef: verification.evidenceHash,
            lifecycle: this.getLifecycle(),
            releasedAt: Date.now()
        });

        this._orchestrator.patchRelease({
            announcedAt: announcement.releasedAt,
            verificationRef: verification.evidenceHash
        });

        const rollback = verificationResult.rollback;

        const metrics = this._collectMetrics(verification, rollback);

        if (
            auto
            && this.getLifecycle() === GA_LIFECYCLE.PRODUCTION_VERIFICATION
            && (
                verification.status === VERIFICATION_STATUS.PASSED
                || verification.status
                    === VERIFICATION_STATUS.PASSED_WITH_WARNINGS
            )
            && !rollback.recommend
        ) {

            this.transitionTo(GA_LIFECYCLE.GA_ACTIVE, {
                reason: "verification passed"
            });

            this.transitionTo(GA_LIFECYCLE.POST_LAUNCH_MONITORING, {
                reason: "post-launch monitoring"
            });

        }

        return Object.freeze({
            lifecycle: this.getLifecycle(),
            release: this._orchestrator.getRelease(),
            orchestration,
            rollout: this._rollout.getSafeStatus(),
            verification,
            rollback,
            announcement,
            metrics,
            evidence: this._evidence.summary()
        });

    }

    /**
     * @param {object} [overrides]
     */
    verifyProduction(overrides = {}) {

        const ctx = this._buildContext(overrides);

        this._evidence.clear();

        const verification = this._verifier.verify(ctx);

        for (const c of verification.checks) {

            this._evidence.recordFromCheck(c);

        }

        const evidenceSummary = this._evidence.summary();

        const withHash = Object.freeze({
            ...verification,
            evidenceHash: evidenceSummary.aggregateHash
        });

        this._lastVerification = withHash;

        const rollback = this._rollback.evaluate({
            verification: withHash,
            incidents: ctx.incidents,
            closedBeta: ctx.closedBeta,
            health: ctx.health,
            payments: ctx.payments,
            settlement: ctx.settlement,
            security: ctx.security,
            infrastructure: ctx.infrastructure,
            deployment: ctx.deployment,
            explicitTriggers: ctx.explicitTriggers,
            allowNotReady: true
        });

        this._lastRollback = rollback;

        this._collectMetrics(withHash, rollback);

        return Object.freeze({
            verification: withHash,
            rollback,
            evidence: evidenceSummary
        });

    }

    evaluateRollback(overrides = {}) {

        const ctx = this._buildContext(overrides);

        const rollback = this._rollback.evaluate({
            verification: this._lastVerification,
            ...ctx,
            allowNotReady: true
        });

        this._lastRollback = rollback;

        return Object.freeze({ rollback });

    }

    /**
     * Enter STABLE_RELEASE after post-launch monitoring window.
     *
     * @param {{ force?: boolean }} [opts]
     */
    markStable(opts = {}) {

        const current = this.getLifecycle();

        if (current === GA_LIFECYCLE.STABLE_RELEASE) {

            return current;

        }

        if (current === GA_LIFECYCLE.POST_LAUNCH_MONITORING) {

            const hours = this._config.postLaunchMonitoringHours;

            const uptimeMs = this._state.getUptimeMs();

            const requiredMs = hours * 60 * 60 * 1000;

            if (!opts.force && uptimeMs < requiredMs) {

                throw new Error(
                    `Post-launch monitoring window not elapsed (${uptimeMs}ms < ${requiredMs}ms)`
                );

            }

            return this.transitionTo(GA_LIFECYCLE.STABLE_RELEASE, {
                reason: "markStable"
            });

        }

        if (opts.force) {

            return this.transitionTo(GA_LIFECYCLE.STABLE_RELEASE, {
                force: true,
                reason: "markStable-forced"
            });

        }

        throw new Error(
            "STABLE_RELEASE requires POST_LAUNCH_MONITORING lifecycle"
        );

    }

    /**
     * @param {{ write?: boolean, reportPath?: string, overrides?: object }} [opts]
     */
    generateReport(opts = {}) {

        const result = this._lastVerification
            ? {
                verification: this._lastVerification,
                rollback: this._lastRollback
                    ?? this.evaluateRollback(opts.overrides).rollback,
                evidence: this._evidence.summary()
            }
            : this.verifyProduction(opts.overrides ?? {});

        if (!this._orchestrator.getRelease().startedAt) {

            this._orchestrator.initialize(this._buildContext(opts.overrides ?? {}));

        }

        if (!this._rollout.getCurrentStage()) {

            this._rollout.start();

            this._rollout.completeAll();

        }

        const announcement = this._announcement.getLatest()
            ?? this._announcement.announce({
                version: this._orchestrator.getRelease().version,
                channel: this._orchestrator.getRelease().channel,
                commit: this._orchestrator.getRelease().commit,
                fingerprint: this._orchestrator.getRelease().fingerprint,
                certificationRef:
                    this._orchestrator.getRelease().certificationRef,
                verificationRef: result.verification.evidenceHash,
                lifecycle: this.getLifecycle()
            });

        const metrics = this._lastMetrics
            ?? this._collectMetrics(result.verification, result.rollback);

        const input = {
            lifecycle: this.getLifecycle(),
            release: this._orchestrator.getRelease(),
            rollout: this._rollout.getSafeStatus(),
            verification: result.verification,
            rollback: result.rollback,
            metrics,
            evidence: result.evidence,
            announcement,
            gaDecision: result.rollback.recommend
                ? "ROLLBACK_RECOMMENDED"
                : (
                    result.verification.status === VERIFICATION_STATUS.PASSED
                    || result.verification.status
                        === VERIFICATION_STATUS.PASSED_WITH_WARNINGS
                        ? (
                            this.getLifecycle() === GA_LIFECYCLE.STABLE_RELEASE
                                ? "STABLE_RELEASE"
                                : "GA_ACTIVE_ELIGIBLE"
                        )
                        : "NOT_STABLE"
                )
        };

        const markdown = this._reportBuilder.buildMarkdown(input);

        let path = null;

        if (opts.write !== false) {

            path = opts.reportPath
                ?? resolve(this._repoRoot, this._config.reportRelativePath);

            this._reportBuilder.writeReport(path, input);

        }

        return Object.freeze({ path, markdown, ...input });

    }

    getSafeStatus() {

        if (!this._lastVerification && this._config.enabled !== false) {

            this.verifyProduction();

        }

        const release = this._orchestrator.getSafeStatus();

        const rollout = this._rollout.getSafeStatus();

        const verification = this._lastVerification;

        const rollback = this._lastRollback;

        const metrics = this._lastMetrics;

        const state = this._state.getSafeStatus();

        return Object.freeze({
            enabled: this._config.enabled === true,
            lifecycle: state.lifecycle,
            releaseVersion: release.version,
            releaseChannel: release.channel,
            rolloutStage: rollout.stage,
            rolloutComplete: rollout.complete === true,
            rolloutMode: rollout.mode,
            verificationStatus: verification?.status ?? "PENDING",
            verificationScore: verification?.score ?? 0,
            productionStatus: state.releaseActive ? "active" : "idle",
            operationalScore: metrics?.operationalScore ?? 0,
            rollbackRecommended: rollback?.recommend === true,
            rollbackReason: rollback?.reason ?? null,
            gaUptimeMs: state.uptimeMs,
            evidenceHash: verification?.evidenceHash
                ? String(verification.evidenceHash).slice(0, 16)
                : null,
            startedAt: this._startedAt,
            metrics: metrics
                ? Object.freeze({
                    releaseDurationMs: metrics.releaseDurationMs,
                    verificationDurationMs: metrics.verificationDurationMs,
                    rolloutDurationMs: metrics.rolloutDurationMs,
                    healthScore: metrics.healthScore,
                    deploymentScore: metrics.deploymentScore,
                    incidentCount: metrics.incidentCount
                })
                : null
        });

    }

    getConsoleProjection() {

        const status = this.getSafeStatus();

        return Object.freeze({
            ...status,
            verificationChecks: (this._lastVerification?.checks ?? [])
                .slice(0, 30)
                .map((c) => Object.freeze({
                    id: c.id,
                    name: c.name,
                    status: c.status,
                    severity: c.severity
                })),
            rollbackTriggers: (this._lastRollback?.triggers ?? [])
                .slice(0, 20)
                .map((t) => Object.freeze({ ...t })),
            announcement: this._announcement.getLatest()
                ? Object.freeze({
                    version: this._announcement.getLatest().version,
                    channel: this._announcement.getLatest().channel,
                    announcementHash: String(
                        this._announcement.getLatest().announcementHash
                    ).slice(0, 16),
                    releasedAt: this._announcement.getLatest().releasedAt
                })
                : null
        });

    }

    _checkPassed(verification, id) {

        const c = (verification.checks ?? []).find((x) => x.id === id);

        return c?.status === "PASS" || c?.status === "WARN";

    }

    _collectMetrics(verification, rollback) {

        const health = this._providers?.healthSnapshot?.() ?? null;

        const deployment = this._providers?.deploymentHealth?.() ?? null;

        const healthScore = health?.ready === true || health?.status === "ok"
            ? 100
            : (health?.status === "degraded" ? 70 : 0);

        const deploymentScore = deployment?.ready === true
            || deployment?.overall === "ok"
            ? 100
            : 50;

        const verificationScore = verification?.score ?? 0;

        const operationalScore = Math.round(
            (healthScore + deploymentScore + verificationScore) / 3
        );

        this._lastMetrics = this._metrics.collect({
            lifecycle: this.getLifecycle(),
            releaseDurationMs: this._orchestrator.getDurationMs(),
            verificationDurationMs: verification?.durationMs ?? 0,
            rolloutDurationMs: this._rollout.getDurationMs(),
            verificationScore,
            healthScore,
            deploymentScore,
            operationalScore,
            incidentCount: Number(
                this._providers?.closedBetaManager?.getSafeStatus?.()
                    ?.incidents?.openCritical
                ?? 0
            ),
            rollbackRecommended: rollback?.recommend === true,
            gaUptimeMs: this._state.getUptimeMs(),
            evidenceCount: this._evidence.count()
        });

        return this._lastMetrics;

    }

    _buildContext(overrides = {}) {

        const p = this._providers ?? {};

        return {
            release: overrides.release
                ?? p.releaseManager?.getSafeStatus?.()
                ?? null,
            certification: overrides.certification
                ?? p.certificationManager?.getSafeStatus?.()
                ?? null,
            health: overrides.health
                ?? p.healthSnapshot?.()
                ?? null,
            monitoring: overrides.monitoring
                ?? p.monitoringManager?.getHealthStatus?.()
                ?? null,
            logging: overrides.logging
                ?? p.logging?.()
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
            failurePolicy: overrides.failurePolicy
                ?? p.failurePolicy?.()
                ?? null,
            developerConsole: overrides.developerConsole
                ?? p.developerConsole?.()
                ?? null,
            launch: overrides.launch
                ?? p.launchReadinessManager?.getSafeStatus?.()
                ?? null,
            closedBeta: overrides.closedBeta
                ?? p.closedBetaManager?.getSafeStatus?.()
                ?? null,
            version: overrides.version
                ?? p.version?.()
                ?? null,
            metricsEnabled: overrides.metricsEnabled !== false,
            settlementAvailable: overrides.settlementAvailable !== false,
            recoveryAvailable: overrides.recoveryAvailable !== false,
            blockchainConnected: overrides.blockchainConnected,
            ...overrides
        };

    }

}

export {
    GA_LIFECYCLE,
    VERIFICATION_STATUS,
    resolveGaConfig
};
