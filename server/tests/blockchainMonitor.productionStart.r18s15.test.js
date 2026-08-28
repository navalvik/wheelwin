/**
 * R18-S15 — Production composition must start BlockchainMonitor after
 * DepositMonitor is attached so DepositMonitor.poll() actually runs.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(join(HERE, "../app.js"), "utf8");

test("R18-S15: app.js starts BlockchainMonitor after setDepositMonitor", () => {

    const attach = APP_SOURCE.indexOf("setDepositMonitor");
    const start = APP_SOURCE.indexOf("this._blockchainMonitor.start(");

    assert.notEqual(attach, -1, "app.js must attach DepositMonitor");
    assert.notEqual(start, -1, "app.js must call BlockchainMonitor.start()");
    assert.ok(
        attach < start,
        "BlockchainMonitor.start() must run after setDepositMonitor"
    );

});

test("R18-S15: app.js passes RoomManager into DepositMonitor and activation coordinator", () => {

    assert.match(
        APP_SOURCE,
        /new DepositMonitor\(\{[\s\S]*?roomManager:\s*this\._managers\.roomManager/
    );
    assert.match(
        APP_SOURCE,
        /new DepositActivationVerificationCoordinator\(\{[\s\S]*?roomManager:\s*this\._managers\.roomManager/
    );

});
