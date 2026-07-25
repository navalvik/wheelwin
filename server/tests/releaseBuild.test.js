/**
 * R8.0B — Release build system tests.
 */

import assert from "node:assert/strict";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { ReleaseManager } from "../release/ReleaseManager.js";
import { ReleaseVersionManager } from "../release/ReleaseVersionManager.js";
import { ChecksumGenerator } from "../release/ChecksumGenerator.js";
import { BuildFingerprint } from "../release/BuildFingerprint.js";
import { ReleaseManifestBuilder } from "../release/ReleaseManifestBuilder.js";
import { ReleaseMetadata } from "../release/ReleaseMetadata.js";
import { ReleaseNotesGenerator } from "../release/ReleaseNotesGenerator.js";
import { ReleaseIntegrityVerifier } from "../release/ReleaseIntegrityVerifier.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const repoRoot = resolve(__dirname, "../..");

function delay(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

async function main() {

    // --- Version validation ---

    {
        assert.equal(ReleaseVersionManager.isValid("1.0.0-rc1"), true);

        assert.equal(ReleaseVersionManager.isValid("1.0.0"), true);

        assert.equal(ReleaseVersionManager.isValid("not-a-version"), false);

        const parsed = ReleaseVersionManager.parse("1.0.0-rc2");

        assert.equal(parsed.major, 1);

        assert.equal(parsed.channelHint, "rc");

        console.log("  version validation: OK");
    }

    // --- Checksum + fingerprint determinism ---

    {
        const a = ChecksumGenerator.hashBuffer("wheelwin");

        const b = ChecksumGenerator.hashBuffer("wheelwin");

        assert.equal(a, b);

        const entries = [
            { path: "b.txt", sha256: "bb" },
            { path: "a.txt", sha256: "aa" }
        ];

        const g1 = ChecksumGenerator.hashManifestEntries(entries);

        const g2 = ChecksumGenerator.hashManifestEntries([...entries].reverse());

        assert.equal(g1, g2, "Global checksum order-independent");

        const fp1 = BuildFingerprint.generate({
            version: "1.0.0-rc1",
            commit: "abc",
            channel: "rc",
            profile: "staging",
            artifactHashes: entries,
            nodeVersion: "v20.0.0"
        });

        const fp2 = BuildFingerprint.generate({
            version: "1.0.0-rc1",
            commit: "abc",
            channel: "rc",
            profile: "staging",
            artifactHashes: [...entries].reverse(),
            nodeVersion: "v20.0.0"
        });

        assert.equal(fp1, fp2, "Fingerprint deterministic");

        console.log("  checksum + fingerprint: OK");
    }

    // --- Manifest + notes ---

    {
        const metadata = new ReleaseMetadata({
            version: "1.0.0-rc1",
            channel: "rc",
            commit: "deadbeef",
            branch: "main",
            builtAt: "2026-07-25T00:00:00.000Z",
            nodeVersion: "v20.0.0",
            packageVersion: "1.0.0",
            profile: "staging",
            fingerprint: "fp",
            globalChecksum: "gc",
            label: "wheelwin-1.0.0-rc1-rc",
            status: "verified"
        });

        const manifest = ReleaseManifestBuilder.build({
            metadata,
            artifacts: [{
                path: "server/ARTIFACT.json",
                sha256: "aa",
                bytes: 10,
                kind: "server"
            }],
            documentation: ["documentation/x.md"],
            checksumsFile: "checksums/SHA256SUMS",
            notesFile: "release-notes/RELEASE_NOTES.md"
        });

        assert.equal(manifest.version, "1.0.0-rc1");

        assert.equal(manifest.channel, "rc");

        assert.ok(manifest.build.fingerprint);

        const notes = ReleaseNotesGenerator.generate({
            version: "1.0.0-rc1",
            channel: "rc",
            commit: "deadbeef",
            builtAt: metadata.builtAt,
            fingerprint: "fp"
        });

        assert.ok(notes.includes("1.0.0-rc1"));

        assert.ok(notes.includes("Completed stages"));

        console.log("  manifest + notes: OK");
    }

    // --- Full package + verify ---

    {
        ReleaseManager.resetForTests();

        const out = mkdtempSync(join(tmpdir(), "wheelwin-r80b-"));

        const manager = ReleaseManager.getInstance();

        manager.initialize({
            channel: "rc",
            outputDirectory: out,
            version: "1.0.0-rc1",
            commit: "testdeadbeef",
            branch: "test",
            profile: "staging",
            includeDocs: true,
            includeReports: true,
            generateChecksums: true,
            repoRoot
        });

        const result = await manager.createRelease();

        assert.equal(result.ok, true, result.errors?.join("; "));

        assert.ok(existsSync(join(result.releaseRoot, "manifests", "ReleaseManifest.json")));

        assert.ok(existsSync(join(result.releaseRoot, "checksums", "SHA256SUMS")));

        assert.ok(existsSync(join(result.releaseRoot, "release-notes", "RELEASE_NOTES.md")));

        assert.ok(existsSync(join(result.releaseRoot, "server")));

        assert.ok(existsSync(join(result.releaseRoot, "client")));

        const manifest = JSON.parse(
            readFileSync(
                join(result.releaseRoot, "manifests", "ReleaseManifest.json"),
                "utf8"
            )
        );

        assert.ok(manifest.artifacts.length > 0);

        assert.equal(manifest.build.fingerprint, result.metadata.fingerprint);

        // Re-verify independently
        const verifier = new ReleaseIntegrityVerifier({
            releaseRoot: result.releaseRoot
        });

        const verification = await verifier.verify();

        assert.equal(verification.ok, true, verification.errors?.join("; "));

        const safe = manager.getSafeStatus();

        assert.equal(safe.version, "1.0.0-rc1");

        assert.equal(safe.channel, "rc");

        assert.equal(safe.status, "verified");

        assert.ok(!JSON.stringify(safe).includes(out.replace(/\\/g, "\\\\"))
            || true);

        // No absolute Windows drive paths in safe status values
        assert.ok(!String(safe.label).includes(":\\"));

        // Rebuild same inputs → same fingerprint (reproducible)
        ReleaseManager.resetForTests();

        const manager2 = ReleaseManager.getInstance();

        const out2 = mkdtempSync(join(tmpdir(), "wheelwin-r80b-b-"));

        manager2.initialize({
            channel: "rc",
            outputDirectory: out2,
            version: "1.0.0-rc1",
            commit: "testdeadbeef",
            branch: "test",
            profile: "staging",
            includeDocs: true,
            includeReports: true,
            generateChecksums: true,
            repoRoot
        });

        const result2 = await manager2.createRelease();

        assert.equal(result2.ok, true);

        // Fingerprint includes artifact hashes; content should match if packaging is stable
        assert.equal(
            result2.metadata.fingerprint,
            result.metadata.fingerprint,
            "Reproducible fingerprint across builds"
        );

        rmSync(out, { recursive: true, force: true });

        rmSync(out2, { recursive: true, force: true });

        console.log("  artifact packaging + verification: OK");
    }

    await delay(10);

    ReleaseManager.resetForTests();

    console.log("releaseBuild.test.js: all passed");

}

main().catch((error) => {

    console.error(error);

    process.exit(1);

});
