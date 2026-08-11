/**
 * R12.5F — Web Page6 / InfoBar combination classification.
 */
import assert from "node:assert/strict";

import { APP_PAGES } from "../sessionRecovery/recoveryFlow.js";

import {
    classifyPage6InfoBarCombination,
    clearPage6MountSnapshot,
    detectCurrentPageSourceSplit,
    getPage6MountSnapshot,
    notePage6MountSnapshot,
    resetWebPage6DiagForTests,
    webPage6Diag
} from "./webPage6StateDiag.js";

{

    resetWebPage6DiagForTests();

    assert.equal(
        classifyPage6InfoBarCombination({
            page6Mounted: true,
            infoBarCurrentPage: APP_PAGES.RESULT,
            footerMode: "PAGE6_NEUTRAL",
            timerLabel: "—",
            timerValue: "—"
        }),
        "A_PAGE6_NEUTRAL",
        "Case A: Page6 + neutral footer"
    );

    assert.equal(
        classifyPage6InfoBarCombination({
            page6Mounted: true,
            infoBarCurrentPage: APP_PAGES.RESULT,
            footerMode: "PAGE6_TIME_LEFT",
            timerLabel: "TIME LEFT",
            timerValue: "04:59"
        }),
        "A_PAGE6_NEUTRAL",
        "Case A legacy: Page6 + TIME LEFT still classified as Page6"
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
        "Case B: Page5 + RESULT / 00:00"
    );

    assert.equal(
        classifyPage6InfoBarCombination({
            page6Mounted: true,
            infoBarCurrentPage: APP_PAGES.GAMEPLAY,
            footerMode: "PAGE5_RESULT_OR_GAMEPLAY",
            timerLabel: "RESULT",
            timerValue: "00:00"
        }),
        "C_PAGE6_BODY_RESULT_FOOTER",
        "Case C: Page6 body + RESULT footer"
    );

    assert.equal(
        classifyPage6InfoBarCombination({
            page6Mounted: true,
            infoBarCurrentPage: APP_PAGES.GAMEPLAY,
            footerMode: null,
            timerLabel: "RESULT",
            timerValue: "00:00"
        }),
        "C_PAGE6_BODY_RESULT_FOOTER",
        "Case C via page6Mounted + non-RESULT infoBar currentPage"
    );

    console.log("  combination cases A/B/C: OK");

}

{

    const split = detectCurrentPageSourceSplit({
        page6CurrentPage: APP_PAGES.RESULT,
        infoBarCurrentPage: APP_PAGES.GAMEPLAY,
        page6Source: "GameSessionContext.currentPage",
        infoBarSource: "GameSessionContext.currentPage"
    });

    assert.equal(split.splitDetected, true);
    assert.equal(split.sameSource, true);
    assert.equal(split.sameValue, false);

    const aligned = detectCurrentPageSourceSplit({
        page6CurrentPage: APP_PAGES.RESULT,
        infoBarCurrentPage: APP_PAGES.RESULT
    });

    assert.equal(aligned.splitDetected, false);
    assert.equal(aligned.sameValue, true);

    notePage6MountSnapshot({
        currentPage: APP_PAGES.RESULT,
        source: "GameSessionContext.currentPage",
        resultSessionExpiresAt: Date.now() + 1000
    });

    assert.equal(getPage6MountSnapshot()?.currentPage, APP_PAGES.RESULT);

    clearPage6MountSnapshot();

    assert.equal(getPage6MountSnapshot(), null);

    const logged = webPage6Diag("TEST", { roomId: "R1" }, { force: true });

    assert.equal(logged.event, "TEST");
    assert.equal(logged.appPagesResult, APP_PAGES.RESULT);

    console.log("  source split + mount snapshot: OK");

}

console.log("webPage6StateDiag.test.js: all assertions passed");
