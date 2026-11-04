import assert from "node:assert/strict";

import {
    CLIENT_PAGE_NAMES,
    createClientPageConfirmation,
    createClientPageConfirmationOutbox,
    inspectPageUi,
    nextClientPageSequence
} from "./clientPageConfirmation.js";
import { reduceGameClockUpdate } from "../gameClock/gameClockView.js";
import {
    resolveGameplayRecoveryPage,
    shouldBlockNavigationRegression,
    APP_PAGES
} from "../sessionRecovery/recoveryFlow.js";

const transitionPages = [1, 2, 3, 4, 5, 6, 7, 8];
const events = transitionPages.map((page, index) => createClientPageConfirmation({
    roomId: "room-a",
    gameId: page >= 7 ? "game-a" : null,
    playerId: "player-a",
    page,
    sequenceNumber: index + 1,
    clientEventAt: 1_000 + index,
    requestedPage: page,
    requestedFromPage: page - 1,
    navigationRequestedAt: 900 + index,
    uiState: { mounted: true, visible: true, documentVisible: true, topmostAtSample: true }
}));
assert.deepEqual(events.map((event) => event.page), transitionPages.map((page) => CLIENT_PAGE_NAMES[page]));
assert.equal(events[5].roomId, "room-a");
assert.equal(events[6].gameId, "game-a");
assert.equal(events[0].uiState.mounted, true);
assert.equal(events[0].requestedPage, "PAGE1_WELCOME");
assert.equal(events[0].uiState.appliedPage, "PAGE1_WELCOME");
assert.equal(events[0].navigationRequestedAt, 900);
assert.equal(nextClientPageSequence(8, 12), 13);

// A disconnected client records only its latest local route and replays that
// one state after reconnect, instead of flushing stale transitions in order.
const outbox = createClientPageConfirmationOutbox();
const sent = [];
outbox.publish(events[5], false, (event) => sent.push(event));
outbox.publish(events[6], false, (event) => sent.push(event));
assert.equal(sent.length, 0);
assert.equal(outbox.replay(true, (event) => sent.push(event)).page, "PAGE5_GAME");
assert.deepEqual(sent.map((event) => event.page), ["PAGE5_GAME"]);
outbox.publish(events[7], true, (event) => sent.push(event));
assert.deepEqual(sent.map((event) => event.page), ["PAGE5_GAME", "PAGE6_RESULT"]);

// The confirmation reflects a committed route DOM and reports overlays and
// topmost evidence separately; it does not claim to observe the physical phone.
const pageChild = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    getAttribute: () => null,
    tagName: "MAIN"
};
const root = {
    childElementCount: 1,
    querySelectorAll: () => [pageChild],
    contains: (element) => element === pageChild
};
const documentMock = {
    visibilityState: "visible",
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) },
    querySelector: () => root,
    querySelectorAll: () => [],
    elementFromPoint: () => pageChild
};
const inspected = inspectPageUi(documentMock, "PAGE4_PAYMENT");
assert.equal(inspected.mounted, true);
assert.equal(inspected.visible, true);
assert.equal(inspected.topmostAtSample, true);
assert.equal(inspectPageUi({ ...documentMock, visibilityState: "hidden" }, "PAGE4_PAYMENT").visible, false);
const dialog = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    getAttribute: (name) => name === "aria-label" ? "Payment dialog" : null,
    tagName: "DIV"
};
const coveredUi = inspectPageUi({
    ...documentMock,
    querySelectorAll: () => [dialog],
    elementFromPoint: () => dialog
}, "PAGE4_PAYMENT");
assert.equal(coveredUi.visible, false, "a full-screen dialog covering the route is reported separately");
assert.deepEqual(coveredUi.blockingUi, ["Payment dialog"]);

// Reconnect routing remains based on the authoritative snapshot, not a local
// Page4 timer or client confirmation.
assert.equal(resolveGameplayRecoveryPage({ gameState: "SPEED", openPage6: false }), APP_PAGES.GAMEPLAY);
assert.equal(resolveGameplayRecoveryPage({ gameState: "RESULT", openPage6: true }), APP_PAGES.RESULT);
assert.equal(shouldBlockNavigationRegression(APP_PAGES.RESULT, APP_PAGES.GAMEPLAY), true,
    "a stale Page5 recovery hint cannot demote an already open Page6");

// Older timer snapshots cannot replace newer authoritative phase/time data.
let clock = reduceGameClockUpdate({
    gameId: "game-a", phase: "SPEED", remainingMs: 4_000, serverTimestamp: 20
});
const afterOlderSnapshot = reduceGameClockUpdate({
    gameId: "game-a", phase: "SELF_TEST", remainingMs: 8_000, serverTimestamp: 19
}, clock);
assert.equal(afterOlderSnapshot, clock);
const afterDelayedSamePhase = reduceGameClockUpdate({
    gameId: "game-a", phase: "SPEED", remainingMs: 5_000, serverTimestamp: 21
}, clock);
assert.equal(afterDelayedSamePhase, clock);

console.log("clientPageConfirmation.r60.test.js: all assertions passed");
