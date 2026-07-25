/**
 * R8.0C — Artifact / manifest / checksum / fingerprint checks.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CertificationCheck } from "./CertificationCheck.js";
import { CHECK_STATUS } from "../CertificationStatus.js";
import { ReleaseIntegrityVerifier } from "../../release/ReleaseIntegrityVerifier.js";
import { ReleaseVersionManager } from "../../release/ReleaseVersionManager.js";

export class ArtifactCheck extends CertificationCheck {

    constructor() {

        super({
            id: "artifacts",
            name: "Release Artifacts & Manifest",
            category: "artifacts"
        });

    }

    async run(context) {

        const root = context.releaseRoot;

        if (!root || !existsSync(root)) {

            return {
                status: CHECK_STATUS.FAIL,
                details: { releaseRoot: root ?? null },
                recommendations: [
                    "Build an RC with `npm run release:build` before certification"
                ]
            };

        }

        const required = [
            "manifests/ReleaseManifest.json",
            "manifests/ReleaseMetadata.json",
            "checksums/SHA256SUMS",
            "release-notes/RELEASE_NOTES.md",
            "server",
            "client",
            "documentation"
        ];

        const missing = required.filter((rel) => !existsSync(join(root, rel)));

        if (missing.length) {

            return {
                status: CHECK_STATUS.FAIL,
                details: { missing },
                recommendations: ["Rebuild release package; required artifacts missing"]
            };

        }

        const verifier = new ReleaseIntegrityVerifier({ releaseRoot: root });

        const verification = await verifier.verify();

        if (!verification.ok) {

            return {
                status: CHECK_STATUS.FAIL,
                details: {
                    errors: verification.errors,
                    warnings: verification.warnings
                },
                recommendations: [
                    "Fix checksum / fingerprint mismatches then rebuild"
                ]
            };

        }

        const manifest = verification.manifest;

        const versionOk = ReleaseVersionManager.isValid(manifest.version);

        const notes = readFileSync(
            join(root, "release-notes", "RELEASE_NOTES.md"),
            "utf8"
        );

        const warnings = [...(verification.warnings ?? [])];

        if (!notes.includes(manifest.version)) {

            warnings.push("Release notes do not mention version string");

        }

        return {
            status: warnings.length ? CHECK_STATUS.WARN : CHECK_STATUS.PASS,
            details: {
                version: manifest.version,
                channel: manifest.channel,
                fingerprint: manifest.build?.fingerprint ?? null,
                artifactCount: manifest.artifacts?.length ?? 0,
                versionOk,
                integrityOk: true
            },
            recommendations: warnings.length
                ? ["Review release notes completeness"]
                : []
        };

    }

}
