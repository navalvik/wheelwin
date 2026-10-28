import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bridgePath = fileURLToPath(new URL("../socket/RoomLobbyBridge.js", import.meta.url));
const source = readFileSync(bridgePath, "utf8");

test("setup-expired _closeRoom schedules ZIP after destroyRoom", () => {
    const closeStart = source.indexOf("    async _closeRoom(roomId, reason) {");
    assert.ok(closeStart > 0, "_closeRoom exists");
    const close = source.slice(closeStart);
    const destroyAt = close.indexOf("this._roomManager.destroyRoom(roomId);");
    const archiveAt = close.indexOf("forensicArchiveService.ensureArchivedAndUploaded(");
    const cleanupAt = close.indexOf("this._roomCreators.delete(roomId);");
    assert.ok(destroyAt >= 0 && archiveAt > destroyAt && cleanupAt > archiveAt,
        "archive must start after authoritative destruction and before cleanup");
    assert.match(close, /roomId,\s*gameId,\s*reason: reason \?\? "room_destroyed"/);
    assert.match(close, /FORENSIC_ARCHIVE_ASYNC_FAILED/);
});

test("empty-room leave does not reference undefined gameId in archival hook", () => {
    const emptyStart = source.indexOf('reason: "empty_room"');
    const closeStart = source.indexOf("    async _closeRoom(roomId, reason) {");
    assert.ok(emptyStart > 0 && closeStart > emptyStart);
    const section = source.slice(emptyStart, closeStart);
    assert.doesNotMatch(section, /forensicArchiveService.ensureArchivedAndUploaded\(/);
});
