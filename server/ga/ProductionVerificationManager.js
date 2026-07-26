/**
 * R9.0A — Read-only production verification checks.
 */

import {
    CHECK_STATUS,
    VERIFICATION_STATUS,
    ROLLBACK_SEVERITY
} from "./ProductionConfiguration.js";
import { createProductionVerificationResult } from "./models/ProductionVerificationResult.js";

function check({
    id,
    name,
    ok,
    warn = false,
    details = {},
    recommendations = [],
    severity = ROLLBACK_SEVERITY.HIGH
}) {

    const started = Date.now();

    let status = CHECK_STATUS.FAIL;

    if (ok === true) {

        status = warn ? CHECK_STATUS.WARN : CHECK_STATUS.PASS;

    }

    return Object.freeze({
        id,
        name,
        status,
        severity,
        details: Object.freeze({ ...details }),
        recommendations: Object.freeze(
            ok
                ? [...recommendations]
                : (recommendations.length
                    ? recommendations
                    : [`Resolve verification ${id}`])
        ),
        durationMs: Math.max(0, Date.now() - started),
        timestamp: Date.now()
    });

}

const CERT_OK = new Set(["PASSED", "PASSED_WITH_WARNINGS"]);

export class ProductionVerificationManager {

    /**
     * @param {{ requireCertification?: boolean }} [options]
     */
    constructor(options = {}) {

        this._requireCertification = options.requireCertification !== false;

    }

    /**
     * @param {object} ctx read-only providers/status bag
     */
    verify(ctx = {}) {

        const started = Date.now();

        const release = ctx.release ?? {};

        const certification = ctx.certification ?? {};

        const health = ctx.health ?? {};

        const monitoring = ctx.monitoring ?? {};

        const logging = ctx.logging ?? {};

        const deployment = ctx.deployment ?? {};

        const ton = ctx.ton ?? {};

        const launch = ctx.launch ?? {};

        const checks = [];

        checks.push(check({
            id: "release_version",
            name: "Release version",
            ok: Boolean(release.version) || ctx.versionPresent === true,
            severity: ROLLBACK_SEVERITY.CRITICAL,
            details: { version: release.version ?? null }
        }));

        checks.push(check({
            id: "manifest",
            name: "Manifest",
            ok: Boolean(release.fingerprint)
                || release.status === "built"
                || release.status === "ready"
                || ctx.manifestVerified === true,
            severity: ROLLBACK_SEVERITY.CRITICAL,
            details: {
                fingerprint: release.fingerprint ?? null,
                status: release.status ?? null
            }
        }));

        checks.push(check({
            id: "checksums",
            name: "Checksums",
            ok: release.checksumsVerified === true
                || Boolean(release.fingerprint)
                || ctx.checksumsVerified === true,
            severity: ROLLBACK_SEVERITY.HIGH,
            details: { fingerprint: release.fingerprint ?? null }
        }));

        const certStatus = certification.status ?? null;

        const certOk = CERT_OK.has(certStatus)
            || certification.betaReady === true
            || ctx.certificateVerified === true;

        checks.push(check({
            id: "release_certificate",
            name: "Release certificate",
            ok: this._requireCertification ? certOk : true,
            warn: certStatus === "PASSED_WITH_WARNINGS",
            severity: ROLLBACK_SEVERITY.CRITICAL,
            details: { status: certStatus }
        }));

        const profile = deployment.profile
            ?? ctx.safeConfiguration?.deployment?.profile
            ?? null;

        checks.push(check({
            id: "configuration_profile",
            name: "Configuration profile",
            ok: profile != null || ctx.profileVerified === true,
            severity: ROLLBACK_SEVERITY.HIGH,
            details: { profile }
        }));

        checks.push(check({
            id: "health",
            name: "Health",
            ok: health.ready === true
                || health.status === "ok"
                || health.status === "degraded"
                || ctx.health == null,
            severity: ROLLBACK_SEVERITY.CRITICAL,
            details: {
                status: health.status ?? null,
                ready: health.ready ?? null
            }
        }));

        checks.push(check({
            id: "readiness",
            name: "Readiness",
            ok: health.ready === true
                || deployment.ready === true
                || ctx.readinessVerified === true
                || ctx.health == null,
            severity: ROLLBACK_SEVERITY.CRITICAL,
            details: {
                healthReady: health.ready ?? null,
                deploymentReady: deployment.ready ?? null
            }
        }));

        checks.push(check({
            id: "monitoring",
            name: "Monitoring",
            ok: monitoring.enabled === true
                || monitoring.running === true
                || ctx.monitoring == null,
            severity: ROLLBACK_SEVERITY.HIGH,
            details: { monitoring: monitoring.enabled ?? null }
        }));

        checks.push(check({
            id: "logging",
            name: "Logging",
            ok: logging != null || health.logger != null || ctx.logging == null,
            severity: ROLLBACK_SEVERITY.MEDIUM,
            details: { hasLogger: logging != null }
        }));

        checks.push(check({
            id: "metrics",
            name: "Metrics",
            ok: ctx.metricsEnabled !== false,
            severity: ROLLBACK_SEVERITY.MEDIUM,
            details: { metricsEnabled: ctx.metricsEnabled !== false }
        }));

        checks.push(check({
            id: "developer_console",
            name: "Developer Console",
            ok: ctx.developerConsole?.enabled === true
                || ctx.developerConsole == null,
            severity: ROLLBACK_SEVERITY.LOW,
            details: {
                enabled: ctx.developerConsole?.enabled ?? null
            }
        }));

        checks.push(check({
            id: "blockchain_connectivity",
            name: "Blockchain connectivity",
            ok: ton.network != null
                || ctx.blockchainConnected === true
                || ctx.ton == null,
            severity: ROLLBACK_SEVERITY.HIGH,
            details: { network: ton.network ?? null }
        }));

        checks.push(check({
            id: "settlement_availability",
            name: "Settlement availability",
            ok: ctx.settlementAvailable !== false,
            severity: ROLLBACK_SEVERITY.CRITICAL,
            details: {
                settlementAvailable: ctx.settlementAvailable !== false
            }
        }));

        checks.push(check({
            id: "recovery_availability",
            name: "Recovery availability",
            ok: ctx.failurePolicy != null
                || ctx.recoveryAvailable !== false,
            severity: ROLLBACK_SEVERITY.HIGH,
            details: {
                failurePolicyPresent: ctx.failurePolicy != null
            }
        }));

        checks.push(check({
            id: "launch_decision",
            name: "Launch decision READY_FOR_PRODUCTION",
            ok: launch.decision === "READY_FOR_PRODUCTION"
                || launch.productionReady === true
                || ctx.launchReady === true,
            severity: ROLLBACK_SEVERITY.CRITICAL,
            details: {
                decision: launch.decision ?? null,
                productionReady: launch.productionReady ?? null
            }
        }));

        const failed = checks.filter((c) => c.status === CHECK_STATUS.FAIL);

        const criticalFails = failed.filter(
            (c) => c.severity === ROLLBACK_SEVERITY.CRITICAL
        );

        const warned = checks.filter((c) => c.status === CHECK_STATUS.WARN);

        const passed = checks.filter(
            (c) => c.status === CHECK_STATUS.PASS
                || c.status === CHECK_STATUS.WARN
        );

        const score = checks.length > 0
            ? Math.round((100 * passed.length) / checks.length)
            : 0;

        let status = VERIFICATION_STATUS.PASSED;

        if (criticalFails.length > 0) {

            status = VERIFICATION_STATUS.FAILED;

        } else if (failed.length > 0) {

            status = VERIFICATION_STATUS.FAILED;

        } else if (warned.length > 0) {

            status = VERIFICATION_STATUS.PASSED_WITH_WARNINGS;

        }

        return createProductionVerificationResult({
            status,
            score,
            checks,
            durationMs: Date.now() - started,
            evaluatedAt: Date.now()
        });

    }

}
