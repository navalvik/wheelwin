/**
 * R8.0B — Orchestrates the release build pipeline.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ReleaseArtifactManager } from "./ReleaseArtifactManager.js";
import { ReleaseManifestBuilder } from "./ReleaseManifestBuilder.js";
import { ReleaseIntegrityVerifier } from "./ReleaseIntegrityVerifier.js";
import { ReleaseVersionManager } from "./ReleaseVersionManager.js";
import { ReleaseMetadata } from "./ReleaseMetadata.js";
import { ReleaseNotesGenerator } from "./ReleaseNotesGenerator.js";
import { ChecksumGenerator } from "./ChecksumGenerator.js";
import { BuildFingerprint } from "./BuildFingerprint.js";
import { isValidReleaseChannel } from "./releaseTypes.js";

export class ReleaseBuilder {

    /**
     * @param {{
     *   repoRoot: string,
     *   outputDirectory: string,
     *   version: string,
     *   channel: string,
     *   profile?: string,
     *   commit?: string,
     *   branch?: string,
     *   packageVersion?: string,
     *   includeDocs?: boolean,
     *   includeReports?: boolean,
     *   generateChecksums?: boolean,
     *   logger?: { info?: Function, warn?: Function, error?: Function } | null,
     *   onEvent?: (event: string, fields?: object) => void
     * }} options
     */
    constructor(options) {

        this._options = options;

        this._logger = options.logger ?? null;

        this._onEvent = options.onEvent ?? null;

    }

    /**
     * @returns {Promise<{
     *   ok: boolean,
     *   releaseRoot: string,
     *   metadata: ReleaseMetadata,
     *   manifest: object,
     *   verification: object,
     *   errors: string[]
     * }>}
     */
    async build() {

        const errors = [];

        const {
            repoRoot,
            outputDirectory,
            version,
            channel,
            profile = "production",
            commit = "unknown",
            branch = "unknown",
            packageVersion = version,
            includeDocs = true,
            includeReports = true,
            generateChecksums = true
        } = this._options;

        this._emit("release_started", { version, channel });

        if (!ReleaseVersionManager.isValid(version)) {

            errors.push(`Invalid semantic version: ${version}`);

        }

        if (!isValidReleaseChannel(channel)) {

            errors.push(`Invalid release channel: ${channel}`);

        }

        if (errors.length) {

            return {
                ok: false,
                releaseRoot: null,
                metadata: null,
                manifest: null,
                verification: { ok: false, errors, warnings: [] },
                errors
            };

        }

        const label = ReleaseVersionManager.buildLabel(version, channel);

        const releaseRoot = join(outputDirectory, label);

        mkdirSync(releaseRoot, { recursive: true });

        // Duplicate version guard: same label directory with existing verified manifest
        const existingManifest = join(
            releaseRoot,
            "manifests",
            "ReleaseManifest.json"
        );

        const knownVersions = new Set();

        if (existsSync(existingManifest)) {

            try {

                const prev = JSON.parse(readFileSync(existingManifest, "utf8"));

                if (prev.version === version && prev.build?.fingerprint) {

                    // Rebuilding same version path — allowed, overwrites; warn
                    this._logger?.warn?.(
                        `Rebuilding existing release directory for ${version}`
                    );

                }

            } catch {
                // ignore
            }

        }

        const artifacts = new ReleaseArtifactManager({
            repoRoot,
            outputRoot: releaseRoot,
            includeDocs,
            includeReports
        });

        artifacts.ensureLayout();

        this._emit("build_validation", { version, channel, releaseRoot });

        const serverFiles = await artifacts.packageServer();

        this._emit("artifacts_generated", { kind: "server", count: serverFiles.length });

        const clientFiles = await artifacts.packageClient();

        this._emit("artifacts_generated", { kind: "client", count: clientFiles.length });

        const docFiles = await artifacts.packageDocumentation();

        this._emit("artifacts_generated", { kind: "documentation", count: docFiles.length });

        const allFiles = [...serverFiles, ...clientFiles, ...docFiles];

        if (allFiles.length === 0) {

            errors.push("No artifacts packaged");

            return {
                ok: false,
                releaseRoot,
                metadata: null,
                manifest: null,
                verification: { ok: false, errors, warnings: [] },
                errors
            };

        }

        let hashed = await artifacts.hashArtifacts(allFiles);

        if (!generateChecksums) {

            hashed = hashed.map((h) => ({ ...h, sha256: h.sha256 }));

        }

        const checksumEntries = hashed.map((h) => ({
            path: h.path,
            sha256: h.sha256
        }));

        const globalChecksum = ChecksumGenerator.hashManifestEntries(checksumEntries);

        const builtAt = new Date().toISOString();

        const fingerprint = BuildFingerprint.generate({
            version,
            commit,
            channel,
            profile,
            artifactHashes: checksumEntries,
            nodeVersion: process.version
        });

        const metadata = new ReleaseMetadata({
            version,
            channel,
            commit,
            branch,
            builtAt,
            nodeVersion: process.version,
            packageVersion,
            profile,
            fingerprint,
            globalChecksum,
            label,
            status: "built"
        });

        ChecksumGenerator.writeChecksumFile(
            join(releaseRoot, "checksums", "SHA256SUMS"),
            checksumEntries
        );

        this._emit("checksums_generated", {
            count: checksumEntries.length,
            globalChecksum
        });

        const notes = ReleaseNotesGenerator.generate({
            version,
            channel,
            commit,
            builtAt,
            fingerprint,
            validationStatus: "Attach R7.0H report; re-run validate:production on tag"
        });

        writeFileSync(
            join(releaseRoot, "release-notes", "RELEASE_NOTES.md"),
            notes,
            "utf8"
        );

        const manifest = ReleaseManifestBuilder.build({
            metadata,
            artifacts: hashed.map((h) => ({
                path: h.path,
                sha256: h.sha256,
                bytes: h.bytes,
                kind: h.kind
            })),
            documentation: docFiles.map((f) => f.path.replace(/\\/g, "/")),
            checksumsFile: "checksums/SHA256SUMS",
            notesFile: "release-notes/RELEASE_NOTES.md",
            compatibility: { node: ">=18" }
        });

        writeFileSync(
            join(releaseRoot, "manifests", "ReleaseManifest.json"),
            JSON.stringify(manifest, null, 2) + "\n",
            "utf8"
        );

        writeFileSync(
            join(releaseRoot, "manifests", "ReleaseMetadata.json"),
            JSON.stringify(metadata.toJSON(), null, 2) + "\n",
            "utf8"
        );

        this._emit("manifest_generated", {
            version,
            fingerprint,
            artifacts: hashed.length
        });

        const verifier = new ReleaseIntegrityVerifier({
            releaseRoot,
            knownVersions
        });

        const verification = await verifier.verify();

        this._emit("release_verified", {
            ok: verification.ok,
            errors: verification.errors,
            warnings: verification.warnings
        });

        if (!verification.ok) {

            return {
                ok: false,
                releaseRoot,
                metadata,
                manifest,
                verification,
                errors: verification.errors
            };

        }

        const verifiedMetadata = new ReleaseMetadata({
            ...metadata.toJSON(),
            status: "verified"
        });

        writeFileSync(
            join(releaseRoot, "manifests", "ReleaseMetadata.json"),
            JSON.stringify(verifiedMetadata.toJSON(), null, 2) + "\n",
            "utf8"
        );

        this._emit("release_completed", {
            version,
            channel,
            releaseRoot,
            fingerprint
        });

        return {
            ok: true,
            releaseRoot,
            metadata: verifiedMetadata,
            manifest,
            verification,
            errors: []
        };

    }

    _emit(event, fields = {}) {

        this._onEvent?.(event, fields);

        this._logger?.info?.(
            `ReleaseBuilder ${event} | ${JSON.stringify(fields)}`
        );

    }

}
