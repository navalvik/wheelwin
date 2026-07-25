/**
 * R7.0G — Deployment coordinator (profile + health subsystem).
 */

import { DeploymentProfile } from "./DeploymentProfile.js";
import { HealthManager } from "./HealthManager.js";

export class DeploymentManager {

    static _instance = null;

    constructor() {

        this._profile = null;

        this._healthManager = null;

        this._config = null;

    }

    static getInstance() {

        if (!DeploymentManager._instance) {

            DeploymentManager._instance = new DeploymentManager();

        }

        return DeploymentManager._instance;

    }

    static resetForTests() {

        if (DeploymentManager._instance) {

            DeploymentManager._instance.shutdown();

        }

        DeploymentManager._instance = null;

        HealthManager.resetForTests();

    }

    /**
     * @param {{
     *   deployment?: object,
     *   providers?: object
     * }} input
     */
    initialize({ deployment = {}, providers = {} } = {}) {

        this.shutdown();

        this._config = deployment;

        this._profile = DeploymentProfile.resolve(
            deployment.profile ?? "development",
            {
                probeRefreshIntervalMs: deployment.probeRefreshIntervalMs
            }
        );

        this._healthManager = HealthManager.getInstance();

        this._healthManager.initialize({
            enabled: deployment.healthEnabled !== false,
            profile: this._profile,
            probeRefreshIntervalMs: deployment.probeRefreshIntervalMs
                ?? this._profile.probeRefreshIntervalMs,
            readinessEnabled: deployment.readinessEnabled !== false,
            livenessEnabled: deployment.livenessEnabled !== false,
            startupEnabled: deployment.startupEnabled !== false,
            providers
        });

        return this;

    }

    getProfile() {

        return this._profile;

    }

    getHealthManager() {

        return this._healthManager;

    }

    getCacheControl() {

        return this._profile?.cacheControl ?? "no-store";

    }

    getSafeStatus() {

        return Object.freeze({
            profile: this._profile?.toSafeSummary?.() ?? null,
            health: this._healthManager?.getSafeStatus?.() ?? null
        });

    }

    shutdown() {

        this._healthManager?.shutdown?.();

        this._healthManager = null;

    }

}
