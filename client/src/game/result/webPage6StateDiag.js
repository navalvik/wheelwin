/**
 * R12.5F — Web Page6 / InfoBar state-split diagnostics.
 * Observation only. Does not change navigation, countdown, or footer logic.
 */

import { APP_PAGES } from "../sessionRecovery/recoveryFlow.js";

import {
    sanitizePage6DiagFields
} from "./page6LifecycleDiag.js";

import { forwardPage6ClientDiag } from "./page6ClientDiagForwarder.js";

const PREFIX = "[R12.5F WebPage6]";

const lastFingerprintByKey = new Map();

/** @type {null | {
 *   currentPage: unknown,
 *   currentPageType: string,
 *   source: string,
 *   resultSessionExpiresAt: number | null,
 *   ts: number
 * }} */
let page6MountSnapshot = null;

/**
 * @param {string} event
 * @param {Record<string, unknown>} fields
 * @param {{ key?: string, force?: boolean }} [options]
 */
export function webPage6Diag(event, fields = {}, options = {}) {

    const payload = {
        event,
        ts: Date.now(),
        appPagesResult: APP_PAGES.RESULT,
        appPagesGameplay: APP_PAGES.GAMEPLAY,
        ...sanitizePage6DiagFields(fields)
    };

    const key = options.key ?? event;

    const fingerprint = JSON.stringify(payload);

    if (!options.force && lastFingerprintByKey.get(key) === fingerprint) {

        return payload;

    }

    lastFingerprintByKey.set(key, fingerprint);

    console.info(PREFIX, payload);

    try {

        forwardPage6ClientDiag(event, payload, { force: options.force === true });

    } catch {

        // Diagnostics must never throw into UI paths.

    }

    return payload;

}

export function notePage6MountSnapshot(snapshot) {

    page6MountSnapshot = {
        currentPage: snapshot?.currentPage ?? null,
        currentPageType: typeof snapshot?.currentPage,
        source: snapshot?.source ?? "GameSessionContext.currentPage",
        resultSessionExpiresAt: Number.isFinite(snapshot?.resultSessionExpiresAt)
            ? snapshot.resultSessionExpiresAt
            : null,
        ts: Date.now()
    };

    return page6MountSnapshot;

}

export function clearPage6MountSnapshot() {

    page6MountSnapshot = null;

}

export function getPage6MountSnapshot() {

    return page6MountSnapshot;

}

/**
 * Classify the observed Page6 body / InfoBar footer combination.
 *
 * A — Page6 + neutral footer (no lifetime countdown)
 * B — Page5 + RESULT / 00:00 (healthy Page5 RESULT phase)
 * C — Page6 body + RESULT footer (critical failure / split)
 * D — other / inconclusive
 */
export function classifyPage6InfoBarCombination({
    page6Mounted = false,
    infoBarCurrentPage = null,
    footerMode = null,
    timerLabel = null,
    timerValue = null
} = {}) {

    const label = String(timerLabel ?? "");

    const value = String(timerValue ?? "");

    const infoBarOnResultPage = infoBarCurrentPage === APP_PAGES.RESULT
        || infoBarCurrentPage === 8;

    const infoBarOnGameplayPage = infoBarCurrentPage === APP_PAGES.GAMEPLAY
        || infoBarCurrentPage === 7;

    const neutralPage6Footer = footerMode === "PAGE6_NEUTRAL"
        || footerMode === "PAGE6_TIME_LEFT"
        || (infoBarOnResultPage && label === "—" && value === "—");

    const timeLeftFooter = /^TIME LEFT$/i.test(label)
        || /ОСТАЛОСЬ ВРЕМЕНИ/i.test(label);

    const resultFooter = footerMode === "PAGE5_RESULT_OR_GAMEPLAY"
        || /^RESULT$/i.test(label);

    if (page6Mounted && neutralPage6Footer && infoBarOnResultPage && !timeLeftFooter) {

        return "A_PAGE6_NEUTRAL";

    }

    // Legacy TIME LEFT on Page6 is still treated as Page6 (pre-R12.5H logs).
    if (page6Mounted && timeLeftFooter && infoBarOnResultPage) {

        return "A_PAGE6_NEUTRAL";

    }

    if (!page6Mounted && resultFooter && infoBarOnGameplayPage) {

        return "B_PAGE5_RESULT";

    }

    if (page6Mounted && resultFooter) {

        return "C_PAGE6_BODY_RESULT_FOOTER";

    }

    if (
        page6Mounted
        && infoBarCurrentPage != null
        && !infoBarOnResultPage
    ) {

        return "C_PAGE6_BODY_RESULT_FOOTER";

    }

    return "D_OTHER";

}

/**
 * Prove whether Page6 mount snapshot and InfoBar currentPage diverge.
 */
export function detectCurrentPageSourceSplit({
    page6CurrentPage,
    infoBarCurrentPage,
    page6Source = "GameSessionContext.currentPage",
    infoBarSource = "GameSessionContext.currentPage"
} = {}) {

    const sameValue = Object.is(page6CurrentPage, infoBarCurrentPage);

    const sameSource = page6Source === infoBarSource;

    return {
        sameValue,
        sameSource,
        splitDetected: page6CurrentPage != null
            && infoBarCurrentPage != null
            && !sameValue,
        page6CurrentPage,
        infoBarCurrentPage,
        page6Source,
        infoBarSource,
        page6CurrentPageType: typeof page6CurrentPage,
        infoBarCurrentPageType: typeof infoBarCurrentPage
    };

}

export function resetWebPage6DiagForTests() {

    lastFingerprintByKey.clear();

    page6MountSnapshot = null;

}
