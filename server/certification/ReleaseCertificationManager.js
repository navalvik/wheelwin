/**
 * R8.0C — Release Candidate certification coordinator (read-only).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ChecksumGenerator } from "../release/ChecksumGenerator.js";
import { CertificationChecklist } from "./CertificationChecklist.js";
import { CertificationRunner } from "./CertificationRunner.js";
import { CertificationReportBuilder } from "./CertificationReportBuilder.js";
import { CertificationRegistry } from "./CertificationRegistry.js";
import {
    CERTIFICATION_STATUS,
    isCertifiableStatus
} from "./CertificationStatus.js";
import { LoggingManager } from "../logging/LoggingManager.js";
import { LOG_LEVELS } from "../logging/levels.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class ReleaseCertificationManager {

    static _instance = null;

    constructor() {

        this._status = CERTIFICATION_STATUS.NOT_CERTIFIED;

        this._registry = new CertificationRegistry();

        this._lastResult = null;

        this._repoRoot = resolve(__dirname, "../..");

        this._providers = null;

        this._config = null;

    }

    static getInstance() {

        if (!ReleaseCertificationManager._instance) {

            ReleaseCertificationManager._instance = new ReleaseCertificationManager();

        }

        return ReleaseCertificationManager._instance;

    }

    static resetForTests() {

        ReleaseCertificationManager._instance = null;

    }

    /**
     * @param {{
     *   repoRoot?: string,
     *   providers?: object,
     *   productionConfig?: object,
     *   runtimeConfig?: object,
     *   tonConfig?: object,
     *   safeConfiguration?: object,
     *   profile?: string
     * }} config
     */
    initialize(config = {}) {

        this._config = config;

        if (config.repoRoot) {

            this._repoRoot = config.repoRoot;

        }

        this._providers = config.providers ?? null;

        this._registry.loadFromDisk();

        const latest = this._registry.getLatest();

        if (latest?.status) {

            this._status = latest.status;

            this._lastResult = { certificate: latest };

        }

        return this;

    }

    getStatus() {

        return this._status;

    }

    /**
     * Certify a release package directory (read-only).
     *
     * @param {{
     *   releaseRoot: string,
     *   expectedVersion?: string,
     *   expectedCommit?: string,
     *   writeOutputs?: boolean,
     *   reportPath?: string
     * }} input
     */
    async certify(input) {

        this._status = CERTIFICATION_STATUS.RUNNING;

        this._log("info", "Certification started", {
            releaseRoot: input.releaseRoot ? "[set]" : null
        });

        const manifestPath = join(
            input.releaseRoot,
            "manifests",
            "ReleaseManifest.json"
        );

        let manifest = null;

        if (existsSync(manifestPath)) {

            try {

                manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

            } catch (error) {

                this._status = CERTIFICATION_STATUS.FAILED;

                return {
                    ok: false,
                    status: this._status,
                    errors: [`Invalid manifest: ${error.message}`]
                };

            }

        }

        const checklist = new CertificationChecklist();

        const runner = new CertificationRunner({ checklist });

        const context = {
            repoRoot: this._repoRoot,
            releaseRoot: input.releaseRoot,
            manifest,
            expectedVersion: input.expectedVersion ?? manifest?.version ?? null,
            expectedCommit: input.expectedCommit
                ?? manifest?.build?.commit
                ?? null,
            productionConfig: this._config?.productionConfig ?? null,
            runtimeConfig: this._config?.runtimeConfig ?? null,
            tonConfig: this._config?.tonConfig
                ?? this._config?.runtimeConfig?.ton
                ?? null,
            safeConfiguration: this._config?.safeConfiguration ?? null,
            profile: this._config?.profile
                ?? this._config?.productionConfig?.deployment?.profile
                ?? null,
            providers: this._providers
        };

        const run = await runner.run(context);

        const evidenceJson = run.evidence.map((e) => e.toJSON());

        const evidenceHash = ChecksumGenerator.hashBuffer(
            JSON.stringify(
                evidenceJson.map((e) => ({
                    id: e.id,
                    name: e.name,
                    category: e.category,
                    status: e.status,
                    details: e.details,
                    recommendations: e.recommendations
                }))
            )
        );

        const certificate = Object.freeze({
            schemaVersion: 1,
            version: manifest?.version ?? input.expectedVersion ?? "unknown",
            channel: manifest?.channel ?? "unknown",
            status: run.status,
            certifiedAt: new Date().toISOString(),
            commit: manifest?.build?.commit ?? input.expectedCommit ?? "unknown",
            fingerprint: manifest?.build?.fingerprint ?? "unknown",
            evidenceHash,
            durationMs: run.durationMs,
            summary: Object.freeze({ ...run.summary }),
            checklist: Object.freeze(
                evidenceJson.map((e) => Object.freeze({
                    id: e.id,
                    name: e.name,
                    status: e.status
                }))
            ),
            betaReady: isCertifiableStatus(run.status)
        });

        this._status = run.status;

        this._registry = new CertificationRegistry({
            storageDirectory: input.writeOutputs === false
                ? null
                : join(input.releaseRoot, "certification")
        });

        this._registry.register(certificate);

        const report = new CertificationReportBuilder().build({
            certificate,
            evidence: evidenceJson,
            summary: run.summary
        });

        let reportPath = input.reportPath ?? null;

        if (input.writeOutputs !== false) {

            const certDir = join(input.releaseRoot, "certification");

            mkdirSync(certDir, { recursive: true });

            writeFileSync(
                join(certDir, "ReleaseCertificate.json"),
                JSON.stringify(certificate, null, 2) + "\n",
                "utf8"
            );

            writeFileSync(
                join(certDir, "CertificationEvidence.json"),
                JSON.stringify(evidenceJson, null, 2) + "\n",
                "utf8"
            );

            writeFileSync(
                join(certDir, "Release-Certification-Report.md"),
                report,
                "utf8"
            );

            if (input.writeDocsReport !== false) {

                // Canonical docs/release copy
                const docsRelease = join(this._repoRoot, "docs", "release");

                mkdirSync(docsRelease, { recursive: true });

                reportPath = join(docsRelease, "Release-Certification-Report.md");

                writeFileSync(reportPath, report, "utf8");

                writeFileSync(
                    join(docsRelease, "ReleaseCertificate.json"),
                    JSON.stringify(certificate, null, 2) + "\n",
                    "utf8"
                );

            } else {

                reportPath = join(certDir, "Release-Certification-Report.md");

            }

        }

        this._lastResult = {
            certificate,
            evidence: evidenceJson,
            report,
            reportPath,
            summary: run.summary
        };

        this._log(
            isCertifiableStatus(run.status) ? "info" : "warn",
            "Certification completed",
            {
                status: run.status,
                version: certificate.version,
                evidenceHash
            }
        );

        return {
            ok: isCertifiableStatus(run.status),
            status: run.status,
            certificate,
            evidence: evidenceJson,
            report,
            reportPath,
            summary: run.summary
        };

    }

    getSafeStatus() {

        const cert = this._lastResult?.certificate
            ?? this._registry.getLatest()
            ?? null;

        return Object.freeze({
            status: this._status,
            version: cert?.version ?? null,
            channel: cert?.channel ?? null,
            certifiedAt: cert?.certifiedAt ?? null,
            fingerprint: cert?.fingerprint ?? null,
            evidenceHash: cert?.evidenceHash ?? null,
            betaReady: cert?.betaReady === true,
            warnings: cert?.summary?.warnings ?? 0,
            failures: cert?.summary?.failures ?? 0,
            durationMs: cert?.durationMs ?? null
        });

    }

    getLastResult() {

        return this._lastResult;

    }

    _log(level, message, fields) {

        const manager = LoggingManager.getInstance();

        if (!manager.isInitialized()) {

            return;

        }

        manager.write({
            level: level === "warn" ? LOG_LEVELS.WARN : LOG_LEVELS.INFO,
            service: "wheelwin-certification",
            message,
            fields
        });

    }

}

export {
    CERTIFICATION_STATUS,
    CHECK_STATUS,
    isCertifiableStatus
} from "./CertificationStatus.js";
