export class HealthService {

    constructor({ logger, productionConfig }) {

        this._logger = logger;

        this._productionConfig = productionConfig;

        this._startedAt = Date.now();

        this._startupDurationMs = null;

        this._shuttingDown = false;

        /** @type {string|null} R7.0B lifecycle mirror */
        this._lifecycleState = null;

        /** @type {object|null} R7.0C safe configuration summary */
        this._safeConfiguration = null;

        /** @type {object|null} R7.0D logger status (no filesystem paths) */
        this._loggerStatus = null;

        /** @type {object|null} R7.0E monitoring status */
        this._monitoringStatus = null;

        /** @type {object|null} R7.0F failure policy status */
        this._failurePolicyStatus = null;

        /** @type {import("../deployment/HealthManager.js").HealthManager|null} */
        this._healthManager = null;

        /** @type {object|null} R8.0B release metadata (no filesystem paths) */
        this._releaseStatus = null;

        /** @type {object|null} R8.0C certification status */
        this._certificationStatus = null;

        /** @type {object|null} R8.0D closed beta status */
        this._closedBetaStatus = null;

        /** @type {object|null} R8.0E launch readiness status */
        this._launchStatus = null;

        /** @type {object|null} R9.0A GA status */
        this._gaStatus = null;

        /** @type {object|null} R9.0B operations status */
        this._operationsStatus = null;

        this._componentRegistry = null;

        this._runtimeProvider = null;

    }

    markStartupComplete(durationMs) {

        this._startupDurationMs = durationMs;

    }

    markShuttingDown() {

        this._shuttingDown = true;

    }

    /**
     * R7.0B — Mirror ApplicationLifecycleManager state for /health + console.
     */
    setLifecycleState(state) {

        this._lifecycleState = state ?? null;

        if (state === "DRAINING" || state === "STOPPED") {

            this._shuttingDown = true;

        }

    }

    /**
     * R7.0C — Attach redacted configuration summary (never secrets).
     */
    setSafeConfiguration(safeConfiguration) {

        this._safeConfiguration = safeConfiguration
            ? Object.freeze({ ...safeConfiguration })
            : null;

    }

    /**
     * R7.0D — Attach sanitized logger / rotation status.
     */
    setLoggerStatus(loggerStatus) {

        this._loggerStatus = loggerStatus
            ? Object.freeze({ ...loggerStatus })
            : null;

    }

    /**
     * R7.0E — Attach sanitized monitoring status.
     */
    setMonitoringStatus(monitoringStatus) {

        this._monitoringStatus = monitoringStatus
            ? Object.freeze({ ...monitoringStatus })
            : null;

    }

    /**
     * R7.0F — Attach sanitized failure policy status (no stacks / secrets).
     */
    setFailurePolicyStatus(failurePolicyStatus) {

        this._failurePolicyStatus = failurePolicyStatus
            ? Object.freeze({ ...failurePolicyStatus })
            : null;

    }

    /**
     * R7.0G — Delegate probe coordination to HealthManager.
     */
    setHealthManager(healthManager) {

        this._healthManager = healthManager ?? null;

    }

    /**
     * R8.0B — Attach sanitized release metadata (no absolute paths).
     */
    setReleaseStatus(releaseStatus) {

        this._releaseStatus = releaseStatus
            ? Object.freeze({ ...releaseStatus })
            : null;

    }

    /**
     * R8.0C — Attach sanitized certification status.
     */
    setCertificationStatus(certificationStatus) {

        this._certificationStatus = certificationStatus
            ? Object.freeze({ ...certificationStatus })
            : null;

    }

    /**
     * R8.0D — Attach sanitized Closed Beta operational status (no PII).
     */
    setClosedBetaStatus(closedBetaStatus) {

        this._closedBetaStatus = closedBetaStatus
            ? Object.freeze({ ...closedBetaStatus })
            : null;

    }

    /**
     * R8.0E — Attach sanitized launch readiness status (no secrets).
     */
    setLaunchStatus(launchStatus) {

        this._launchStatus = launchStatus
            ? Object.freeze({ ...launchStatus })
            : null;

    }

    /**
     * R9.0A — Attach sanitized GA orchestration status.
     */
    setGaStatus(gaStatus) {

        this._gaStatus = gaStatus
            ? Object.freeze({ ...gaStatus })
            : null;

    }

    /**
     * R9.0B — Attach sanitized post-launch operations status.
     */
    setOperationsStatus(operationsStatus) {

        this._operationsStatus = operationsStatus
            ? Object.freeze({ ...operationsStatus })
            : null;

    }

    registerComponents(components) {

        this._componentRegistry = components;

    }

    /**
     * C4.5 — Registers a provider that returns live runtime counts (active
     * rooms/games/simulations/timers/sockets, pending teardowns/payments/audits).
     * Additive: the provider is read-only and never changes gameplay. It is
     * invoked lazily whenever a health snapshot is requested.
     */
    registerRuntimeProvider(provider) {

        this._runtimeProvider = typeof provider === "function"
            ? provider
            : null;

    }

    getHealthSnapshot() {

        const uptimeMs = Date.now() - this._startedAt;

        const components = this._componentRegistry
            ? Object.fromEntries(
                Object.entries(this._componentRegistry).map(([key, value]) => [
                    key,
                    value !== null && value !== undefined
                ])
            )
            : {};

        const lifecycle = this._lifecycleState;

        const deployment = this._healthManager?.getSafeStatus?.() ?? null;

        const probeReady = deployment?.ready;

        const ready = probeReady != null
            ? probeReady === true
            : lifecycle != null
                ? lifecycle === "RUNNING"
                : !this._shuttingDown
                    && Object.values(components).every((ok) => ok === true);

        const componentsHealthy = Object.values(components)
            .every((ok) => ok === true);

        let status;

        if (!ready || this._shuttingDown) {

            // R7.0B — operators / LB treat this as Not Ready.
            status = "not_ready";

        } else if (!componentsHealthy
            || (deployment?.overall && deployment.overall !== "ok")) {

            status = deployment?.overall === "unhealthy"
                ? "not_ready"
                : "degraded";

        } else {

            status = "ok";

        }

        const probeCache = this._healthManager?.getCachedSnapshot?.() ?? null;

        return {
            status,
            ready,
            lifecycle: lifecycle ?? (this._shuttingDown ? "DRAINING" : null),
            environment: this._productionConfig.nodeEnv,
            uptimeMs,
            startupDurationMs: this._startupDurationMs,
            shuttingDown: this._shuttingDown,
            components,
            runtime: this._resolveRuntime(),
            configuration: this._safeConfiguration,
            logger: this._loggerStatus,
            monitoring: this._resolveMonitoringStatus(),
            failurePolicy: this._failurePolicyStatus,
            // R7.0G — additive deployment probe summary
            deployment,
            probes: probeCache
                ? Object.freeze({
                    startup: probeCache.startup,
                    liveness: probeCache.liveness,
                    readiness: probeCache.readiness,
                    health: probeCache.health
                })
                : null,
            release: this._releaseStatus,
            certification: this._certificationStatus,
            closedBeta: this._closedBetaStatus,
            launch: this._launchStatus,
            ga: this._gaStatus,
            operations: this._operationsStatus
        };

    }

    _resolveMonitoringStatus() {

        if (!this._monitoringStatus) {

            return null;

        }

        return this._monitoringStatus;

    }

    _resolveRuntime() {

        if (!this._runtimeProvider) {

            return null;

        }

        try {

            return this._runtimeProvider();

        } catch (error) {

            this._logger.error(`Health runtime provider failed | ${error.message}`);

            return null;

        }

    }

    logStartupSummary(snapshot) {

        this._logger.info(
            `Startup complete | env=${snapshot.environment} | `
                + `duration=${snapshot.startupDurationMs}ms`
                + (snapshot.deployment?.profile
                    ? ` | profile=${snapshot.deployment.profile}`
                    : "")
        );

    }

}
