import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForensicArchiveService } from "../forensic/ForensicArchiveService.js";
import { resolveForensicArchiveConfig } from "../forensic/forensicArchiveConfig.js";
import { R2ForensicArchiveUploader } from "../forensic/R2ForensicArchiveUploader.js";

function fixture({ failUpload = false } = {}) {
    const stagingDir = mkdtempSync(join(tmpdir(), "wheelwin-forensic-"));
    const uploads = [];
    const collector = {
        async collectToZip({ zipPath, archiveFilename }) {
            return { zipPath, archiveFilename, files: [{ sourcePath: "fixture", zipPath: "fixture", sha256: "abc" }] };
        }
    };
    const uploader = {
        isConfigured: () => true,
        async uploadFile(path, name) {
            uploads.push({ path, name });
            if (failUpload) throw new Error("R2 unavailable");
            return { objectName: name, generation: null };
        }
    };
    const service = new ForensicArchiveService({
        logger: { info() {}, error() {} },
        config: { enabled: true, required: false, stagingDir, maxUploadAttempts: 2 },
        collector,
        uploader
    });
    return { service, uploads, cleanup: () => rmSync(stagingDir, { recursive: true, force: true }) };
}

test("archive uploads without financial persistence", async () => {
    const f = fixture();
    try {
        const result = await f.service.ensureArchivedAndUploaded({ roomId: "roomA", gameId: "gameA" });
        assert.equal(result.uploaded, true);
        assert.equal(f.uploads.length, 1);
        const cached = await f.service.ensureArchivedAndUploaded({ roomId: "roomA", gameId: "gameA" });
        assert.equal(cached.uploaded, true);
        assert.equal(f.uploads.length, 1);
    } finally { f.cleanup(); }
});

test("R2 failures reject for the caller to catch, never retry forever", async () => {
    const f = fixture({ failUpload: true });
    try {
        await assert.rejects(
            f.service.ensureArchivedAndUploaded({ roomId: "roomB" }),
            /R2 unavailable/
        );
        assert.equal(f.uploads.length, 2);
    } finally { f.cleanup(); }
});

test("disabled archive does not touch R2", async () => {
    const f = fixture();
    try {
        f.service._config = { ...f.service._config, enabled: false };
        const result = await f.service.ensureArchivedAndUploaded({ roomId: "roomC" });
        assert.equal(result.skipped, true);
        assert.equal(f.uploads.length, 0);
    } finally { f.cleanup(); }
});

test("restart resumes a staged ZIP and records uploaded state", async () => {
    const f = fixture();
    try {
        const roomDir = join(f.service._config.stagingDir, "roomRestart");
        mkdirSync(roomDir, { recursive: true });
        const archiveFilename = "roomRestart.zip";
        writeFileSync(join(roomDir, archiveFilename), "zip-fixture");
        writeFileSync(join(roomDir, "status.json"), JSON.stringify({
            state: "pending_upload", roomId: "roomRestart", archiveFilename
        }));
        const result = await f.service.resumePendingUploads();
        assert.deepEqual(result, { resumed: 1, failed: 0 });
        assert.equal(f.uploads.length, 1);
        const status = JSON.parse(readFileSync(join(roomDir, "status.json"), "utf8"));
        assert.equal(status.state, "uploaded");
        const again = await f.service.resumePendingUploads();
        assert.deepEqual(again, { resumed: 0, failed: 0 });
    } finally { f.cleanup(); }
});

test("restart recovery handles R2 failure without throwing", async () => {
    const f = fixture({ failUpload: true });
    try {
        const roomDir = join(f.service._config.stagingDir, "roomFailure");
        mkdirSync(roomDir, { recursive: true });
        writeFileSync(join(roomDir, "archive.zip"), "zip-fixture");
        writeFileSync(join(roomDir, "status.json"), JSON.stringify({
            state: "failed", phase: "upload", roomId: "roomFailure", archiveFilename: "archive.zip"
        }));
        const result = await f.service.resumePendingUploads();
        assert.deepEqual(result, { resumed: 0, failed: 1 });
    } finally { f.cleanup(); }
});

test("restart recovery handles missing staged ZIP without throwing", async () => {
    const f = fixture();
    try {
        const roomDir = join(f.service._config.stagingDir, "roomMissing");
        mkdirSync(roomDir, { recursive: true });
        writeFileSync(join(roomDir, "status.json"), JSON.stringify({
            state: "pending_upload", roomId: "roomMissing", archiveFilename: "missing.zip"
        }));
        const result = await f.service.resumePendingUploads();
        assert.deepEqual(result, { resumed: 0, failed: 1 });
        assert.equal(f.uploads.length, 0);
    } finally { f.cleanup(); }
});

// CvaA incident regression: room timeout before Page5 must retain an
// identifiable failure ZIP, even when no payment or gameplay occurred.
test("setup_expired archive includes room ID and failed result", async () => {
    const f = fixture();
    try {
        const result = await f.service.ensureArchivedAndUploaded({
            roomId: "CvaA",
            gameId: "game_dd2f1106-66d5-467e-b23d-67424d96ed94",
            reason: "setup_expired"
        });
        assert.equal(result.uploaded, true);
        assert.equal(f.uploads.length, 1);
        assert.ok(f.uploads[0].name.includes("_ROOM_CvaA_GAME_game_dd2f1106-66d5-467e-b23d-67424d96ed94_"));
        assert.ok(f.uploads[0].name.endsWith("_FAILED.zip"));
    } finally { f.cleanup(); }
});

test("explicit forensic ZIP staging path takes precedence over Railway default", () => {
    const root = mkdtempSync(join(tmpdir(), "wheelwin-r2-volume-"));
    try {
        const config = resolveForensicArchiveConfig({
            FORENSIC_ARCHIVE_STAGING_DIR: join(root, "archives"),
            TON_FINANCIAL_DATA_DIR: root
        });
        assert.equal(config.stagingDir, join(root, "archives"));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("mounted persistence root is used for forensic ZIP staging", () => {
    const root = mkdtempSync(join(tmpdir(), "wheelwin-r2-volume-"));
    try {
        const config = resolveForensicArchiveConfig({ TON_FINANCIAL_DATA_DIR: root });
        assert.equal(config.stagingDir, join(root, "forensic-archive-staging"));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("R2 ZIP stream declares exact ContentLength and verifies object presence", async () => {
    const root = mkdtempSync(join(tmpdir(), "wheelwin-r2-stream-"));
    try {
        const zipPath = join(root, "fixture.zip");
        const bytes = Buffer.from("offline-archive-fixture");
        writeFileSync(zipPath, bytes);
        const calls = [];
        const uploader = new R2ForensicArchiveUploader({
            bucket: "offline-bucket", endpoint: "http://localhost:9000",
            accessKeyId: "fake", secretAccessKey: "fake"
        });
        uploader._client = {
            async send(command) {
                calls.push(command);
                return { ETag: '"fixture-etag"' };
            }
        };
        const result = await uploader.uploadFile(zipPath, "fixture.zip");
        assert.equal(calls.length, 2);
        assert.equal(calls[0].input.ContentLength, bytes.length);
        assert.equal(calls[0].input.ContentType, "application/zip");
        assert.equal(calls[0].input.Key, "forensic-archives/fixture.zip");
        assert.equal(calls[1].input.Key, calls[0].input.Key);
        assert.equal(result.etag, "fixture-etag");
        // Drain the upload stream before deleting its temporary source file.
        // Otherwise an asynchronous open may race with fixture cleanup.
        for await (const chunk of calls[0].input.Body) {
            assert.ok(chunk.length > 0);
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
