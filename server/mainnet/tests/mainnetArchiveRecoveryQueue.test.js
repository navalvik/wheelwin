import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ForensicArchiveService } from "../../forensic/ForensicArchiveService.js";
import { MockForensicArchiveUploader } from "../../forensic/R2ForensicArchiveUploader.js";
import { evaluateFinalForensicArchive } from "../../forensic/FinalForensicArchiveGate.js";
import { listMainnetArchiveCandidates, selectMainnetArchiveBatch }
    from "../payment/MainnetArchiveRecoveryQueue.js";

test("archive candidates include REFUND and PAYOUT outcomes and deduplicate by room", () => {
    const candidates = listMainnetArchiveCandidates({
        listClosedRooms: () => [
            { roomId: "refund-room", closureReason: "setup_expired" },
            { roomId: "shared-room", closureReason: "closed" }
        ],
        listPayouts: () => [
            { roomId: "payout-room", state: "PENDING" },
            { roomId: "shared-room", state: "COMPLETE" }
        ]
    });
    assert.deepEqual(candidates, [
        { roomId: "refund-room", reason: "setup_expired" },
        { roomId: "shared-room", reason: "closed" },
        { roomId: "payout-room", reason: "game_completed" }
    ]);
    const batch = selectMainnetArchiveBatch(candidates, 2, 2);
    assert.deepEqual(batch.items.map(item => item.roomId), ["payout-room", "refund-room"]);
    assert.equal(batch.nextCursor, 1);
});

test("PAYOUT recovery uses the shared finality gate and one idempotent ZIP", async t => {
    const root = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-payout-archive-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const stagingDir = join(root, "staging");
    const sessionHistoryDir = join(root, "history");
    const diagnosticLogsDir = join(root, "logs");
    mkdirSync(sessionHistoryDir);
    mkdirSync(diagnosticLogsDir);

    const sessionRecord = {
        roomId: "mainnet-payout-room", gameId: "mainnet-game-1",
        finishedAt: 2_000_000, lifecycleResult: "GAME_COMPLETED"
    };
    const sessionHistoryArchive = {
        listRecords: () => ({ records: [sessionRecord] }),
        listRecordFilePathsForRoom: () => []
    };
    const snapshot = {
        schemaVersion: 1, network: "mainnet", globalId: -239,
        roomId: sessionRecord.roomId, closedRoom: null, outcome: { kind: "PAYOUT" },
        intents: [{ state: "SETTLED" }, { state: "SETTLED" }, { state: "SETTLED" }],
        ledger: [{ kind: "PAYOUT_PLAN" }, { kind: "PAYOUT_SETTLEMENT" }],
        refunds: [], receipts: [], unresolvedReceipts: [], outstandingObligations: 1
    };
    const uploader = new MockForensicArchiveUploader();
    const service = new ForensicArchiveService({
        config: { enabled: true, required: true, bucket: "mock", prefix: "mainnet",
            stagingDir, sessionHistoryDir, diagnosticLogsDir, maxUploadAttempts: 1 },
        uploader,
        sessionHistoryArchive,
        financialSnapshotProvider: () => snapshot,
        finalityChecker: (financial, context) => evaluateFinalForensicArchive({
            snapshot: financial, sessionRecord: context.sessionRecord
        })
    });
    const candidate = { roomId: sessionRecord.roomId, reason: "game_completed" };

    const pending = await service.ensureArchivedAndUploaded(candidate);
    assert.equal(pending.skipped, true);
    assert.equal(uploader.uploads.length, 0, "open payout obligations must hold the archive");

    snapshot.ledger.push({ kind: "PAYOUT_SETTLEMENT" });
    snapshot.outstandingObligations = 0;
    const completed = await service.ensureArchivedAndUploaded(candidate);
    assert.equal(completed.uploaded, true);
    assert.equal(uploader.uploads.length, 1);

    const replay = await service.ensureArchivedAndUploaded(candidate);
    assert.equal(replay.uploaded, true);
    assert.equal(uploader.uploads.length, 1, "recovery replay must not create another ZIP");

    const restarted = new ForensicArchiveService({
        config: { enabled: true, required: true, bucket: "mock", prefix: "mainnet",
            stagingDir, sessionHistoryDir, diagnosticLogsDir, maxUploadAttempts: 1 },
        uploader,
        sessionHistoryArchive,
        financialSnapshotProvider: () => snapshot,
        finalityChecker: (financial, context) => evaluateFinalForensicArchive({
            snapshot: financial, sessionRecord: context.sessionRecord
        })
    });
    await restarted.ensureArchivedAndUploaded(candidate);
    assert.equal(uploader.uploads.length, 1, "restart must reuse the existing final archive");
});
