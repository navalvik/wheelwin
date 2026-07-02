export class HealthService {

    constructor({ logger, productionConfig }) {

        this._logger = logger;

        this._productionConfig = productionConfig;

        this._startedAt = Date.now();

        this._startupDurationMs = null;

        this._shuttingDown = false;

        this._componentRegistry = null;

    }

    markStartupComplete(durationMs) {

        this._startupDurationMs = durationMs;

    }

    markShuttingDown() {

        this._shuttingDown = true;

    }

    registerComponents(components) {

        this._componentRegistry = components;

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

        const healthy = !this._shuttingDown
            && Object.values(components).every((ready) => ready === true);

        return {
            status: healthy ? "ok" : "degraded",
            environment: this._productionConfig.nodeEnv,
            uptimeMs,
            startupDurationMs: this._startupDurationMs,
            shuttingDown: this._shuttingDown,
            components
        };

    }

    logStartupSummary(snapshot) {

        this._logger.info(
            `Startup complete | env=${snapshot.environment} | `
                + `duration=${snapshot.startupDurationMs}ms`
        );

    }

}
