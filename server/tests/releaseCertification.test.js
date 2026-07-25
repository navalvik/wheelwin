/**
 * R8.0C — Release certification tests.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ReleaseManager } from "../release/ReleaseManager.js";
import {
    ReleaseCertificationManager,
    CERTIFICATION_STATUS,
    CHECK_STATUS
} from "../certification/ReleaseCertificationManager.js";
import { CertificationEvidence } from "../certification/CertificationEvidence.js";
import { CertificationChecklist } from "../certification/CertificationChecklist.js";
import { HealthService } from "../services/HealthService.js";
import { MonitoringManager } from "../monitoring/MonitoringManager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const repoRoot = resolve(__dirname, "../..");

async function main() {

    // --- Evidence immutability ---

    {
        const evidence = new CertificationEvidence({
            id: "t",
            name: "Test",
            category: "test",
            status: CHECK_STATUS.PASS,
            details: { a: 1 },
            recommendations: ["x"]
        });

        assert.ok(Object.isFrozen(evidence));

        assert.ok(Object.isFrozen(evidence.details));

        assert.throws(() => {

            evidence.details.a = 2;

        });

        console.log("  evidence immutability: OK");
    }

    // --- Checklist composition ---

    {
        const checklist = new CertificationChecklist();

        const list = checklist.list();

        assert.equal(list.length, 10);

        assert.ok(list.some((c) => c.id === "artifacts"));

        assert.ok(list.some((c) => c.id === "security"));

        console.log("  checklist: OK");
    }

    // --- Build + certify ---

    {
        ReleaseManager.resetForTests();

        ReleaseCertificationManager.resetForTests();

        MonitoringManager.resetForTests();

        const out = mkdtempSync(join(tmpdir(), "wheelwin-r80c-"));

        const releaseManager = ReleaseManager.getInstance();

        releaseManager.initialize({
            channel: "rc",
            outputDirectory: out,
            version: "1.0.0-rc1",
            commit: "certcommit",
            branch: "main",
            profile: "development",
            includeDocs: true,
            includeReports: true,
            repoRoot
        });

        const built = await releaseManager.createRelease();

        assert.equal(built.ok, true, built.errors?.join("; "));

        const certManager = ReleaseCertificationManager.getInstance();

        certManager.initialize({
            repoRoot,
            productionConfig: {
                deployment: {
                    profile: "development",
                    healthEnabled: true
                },
                monitoring: { enabled: true },
                failurePolicy: { enabled: true },
                release: { channel: "rc" },
                debugSimulationLoop: false,
                runStartupDemonstrations: true
            },
            profile: "development",
            tonConfig: {
                network: "testnet",
                deployMode: "stub",
                endpointConfigured: false,
                apiKeyConfigured: false,
                mnemonicConfigured: false
            },
            safeConfiguration: {
                profile: "development",
                developerConsole: {
                    authEnabled: true,
                    authConfigured: true
                }
            }
        });

        const result = await certManager.certify({
            releaseRoot: built.releaseRoot,
            expectedVersion: "1.0.0-rc1",
            expectedCommit: "certcommit",
            writeOutputs: true,
            writeDocsReport: false
        });

        assert.ok(
            result.status === CERTIFICATION_STATUS.PASSED
                || result.status === CERTIFICATION_STATUS.PASSED_WITH_WARNINGS,
            `Unexpected status ${result.status}`
        );

        assert.equal(result.ok, true);

        assert.equal(result.certificate.version, "1.0.0-rc1");

        assert.equal(result.certificate.fingerprint, built.metadata.fingerprint);

        assert.ok(result.certificate.evidenceHash);

        assert.equal(result.certificate.betaReady, true);

        assert.ok(
            existsSync(join(built.releaseRoot, "certification", "ReleaseCertificate.json"))
        );

        assert.ok(
            existsSync(join(built.releaseRoot, "certification", "Release-Certification-Report.md"))
        );

        const certJson = JSON.parse(
            readFileSync(
                join(built.releaseRoot, "certification", "ReleaseCertificate.json"),
                "utf8"
            )
        );

        assert.equal(certJson.evidenceHash, result.certificate.evidenceHash);

        // Reproducible: second certify yields same evidence hash for same package
        const result2 = await certManager.certify({
            releaseRoot: built.releaseRoot,
            expectedVersion: "1.0.0-rc1",
            expectedCommit: "certcommit",
            writeOutputs: false
        });

        assert.equal(result2.certificate.evidenceHash, result.certificate.evidenceHash);

        // Health safe status
        const health = new HealthService({
            logger: { error() {}, info() {} },
            productionConfig: { nodeEnv: "test" }
        });

        health.setCertificationStatus(certManager.getSafeStatus());

        const snap = health.getHealthSnapshot();

        assert.ok(snap.certification);

        assert.equal(snap.certification.betaReady, true);

        assert.ok(!JSON.stringify(snap.certification).includes(out));

        // Monitoring integration
        MonitoringManager.resetForTests();

        const monitoring = MonitoringManager.getInstance();

        monitoring.initialize({
            enabled: true,
            intervals: { systemMs: 20 },
            providers: {
                certificationManager: certManager,
                lifecycleState: () => "RUNNING",
                environment: () => "test",
                profile: () => "development",
                version: () => "1.0.0-rc1"
            }
        });

        await new Promise((r) => setTimeout(r, 50));

        const mSnap = monitoring.getSnapshot();

        assert.ok(mSnap.certification);

        assert.equal(mSnap.certification.betaReady, true);

        monitoring.shutdown();

        rmSync(out, { recursive: true, force: true });

        console.log("  certify release package: OK");
    }

    // --- Security failure on production + debug ---

    {
        ReleaseManager.resetForTests();

        ReleaseCertificationManager.resetForTests();

        const out = mkdtempSync(join(tmpdir(), "wheelwin-r80c-sec-"));

        const releaseManager = ReleaseManager.getInstance();

        releaseManager.initialize({
            channel: "rc",
            outputDirectory: out,
            version: "1.0.0-rc2",
            commit: "sec",
            branch: "main",
            profile: "production",
            repoRoot
        });

        const built = await releaseManager.createRelease();

        assert.equal(built.ok, true);

        const certManager = ReleaseCertificationManager.getInstance();

        certManager.initialize({
            repoRoot,
            productionConfig: {
                deployment: { profile: "production", healthEnabled: true },
                monitoring: { enabled: true },
                failurePolicy: { enabled: true },
                release: { channel: "rc" },
                debugSimulationLoop: true,
                runStartupDemonstrations: true
            },
            profile: "production",
            tonConfig: {
                network: "mainnet",
                deployMode: "stub",
                endpointConfigured: true,
                apiKeyConfigured: true,
                mnemonicConfigured: true
            },
            safeConfiguration: {
                profile: "production",
                developerConsole: { authEnabled: true, authConfigured: true }
            }
        });

        const result = await certManager.certify({
            releaseRoot: built.releaseRoot,
            writeOutputs: false
        });

        assert.equal(result.status, CERTIFICATION_STATUS.FAILED);

        assert.equal(result.ok, false);

        assert.ok(
            result.evidence.some((e) => e.id === "security" && e.status === "FAIL")
        );

        rmSync(out, { recursive: true, force: true });

        console.log("  security gate: OK");
    }

    ReleaseManager.resetForTests();

    ReleaseCertificationManager.resetForTests();

    MonitoringManager.resetForTests();

    console.log("releaseCertification.test.js: all passed");

}

main().catch((error) => {

    console.error(error);

    process.exit(1);

});
