import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Mainnet archive uses the copied Testnet archive pipeline and source runtime snapshot", () => {
    const app = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
    assert.match(app, /forensic\/ForensicArchiveService\.js/);
    assert.match(app, /forensic\/R2ForensicArchiveUploader\.js/);
    assert.match(app, /forensic\/FinalForensicArchiveGate\.js/);
    assert.match(app, /financialSnapshotProvider: archiveBinding\.financialSnapshotProvider/);
    assert.match(app, /disklessUploads: archivePaymentMode === "mainnet"/);
    assert.match(app, /mainnetRuntime: this\._mainnetPaymentRuntime/);

    const binding = readFileSync(new URL("../payment/MainnetForensicFinancialSnapshot.js", import.meta.url), "utf8");
    assert.match(binding, /mainnetRuntime\.financialSnapshot\(roomId\)/);
    assert.match(binding, /prefix: "mainnet"/);
});
