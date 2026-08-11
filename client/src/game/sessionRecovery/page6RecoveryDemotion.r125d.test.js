/**
 * R12.5D — client guard: live Page6 must not be demoted to Page5.
 */
import {
    APP_PAGES,
    resolveGameplayRecoveryPage
} from "./recoveryFlow.js";

import { normalizeSessionSnapshot } from "./sessionSnapshotUtils.js";

import { GAME_STATES } from "../GameState";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

const now = 8_000_000;

{

    const enriched = normalizeSessionSnapshot({
        gameState: GAME_STATES.RESULT,
        openPage6: true,
        resultSessionExpiresAt: now + 60_000,
        gameResult: { winner: { id: "p1" } }
    });

    assert(
        resolveGameplayRecoveryPage(enriched, now) === APP_PAGES.RESULT,
        "active Page6 recovery → RESULT"
    );

}

{

    const expired = normalizeSessionSnapshot({
        gameState: GAME_STATES.RESULT,
        openPage6: true,
        resultSessionExpiresAt: now - 1,
        gameResult: { winner: { id: "p1" } }
    });

    assert(
        resolveGameplayRecoveryPage(expired, now) === APP_PAGES.RESULT,
        "expired deadline still recovers Page6 (R12.5H FINISH-only exit)"
    );

}

{

    // Server historically sent RESULT cache without openPage6 after teardown.
    // After R12.5D enrichment, openPage6 + expiresAt must both be present.
    const demotionRisk = normalizeSessionSnapshot({
        gameState: GAME_STATES.RESULT,
        openPage6: false,
        resultSessionExpiresAt: null
    });

    assert(
        resolveGameplayRecoveryPage(demotionRisk, now) === APP_PAGES.GAMEPLAY,
        "pre-OPEN_PAGE6 RESULT still restores Page5"
    );

    const afterEnrichment = normalizeSessionSnapshot({
        gameState: GAME_STATES.RESULT,
        openPage6: true,
        resultSessionExpiresAt: now + 30_000
    });

    assert(
        resolveGameplayRecoveryPage(afterEnrichment, now) === APP_PAGES.RESULT,
        "enriched post-OPEN_PAGE6 snapshot restores Page6"
    );

}

console.log("page6RecoveryDemotion.r125d.test.js: all assertions passed");
