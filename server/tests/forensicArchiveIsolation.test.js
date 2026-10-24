import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForensicArchiveService } from "../forensic/ForensicArchiveService.js";

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
