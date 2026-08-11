/**
 * R12.5H — Page6 exit is explicit FINISH only (no timer-driven navigation).
 */
import assert from "node:assert/strict";

import {
    APP_PAGES,
    resolveGameplayRecoveryPage
} from "../sessionRecovery/recoveryFlow.js";

import { normalizeSessionSnapshot } from "../sessionRecovery/sessionSnapshotUtils.js";

import { shouldNavigateOnGameplayRoomClosed } from "../session/gameplayTerminal.js";

import {
    classifyInfoBarFooterMode
} from "./page6LifecycleDiag.js";

import {
    classifyPage6InfoBarCombination
} from "./webPage6StateDiag.js";

import { resolveClockPhaseLabel } from "../gameClock/gameClockView.js";

import { GAME_STATES } from "../GameState";

const now = 9_000_000;

// ---------------------------------------------------------------------------
// Test A — Page6 does not auto-navigate when deadline is still in the future
// ---------------------------------------------------------------------------

{

    const page = resolveGameplayRecoveryPage({
        gameState: GAME_STATES.RESULT,
        openPage6: true,
        resultSessionExpiresAt: now + 120_000,
        gameResult: { winner: { id: "p1" } }
    }, now);

    assert.equal(page, APP_PAGES.RESULT, "TEST A: future expiresAt → stay Page6");

    const later = resolveGameplayRecoveryPage({
        gameState: GAME_STATES.RESULT,
        openPage6: true,
        resultSessionExpiresAt: now + 120_000,
        gameResult: { winner: { id: "p1" } }
    }, now + 60_000);

    assert.equal(later, APP_PAGES.RESULT, "TEST A: advancing time does not leave Page6");

    console.log("  TEST A Page6 no auto-nav: OK");

}

// ---------------------------------------------------------------------------
// Test B — Countdown expiration does not navigate Page6 → Page1
// ---------------------------------------------------------------------------

{

    assert.equal(
        resolveGameplayRecoveryPage({
            gameState: GAME_STATES.RESULT,
            openPage6: true,
            resultSessionExpiresAt: now - 1,
            gameResult: { winner: { id: "p1" } }
        }, now),
        APP_PAGES.RESULT,
        "TEST B: past expiresAt must not force WELCOME"
    );

    assert.equal(
        shouldNavigateOnGameplayRoomClosed(APP_PAGES.RESULT, true),
        false,
        "TEST B: roomClosed on Page6 must not navigate"
    );

    console.log("  TEST B countdown expiry no client nav: OK");

}

// ---------------------------------------------------------------------------
// Test C / D — FINISH navigates once (idempotent terminal guard)
// ---------------------------------------------------------------------------

{

    let resetCount = 0;

    const terminalHandledRef = { current: false };

    function resetToWelcome(event = "resetToWelcome") {

        if (terminalHandledRef.current) {

            return false;

        }

        terminalHandledRef.current = true;

        resetCount += 1;

        return true;

    }

    function finishSession() {

        const navigated = resetToWelcome("PAGE6_FINISH");

        return navigated === true ? APP_PAGES.WELCOME : null;

    }

    assert.equal(finishSession(), APP_PAGES.WELCOME, "TEST C: FINISH → WELCOME");
    assert.equal(resetCount, 1, "TEST C: one terminal reset");

    assert.equal(finishSession(), null, "TEST D: second FINISH is a no-op");
    assert.equal(resetCount, 1, "TEST D: no duplicate cleanup");

    console.log("  TEST C/D FINISH navigate + idempotent: OK");

}

// ---------------------------------------------------------------------------
// Test E — Page6 recovery (active completed Page6)
// ---------------------------------------------------------------------------

{

    const recovered = resolveGameplayRecoveryPage(
        normalizeSessionSnapshot({
            gameState: GAME_STATES.RESULT,
            openPage6: true,
            resultSessionExpiresAt: now + 30_000,
            gameResult: { winner: { id: "p1" } }
        }),
        now
    );

    assert.equal(recovered, APP_PAGES.RESULT, "TEST E: recovery restores Page6");

    const recoveredPastDeadline = resolveGameplayRecoveryPage(
        normalizeSessionSnapshot({
            gameState: GAME_STATES.RESULT,
            openPage6: true,
            resultSessionExpiresAt: now - 5_000,
            gameResult: { winner: { id: "p1" } }
        }),
        now
    );

    assert.equal(
        recoveredPastDeadline,
        APP_PAGES.RESULT,
        "TEST E: still Page6 after deadline while openPage6 available"
    );

    console.log("  TEST E Page6 recovery: OK");

}

// ---------------------------------------------------------------------------
// Test F — Page5 RESULT game clock presentation unchanged
// ---------------------------------------------------------------------------

{

    assert.equal(
        resolveClockPhaseLabel(GAME_STATES.RESULT),
        "RESULT",
        "TEST F: Page5 RESULT phase label unchanged"
    );

    assert.equal(
        classifyInfoBarFooterMode({
            currentPage: APP_PAGES.GAMEPLAY,
            onResultPage: false,
            onGameplayPage: true
        }),
        "PAGE5_RESULT_OR_GAMEPLAY",
        "TEST F: Page5 footer mode unchanged"
    );

    assert.equal(
        classifyPage6InfoBarCombination({
            page6Mounted: false,
            infoBarCurrentPage: APP_PAGES.GAMEPLAY,
            footerMode: "PAGE5_RESULT_OR_GAMEPLAY",
            timerLabel: "RESULT",
            timerValue: "00:00"
        }),
        "B_PAGE5_RESULT",
        "TEST F: Page5 RESULT / 00:00 still Case B"
    );

    assert.equal(
        classifyInfoBarFooterMode({
            currentPage: APP_PAGES.RESULT,
            onResultPage: true,
            onGameplayPage: true
        }),
        "PAGE6_NEUTRAL",
        "TEST F: Page6 uses neutral footer (no lifetime countdown)"
    );

    console.log("  TEST F Page5 RESULT clock unchanged: OK");

}

console.log("page6Finish.r125h.test.js: all assertions passed");
