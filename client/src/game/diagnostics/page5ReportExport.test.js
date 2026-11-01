import assert from "node:assert/strict";
import {
    safeReportFilenamePart, formatPage5DeviceReportFile
} from "./page5ReportExport.js";

assert.equal(safeReportFilenamePart("../bad name","#"),"___bad_name");
assert.equal(safeReportFilenamePart("", "PLAYER"), "PLAYER");
assert.equal(formatPage5DeviceReportFile(null),null);
const report={
 schema:"wheelwin.page5-device-diagnostics.v1",
 roomId:"8JfK",gameId:"game_foo",playerId:"player_olga",
 nickname:"Olga",device:{platform:"Android",buildSha:"abc123"},
 events:[{kind:"page5_mount",wallMs:1793550000000}],
 buckets:[{second:1793550000000,physicsPackets:90}],
 metrics:{physicsReceived:90,wheelPaints:20,page6ReceiveToRenderMs:113}
};
const file=formatPage5DeviceReportFile(report);
assert.equal(file.filename,"WheelWin_Page5_8JfK_Olga.json");
assert.equal(file.mimeType,"application/json");
assert.deepEqual(JSON.parse(file.text),report);
assert.equal(file.text.endsWith("\n"),true);
console.log("page5ReportExport: all assertions passed");
