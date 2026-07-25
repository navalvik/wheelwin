/**
 * R8.0B — Verify release package integrity.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ChecksumGenerator } from "./ChecksumGenerator.js";
import { BuildFingerprint } from "./BuildFingerprint.js";
import { ReleaseVersionManager } from "./ReleaseVersionManager.js";

export class ReleaseIntegrityVerifier {

    /**
     * @param {{
     *   releaseRoot: string,
     *   knownVersions?: Set<string>
     * }} options
     */
    constructor({ releaseRoot, knownVersions = new Set() }) {

        this._root = releaseRoot;

        this._knownVersions = knownVersions;

    }

    /**
     * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
     */
    async verify() {

        const errors = [];

        const warnings = [];

        const manifestPath = join(this._root, "manifests", "ReleaseManifest.json");

        const checksumPath = join(this._root, "checksums", "SHA256SUMS");

        const notesPath = join(
            this._root,
            "release-notes",
            "RELEASE_NOTES.md"
        );

        if (!existsSync(manifestPath)) {

            errors.push("Missing manifests/ReleaseManifest.json");

        }

        if (!existsSync(checksumPath)) {

            errors.push("Missing checksums/SHA256SUMS");

        }

        if (!existsSync(notesPath)) {

            errors.push("Missing release-notes/RELEASE_NOTES.md");

        }

        if (errors.length) {

            return { ok: false, errors, warnings };

        }

        let manifest;

        try {

            manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

        } catch (error) {

            errors.push(`Invalid manifest JSON: ${error.message}`);

            return { ok: false, errors, warnings };

        }

        if (!ReleaseVersionManager.isValid(manifest.version)) {

            errors.push(`Invalid version in manifest: ${manifest.version}`);

        }

        if (this._knownVersions.has(manifest.version)) {

            errors.push(`Duplicate version: ${manifest.version}`);

        }

        const requiredDirs = ["server", "client", "documentation"];

        for (const dir of requiredDirs) {

            if (!existsSync(join(this._root, dir))) {

                errors.push(`Missing artifact directory: ${dir}`);

            }

        }

        const checksumEntries = ChecksumGenerator.readChecksumFile(checksumPath);

        if (checksumEntries.length === 0) {

            errors.push("Checksum file is empty");

        }

        const byPath = new Map(
            checksumEntries.map((e) => [e.path.replace(/\\/g, "/"), e.sha256])
        );

        for (const artifact of manifest.artifacts ?? []) {

            const rel = String(artifact.path).replace(/\\/g, "/");

            const abs = join(this._root, rel);

            if (!existsSync(abs)) {

                errors.push(`Artifact missing on disk: ${rel}`);

                continue;

            }

            const expected = byPath.get(rel) ?? artifact.sha256;

            if (!expected) {

                errors.push(`No checksum for artifact: ${rel}`);

                continue;

            }

            const actual = await ChecksumGenerator.hashFile(abs);

            if (actual !== expected) {

                errors.push(`Checksum mismatch: ${rel}`);

            }

        }

        const globalExpected = manifest.checksums?.global;

        if (globalExpected) {

            const globalActual = ChecksumGenerator.hashManifestEntries(
                checksumEntries.map((e) => ({
                    path: e.path,
                    sha256: e.sha256
                }))
            );

            if (globalActual !== globalExpected) {

                errors.push("Global release checksum mismatch");

            }

        }

        const fingerprintExpected = manifest.build?.fingerprint;

        if (fingerprintExpected) {

            const fingerprintActual = BuildFingerprint.generate({
                version: manifest.version,
                commit: manifest.build?.commit,
                channel: manifest.channel,
                profile: manifest.build?.profile,
                artifactHashes: checksumEntries,
                nodeVersion: manifest.build?.nodeVersion
            });

            if (fingerprintActual !== fingerprintExpected) {

                errors.push("Build fingerprint mismatch");

            }

        }

        if (!(manifest.documentation?.length > 0)) {

            warnings.push("Manifest lists no documentation entries");

        }

        return {
            ok: errors.length === 0,
            errors,
            warnings,
            manifest
        };

    }

}
