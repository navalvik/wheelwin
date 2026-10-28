import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ForensicArchiveService } from "../forensic/ForensicArchiveService.js";
import { MockForensicArchiveUploader } from "../forensic/R2ForensicArchiveUploader.js";
import { resolveForensicArchiveConfig } from "../forensic/forensicArchiveConfig.js";

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "wheelwin-r2-restored-"));
    const history = join(root, "session-history");
    const logs = join(root, "logs");
    const staging = join(root, "staging");
    mkdirSync(history, { recursive: true });
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(history, "2026-10-27_01-00-00_ROOM_Abc_GAME_game-1_COMPLETED.json"),
        JSON.stringify({ roomId: "Abc", gameId: "game-1", lifecycleResult: "GAME_COMPLETED" }));
    writeFileSync(join(logs, "2026-10-27_01-00-00_ROOM_Abc_GAME_game-1_COMPLETED.log"),
        "GAME_COMPLETED roomId=Abc");
    const config = {
        enabled: true,
        required: false,
        stagingDir: staging,
        sessionHistoryDir: history,
        diagnosticLogsDir: logs,
        maxUploadAttempts: 2,
        bucket: "mock",
        prefix: "forensic-archives"
    };
    return { root, config, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("restored R2 archive ZIP contains room artifacts and uploads once", async () => {
    const f = fixture();
    try {
        const uploader = new MockForensicArchiveUploader();
        const service = new ForensicArchiveService({ config: f.config, uploader });
        const result = await service.ensureArchivedAndUploaded({
            roomId: "Abc", gameId: "game-1", reason: "game_completed"
        });
        assert.equal(result.uploaded, true);
        assert.match(result.archiveFilename, /_COMPLETED\.zip$/);
        assert.equal(uploader.uploads.length, 1);
        const zip = readFileSync(uploader.uploads[0].localPath);
        assert.equal(zip.subarray(0, 2).toString(), "PK");
        const status = JSON.parse(readFileSync(join(f.config.stagingDir, "Abc", "status.json"), "utf8"));
        assert.equal(status.state, "uploaded");
        assert.equal(status.manifest.files.length, 2);
        assert.ok(status.manifest.files.some(f => f.zipPath.includes("session-history")));
        assert.ok(status.manifest.files.some(f => f.zipPath.includes("diagnostic-logs")));
        await service.ensureArchivedAndUploaded({
            roomId: "Abc", gameId: "game-1", reason: "game_completed"
        });
        assert.equal(uploader.uploads.length, 1, "completed upload is idempotent");
    } finally {
        f.cleanup();
    }
});

test("failed R2 upload remains durable for recovery, never claims success", async () => {
    const f = fixture();
    try {
        const uploader = new MockForensicArchiveUploader();
        uploader.shouldFail = true;
        const service = new ForensicArchiveService({ config: f.config, uploader });
        await assert.rejects(service.ensureArchivedAndUploaded({
            roomId: "Abc", gameId: "game-1", reason: "game_completed"
        }), /Mock R2 upload failure/);
        const status = JSON.parse(readFileSync(join(f.config.stagingDir, "Abc", "status.json"), "utf8"));
        assert.equal(status.state, "failed");
        assert.equal(status.phase, "upload");
        assert.equal(status.attempts, 2);

        // Simulate a Railway restart: original ephemeral history/logs vanish,
        // but the mounted-volume ZIP and status remain available.
        rmSync(f.config.sessionHistoryDir, { recursive: true, force: true });
        rmSync(f.config.diagnosticLogsDir, { recursive: true, force: true });
        uploader.shouldFail = false;
        const restarted = new ForensicArchiveService({ config: f.config, uploader });
        const recovery = await restarted.recoverPendingUploads();
        assert.deepEqual(recovery, [{ roomId: "Abc", uploaded: true }]);
        const recovered = JSON.parse(readFileSync(
            join(f.config.stagingDir, "Abc", "status.json"), "utf8"
        ));
        assert.equal(recovered.state, "uploaded");
        assert.equal(recovered.attempts, 3);
        assert.equal(uploader.uploads.length, 1);
    } finally {
        f.cleanup();
    }
});

test("R2 config never enables a blocking room teardown by default", () => {
    const config = resolveForensicArchiveConfig({
        R2_BUCKET_NAME: "private-bucket",
        R2_ACCESS_KEY_ID: "test",
        R2_SECRET_ACCESS_KEY: "test-secret",
        R2_ACCOUNT_ID: "test-account"
    });
    assert.equal(config.r2Configured, true);
    assert.equal(config.enabled, true);
    assert.equal(config.required, false);
    assert.equal(config.prefix, "forensic-archives");
    assert.equal(resolveForensicArchiveConfig({}).r2Configured, false);
    const volumeConfig = resolveForensicArchiveConfig({
        RAILWAY_VOLUME_MOUNT_PATH: "/mnt/volume"
    });
    assert.equal(volumeConfig.stagingDir, join("/mnt/volume", "r2-archive-staging"));
    assert.equal(volumeConfig.sessionHistoryDir, join("/mnt/volume", "session-history"));
});

test('financial archive revisions preserve both pending and completed debt evidence', async () => {
    const f = fixture();
    try {
        let state = 'PENDING';
        const uploader = new MockForensicArchiveUploader();
        const financialSnapshotProvider = () => ({network:'testnet', roomId:'Abc', refunds:[{state}]});
        const service = new ForensicArchiveService({config:f.config, uploader, financialSnapshotProvider});
        const request = {roomId:'Abc', gameId:'game-1', reason:'game_completed'};
        await service.ensureArchivedAndUploaded(request);
        await service.ensureArchivedAndUploaded(request);
        assert.equal(uploader.uploads.length, 1);
        state = 'COMPLETE';
        await service.ensureArchivedAndUploaded(request);
        assert.equal(uploader.uploads.length, 2);
        assert.notEqual(uploader.uploads[0].localPath, uploader.uploads[1].localPath);
        for (const upload of uploader.uploads) {
            assert.ok(readFileSync(upload.localPath).includes(Buffer.from('financial/room-wallet.json')));
        }
        const restarted = new ForensicArchiveService({config:f.config, uploader, financialSnapshotProvider});
        await restarted.ensureArchivedAndUploaded(request);
        assert.equal(uploader.uploads.length, 2);
    } finally { f.cleanup(); }
});
