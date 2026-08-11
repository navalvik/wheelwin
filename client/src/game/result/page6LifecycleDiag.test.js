/**
 * R12.5E — page6LifecycleDiag helpers (client).
 */
import assert from "node:assert/strict";

import {
    classifyInfoBarFooterMode,
    page6LifecycleDiag,
    resetPage6LifecycleDiagForTests,
    sanitizePage6DiagFields
} from "./page6LifecycleDiag.js";

import {
    APP_PAGES,
    resolveGameplayRecoveryPage
} from "../sessionRecovery/recoveryFlow.js";

import { normalizeSessionSnapshot } from "../sessionRecovery/sessionSnapshotUtils.js";

import { GAME_STATES } from "../GameState";

{

    resetPage6LifecycleDiagForTests();

    const sanitized = sanitizePage6DiagFields({
        roomId: "R1",
        wallet: "secret",
        privateKey: "x",
        token: "t",
        playerId: "p1"
    });

    assert.equal(sanitized.roomId, "R1");
    assert.equal(sanitized.playerId, "p1");
    assert.equal(sanitized.wallet, undefined);
    assert.equal(sanitized.privateKey, undefined);
    assert.equal(sanitized.token, undefined);

    assert.equal(
        classifyInfoBarFooterMode({
            currentPage: APP_PAGES.RESULT,
            onResultPage: true,
            onGameplayPage: true
        }),
        "PAGE6_TIME_LEFT"
    );

    assert.equal(
        classifyInfoBarFooterMode({
            currentPage: APP_PAGES.GAMEPLAY,
            onResultPage: false,
            onGameplayPage: true
        }),
        "PAGE5_RESULT_OR_GAMEPLAY"
    );

    const logged = page6LifecycleDiag("TEST_EVENT", { roomId: "R1" }, { force: true });

    assert.equal(logged.event, "TEST_EVENT");
    assert.equal(logged.roomId, "R1");
    assert.ok(Number.isFinite(logged.ts));

    console.log("  page6LifecycleDiag helpers: OK");

}

{

    const now = Date.now();

    const active = normalizeSessionSnapshot({
        openPage6: true,
        resultSessionExpiresAt: now + 60_000,
        gameState: GAME_STATES.RESULT
    });

    assert.equal(active.openPage6, true);
    assert.equal(active.resultSessionExpiresAt, now + 60_000);
    assert.equal(
        resolveGameplayRecoveryPage(active, now),
        APP_PAGES.RESULT
    );

    const expired = normalizeSessionSnapshot({
        openPage6: true,
        resultSessionExpiresAt: now - 1,
        gameState: GAME_STATES.RESULT
    });

    assert.equal(
        resolveGameplayRecoveryPage(expired, now),
        APP_PAGES.WELCOME
    );

    const page5 = normalizeSessionSnapshot({
        openPage6: false,
        gameState: GAME_STATES.SPEED
    });

    assert.equal(
        resolveGameplayRecoveryPage(page5, now),
        APP_PAGES.GAMEPLAY
    );

    console.log("  recovery snapshot Page6 fields: OK");

}

console.log("page6LifecycleDiag.test.js: all assertions passed");
