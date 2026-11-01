import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source=path=>readFileSync(resolve(root,path),"utf8");
const page6=source("pages/Page6Result.jsx");
const page5=source("pages/Page5Game.jsx");
const socket=source("socket/SocketSyncLayer.js");
const wheel=source("components/game/WheelEngine/WheelEngine.jsx");
const pointer=source("components/game/TriangleEngine/TriangleEngine.jsx");
const vit=source("../vite.config.js");
assert.match(page6,/PAGE5 DIAGNOSTICS/);
assert.match(page6,/COPY JSON/);
assert.match(page6,/handleDeviceReportCopy/);
assert.doesNotMatch(page6,/DOWNLOAD JSON|SHARE FILE|downloadTxt|SERVER<\/button>/,
    "Telegram-blocked file actions must not appear in GAME REPORT");
assert.doesNotMatch(page6,/handleDeviceReportDownload|handleDeviceReportShare|handleDownloadTxt/,
    "removed actions must not remain reachable");
assert.match(page6,/Automatic upload:/,
    "automatic server report delivery remains the primary workflow");
assert.match(page6,/createPage5AutoReportSender/,
    "COPY is only a fallback; automatic report upload must remain enabled");
assert.match(page6,/localDeviceReport/);
assert.match(page6,/recordPage5Diagnostic\(\{[\s\S]*?kind: "page6_rendered"/);
assert.match(page5,/noteLocalMainThreadStall/);
assert.match(socket,/noteLocalPage5Socket\(/);
assert.match(socket,/noteLocalPage5Dispatch\(/);
assert.match(wheel,/noteLocalPage5Canvas\("wheel"/);
assert.match(pointer,/noteLocalPage5Canvas\("pointer"/);
assert.match(vit,/VERCEL_GIT_COMMIT_SHA/);
console.log("page5ReportIntegration: all assertions passed");
