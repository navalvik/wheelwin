/**
 * R7.0G — Deployment profile presets (development / staging / production).
 */

export const DEPLOYMENT_PROFILES = Object.freeze({
    DEVELOPMENT: "development",
    STAGING: "staging",
    PRODUCTION: "production"
});

const PROFILE_DEFAULTS = Object.freeze({
    development: Object.freeze({
        name: DEPLOYMENT_PROFILES.DEVELOPMENT,
        probeRefreshIntervalMs: 1000,
        cacheControl: "no-store",
        verboseDiagnostics: true,
        readinessStrict: false
    }),
    staging: Object.freeze({
        name: DEPLOYMENT_PROFILES.STAGING,
        probeRefreshIntervalMs: 2000,
        cacheControl: "no-cache",
        verboseDiagnostics: true,
        readinessStrict: true
    }),
    production: Object.freeze({
        name: DEPLOYMENT_PROFILES.PRODUCTION,
        probeRefreshIntervalMs: 5000,
        cacheControl: "no-cache, max-age=1",
        verboseDiagnostics: false,
        readinessStrict: true
    })
});

export class DeploymentProfile {

    /**
     * @param {string} name
     * @param {object} [overrides]
     */
    constructor(name, overrides = {}) {

        const key = String(name || DEPLOYMENT_PROFILES.DEVELOPMENT)
            .trim()
            .toLowerCase();

        const base = PROFILE_DEFAULTS[key] ?? PROFILE_DEFAULTS.development;

        this.name = base.name;

        this.probeRefreshIntervalMs = Number.isFinite(overrides.probeRefreshIntervalMs)
            ? Math.max(50, overrides.probeRefreshIntervalMs)
            : base.probeRefreshIntervalMs;

        this.cacheControl = typeof overrides.cacheControl === "string"
            ? overrides.cacheControl
            : base.cacheControl;

        this.verboseDiagnostics = overrides.verboseDiagnostics != null
            ? overrides.verboseDiagnostics === true
            : base.verboseDiagnostics;

        this.readinessStrict = overrides.readinessStrict != null
            ? overrides.readinessStrict === true
            : base.readinessStrict;

        Object.freeze(this);

    }

    static resolve(name, overrides = {}) {

        return new DeploymentProfile(name, overrides);

    }

    static isValidName(name) {

        const key = String(name || "").trim().toLowerCase();

        return Object.prototype.hasOwnProperty.call(PROFILE_DEFAULTS, key);

    }

    toSafeSummary() {

        return Object.freeze({
            name: this.name,
            probeRefreshIntervalMs: this.probeRefreshIntervalMs,
            cacheControl: this.cacheControl,
            verboseDiagnostics: this.verboseDiagnostics,
            readinessStrict: this.readinessStrict
        });

    }

}
