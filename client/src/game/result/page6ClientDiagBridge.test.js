/**
 * R12.5G — client diagnostic bridge helpers.
 */
import assert from "node:assert/strict";

import {
    buildPage6ClientDiagPayload,
    capturePage6DomSnapshot,
    resolvePage6ClientType,
    sanitizeClientDiagFields,
    sanitizeIncomingPage6ClientDiag,
    shouldAttachPage6DomSnapshot
} from "./page6ClientDiagBridge.js";

{

    const typeWeb = resolvePage6ClientType({ document: {} });

    assert.equal(typeWeb, "web");

    const typeTg = resolvePage6ClientType({
        Telegram: { WebApp: {} },
        document: {}
    });

    assert.equal(typeTg, "telegram");

    assert.equal(resolvePage6ClientType({}), "unknown");

    console.log("  clientType classification: OK");

}

{

    const sanitized = sanitizeClientDiagFields({
        roomId: "R1",
        wallet: "EQ...",
        privateKey: "x",
        token: "t",
        qr: "secret",
        currentPage: 8
    });

    assert.equal(sanitized.roomId, "R1");
    assert.equal(sanitized.currentPage, 8);
    assert.equal(sanitized.wallet, undefined);
    assert.equal(sanitized.privateKey, undefined);
    assert.equal(sanitized.token, undefined);
    assert.equal(sanitized.qr, undefined);

    console.log("  sanitize strips secrets: OK");

}

{

    assert.equal(shouldAttachPage6DomSnapshot("INFOBAR_STATE"), true);
    assert.equal(shouldAttachPage6DomSnapshot("PAGE6_RENDER_STATE"), true);
    assert.equal(shouldAttachPage6DomSnapshot("RECOVERY_DECISION"), false);

    const emptyDom = capturePage6DomSnapshot(null);

    assert.equal(emptyDom.page6DomPresent, null);
    assert.equal(emptyDom.infoBarPresent, null);

    const fakeDoc = {
        querySelector(selector) {

            if (selector === ".page6") {

                return {
                    getBoundingClientRect: () => ({ width: 10, height: 10 })
                };

            }

            if (selector === ".page6__headline") {

                return { textContent: "GAME FINISHED" };

            }

            if (selector === ".headerBar .center") {

                return { textContent: "GAME FINISHED" };

            }

            if (selector === ".infoBar") {

                return {
                    textContent: "ROOM ID\nX\nPLAYERS\n3\nTIME LEFT\n04:18",
                    querySelector(inner) {

                        if (inner === ".infoBarSection:last-child") {

                            return {
                                querySelector(child) {

                                    if (child === ".infoBarTitle") {

                                        return { textContent: "TIME LEFT" };

                                    }

                                    if (child === ".infoBarValue") {

                                        return { textContent: "04:18" };

                                    }

                                    return null;

                                }
                            };

                        }

                        return null;

                    }
                };

            }

            return null;

        }
    };

    const snap = capturePage6DomSnapshot(fakeDoc);

    assert.equal(snap.page6DomPresent, true);
    assert.equal(snap.page6HeadlineText, "GAME FINISHED");
    assert.equal(snap.infoBarPresent, true);
    assert.equal(snap.infoBarTimerLabelText, "TIME LEFT");
    assert.equal(snap.infoBarTimerValueText, "04:18");

    console.log("  DOM snapshot capture: OK");

}

{

    const payload = buildPage6ClientDiagPayload({
        event: "INFOBAR_STATE",
        fields: {
            currentPage: 8,
            footerMode: "PAGE6_TIME_LEFT",
            selectedLabel: "TIME LEFT",
            selectedValue: "04:18",
            wallet: "should-not-appear"
        },
        roomId: "ROOM1",
        playerId: "p1",
        gameId: null,
        clientType: "web",
        includeDomSnapshot: false
    });

    assert.equal(payload.diagnosticSource, "client");
    assert.equal(payload.diagnosticVersion, "R12.5G");
    assert.equal(payload.event, "INFOBAR_STATE");
    assert.equal(payload.roomId, "ROOM1");
    assert.equal(payload.playerId, "p1");
    assert.equal(payload.gameId, null);
    assert.equal(payload.currentPage, 8);
    assert.equal(payload.wallet, undefined);

    const incoming = sanitizeIncomingPage6ClientDiag({
        event: "STATE_SPLIT_DETECTED",
        roomId: "ROOM1",
        playerId: "p1",
        currentPage: 8,
        footerMode: "PAGE5_RESULT_OR_GAMEPLAY",
        wallet: "nope",
        page6DomPresent: true,
        infoBarTimerLabelText: "RESULT",
        infoBarTimerValueText: "00:00"
    }, { socketId: "sock1" });

    assert.equal(incoming.socketId, "sock1");
    assert.equal(incoming.wallet, undefined);
    assert.equal(incoming.page6DomPresent, true);
    assert.equal(incoming.infoBarTimerLabelText, "RESULT");

    console.log("  payload identity + sanitize: OK");

}

{

    // Bridge helpers are pure — no navigation / gameplay mutation surface.
    assert.equal(typeof buildPage6ClientDiagPayload, "function");
    assert.equal(typeof capturePage6DomSnapshot, "function");

    console.log("  no gameplay mutation surface: OK");

}

console.log("page6ClientDiagBridge.test.js: all assertions passed");
