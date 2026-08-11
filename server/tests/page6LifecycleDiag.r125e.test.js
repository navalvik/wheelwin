/**
 * R12.5E — server page6LifecycleDiag + enrichment assumptions.
 */
import assert from "node:assert/strict";

import {
    page6LifecycleDiag,
    sanitizeServerPage6DiagFields
} from "../logging/page6LifecycleDiag.js";

import {
    enrichPage6RecoveryFields
} from "../socket/gameplayRecoveryProtocol.js";

{

    const sanitized = sanitizeServerPage6DiagFields({
        roomId: "R1",
        wallet: "secret",
        accessToken: "x",
        openPage6: true
    });

    assert.equal(sanitized.roomId, "R1");
    assert.equal(sanitized.openPage6, true);
    assert.equal(sanitized.wallet, undefined);
    assert.equal(sanitized.accessToken, undefined);

    const lines = [];

    page6LifecycleDiag(
        { info: (line) => lines.push(line) },
        "RESULT_SESSION_EXPIRED",
        { roomId: "R1", gameId: "g1" }
    );

    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[R12\.5E Page6\]/);
    assert.match(lines[0], /RESULT_SESSION_EXPIRED/);
    assert.match(lines[0], /roomId=R1/);

    console.log("  server page6LifecycleDiag: OK");

}

{

    const now = 9_000_000;

    const enriched = enrichPage6RecoveryFields(
        {
            openPage6: false,
            resultSessionExpiresAt: null,
            gameState: "RESULT"
        },
        {
            page6Opened: true,
            cachedResultSessionExpiresAt: now + 120_000
        }
    );

    assert.equal(enriched.openPage6, true);
    assert.equal(enriched.resultSessionExpiresAt, now + 120_000);

    console.log("  OPEN_PAGE6 cache enrichment fields: OK");

}

console.log("page6LifecycleDiag.r125e.test.js: all assertions passed");
