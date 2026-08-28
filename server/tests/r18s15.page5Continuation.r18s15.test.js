/**
 * R18-S15 — E2E runner must continue past GameEscrow READY to production OPEN_PAGE5.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER_SOURCE = readFileSync(
    join(HERE, "../scripts/_r18s15_production_page5.mjs"),
    "utf8"
);
const GSA_SOURCE = readFileSync(
    join(HERE, "../gameplay/GameStartAuthorization.js"),
    "utf8"
);
const GCM_SOURCE = readFileSync(
    join(HERE, "../gameplay/GameContractManager.js"),
    "utf8"
);
const BRIDGE_SOURCE = readFileSync(
    join(HERE, "../socket/RoomLobbyBridge.js"),
    "utf8"
);
const PSM_SOURCE = readFileSync(
    join(HERE, "../gameplay/PaymentSessionManager.js"),
    "utf8"
);

test("R18-S15: runner treats GameEscrow READY as non-terminal", () => {

    const readyNote = DRIVER_SOURCE.indexOf("WAIT_PRODUCTION_PAGE5");
    const page5Wait = DRIVER_SOURCE.indexOf("page5 = await openPage5");
    const getter = DRIVER_SOURCE.indexOf("get_status/gameEscrow");
    const stakeLoop = DRIVER_SOURCE.indexOf("await sendStake({");
    const handoffWait = DRIVER_SOURCE.indexOf("waitForProductionHandoffLog");
    const exitAfterReady = /onChainStatus[\s\S]{0,200}process\.exit/.test(DRIVER_SOURCE);

    assert.notEqual(readyNote, -1);
    assert.notEqual(page5Wait, -1);
    assert.ok(
        readyNote < page5Wait,
        "WAIT_PRODUCTION_PAGE5 must run before awaiting OPEN_PAGE5"
    );
    assert.ok(
        getter === -1 || getter > page5Wait,
        "optional READY getters must not block OPEN_PAGE5"
    );
    assert.ok(
        handoffWait !== -1 && handoffWait < stakeLoop,
        "production handoff observation must start before STAKE broadcasts"
    );
    assert.equal(exitAfterReady, false);
    assert.match(
        DRIVER_SOURCE,
        /GameEscrow READY is not terminal/
    );
    assert.match(
        DRIVER_SOURCE,
        /payload\?\.roomId === liveRoom/
    );
    assert.match(
        DRIVER_SOURCE,
        /waitForProductionHandoffLog/
    );

});

test("R18-S15: production READY-to-Page5 handoff remains PaymentSession → GSA → RoomLobbyBridge", () => {

    assert.match(PSM_SOURCE, /PAYMENT_SESSION_COMPLETED/);
    assert.match(GCM_SOURCE, /EVENT_TYPES\.PAYMENT_SESSION_COMPLETED/);
    assert.match(GCM_SOURCE, /GAME_CONTRACT_PAYMENTS_COMPLETE/);
    assert.match(GSA_SOURCE, /EVENT_TYPES\.PAYMENT_SESSION_COMPLETED/);
    assert.match(GSA_SOURCE, /EVENT_TYPES\.GAME_CONTRACT_PAYMENTS_COMPLETE/);
    assert.match(GSA_SOURCE, /EVENT_TYPES\.GAME_START_AUTHORIZED/);
    assert.match(BRIDGE_SOURCE, /EVENT_TYPES\.GAME_START_AUTHORIZED/);
    assert.match(BRIDGE_SOURCE, /LOBBY_SERVER_EVENTS\.OPEN_PAGE5/);
    assert.match(BRIDGE_SOURCE, /_deliverOpenPage5/);
    assert.doesNotMatch(
        DRIVER_SOURCE,
        /_deliverOpenPage5\s*\(/
    );

});
