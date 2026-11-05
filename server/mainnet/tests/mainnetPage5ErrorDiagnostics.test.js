import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ForensicArchiveCollector } from "../testnet_source/forensic/ForensicArchiveCollector.js";
import {
    ClientPage5DeviceReportStore,
    PAGE5_DEVICE_REPORT_SCHEMA
} from "../testnet_source/forensic/ClientPage5DeviceReportStore.js";

test("Mainnet Page5 window error details survive sanitization into the game ZIP", async t => {
    const stagingDir = mkdtempSync(join(tmpdir(), "wheelwin-p5-error-diag-"));
    t.after(() => rmSync(stagingDir, { recursive: true, force: true }));

    const roomId = "DiagRoom";
    const gameId = "game_error_diag_1";
    const playerId = "player_error_diag_1";
    const deviceReportStore = new ClientPage5DeviceReportStore({ stagingDir });
    const rawReport = {
        schema: PAGE5_DEVICE_REPORT_SCHEMA,
        roomId,
        gameId,
        playerId,
        nickname: "Synthetic",
        exportedAt: "2026-11-05T00:00:00.000Z",
        device: { platform: "Android", androidMajor: 16 },
        metrics: {},
        droppedEvents: 0,
        buckets: [],
        events: [{
            wallMs: 1793907485382,
            monoMs: 297842.7,
            kind: "client_error",
            reason: "window_error",
            errorName: "TypeError",
            errorMessage: "Cannot read x token=should-not-export",
            errorStack: "TypeError: x\n at view (https://game.test/app.js?api_key=stack-secret:8:3)",
            errorFile: "https://user:file-secret@game.test/app.js?access_token=file-query-secret",
            errorLine: 8,
            errorColumn: 3,
            phase: "PRE_GAME_READY",
            displayedPhase: "PRE_GAME_READY"
        }]
    };

    const saved = deviceReportStore.record({ roomId, gameId, playerId, rawReport });
    assert.equal(saved.ok, true);
    const storedReport = deviceReportStore.readPlayer(roomId, gameId, playerId);
    const event = storedReport.events[0];
    assert.equal(event.errorName, "TypeError");
    assert.match(event.errorMessage, /Cannot read x/);
    assert.match(event.errorStack, / at view /);
    assert.match(event.errorFile, /app\.js/);
    assert.equal(event.errorLine, 8);
    assert.equal(event.errorColumn, 3);
    assert.equal(event.phase, "PRE_GAME_READY");
    assert.equal(event.displayedPhase, "PRE_GAME_READY");
    assert.equal(event.wallMs, 1793907485382);
    assert.equal(event.monoMs, 297842.7);
    for (const text of [event.errorMessage, event.errorStack, event.errorFile]) {
        assert.doesNotMatch(text, /should-not-export|stack-secret|file-secret/);
        assert.doesNotMatch(text, /file-query-secret/);
    }

    const collector = new ForensicArchiveCollector({
        sessionHistoryDir: join(stagingDir, "history"),
        diagnosticLogsDir: join(stagingDir, "diagnostics"),
        deviceReportStore
    });
    const zipEntry = `forensics/page5-device-reports/${playerId}.json`;
    const entry = collector._discoverArtifactEntries({ roomId, gameId })
        .find(candidate => candidate.zipPath === zipEntry);
    assert.ok(entry, "individual sanitized Page5 report is added to the ZIP entries");
    const archivedReport = JSON.parse(entry.inlineContent);
    assert.equal(archivedReport.events[0].errorStack, event.errorStack);
    assert.equal(archivedReport.events[0].phase, "PRE_GAME_READY");

    const archive = await collector.collectToZip({
        roomId,
        gameId,
        zipPath: join(stagingDir, "completed.zip"),
        archiveFilename: "synthetic-mainnet-game.zip"
    });
    assert.ok(archive.files.some(file => file.zipPath === zipEntry),
        "the ZIP manifest includes the individual diagnostic report");
});
