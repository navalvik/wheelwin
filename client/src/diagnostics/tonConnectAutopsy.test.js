/**
 * R18-S90 — sendTransaction rejection forensic persistence.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    captureErrorForensic,
    ensureTonConnectAutopsy,
    isTonConnectFailureStep,
    pushAutopsySdkError,
    pushAutopsyTimeline
} from "./tonConnectAutopsy.js";

function installAutopsyWindow() {

    globalThis.window = {
        __TONCONNECT_AUTOPSY__: undefined
    };

}

test("captureErrorForensic keeps original message, name, code, and nested cause", () => {

    const original = new Error("Unhandled error");
    original.name = "TonConnectError";
    original.code = "e";
    original.errorCode = "e";
    original.cause = {
        message: "bridge detail",
        code: 500
    };
    original.payload = { info: "wallet" };

    const forensic = captureErrorForensic(original);

    assert.equal(forensic.message, "Unhandled error");
    assert.equal(forensic.name, "TonConnectError");
    assert.equal(forensic.code, "e");
    assert.equal(forensic.raw.message, "Unhandled error");
    assert.equal(forensic.raw.name, "TonConnectError");
    assert.equal(forensic.raw.code, "e");
    assert.equal(forensic.raw.errorCode, "e");
    assert.equal(forensic.raw.cause.message, "bridge detail");
    assert.equal(forensic.raw.payload.info, "wallet");
    assert.equal(original.message, "Unhandled error");
    assert.equal(original.cause.message, "bridge detail");

});

test("pushAutopsySdkError stores the original sendTransaction rejection", () => {

    installAutopsyWindow();

    const original = new Error("Unhandled error");
    original.name = "TonConnectError";
    original.code = "e";

    const passed = original;
    const entry = pushAutopsySdkError(passed, {
        label: "PAGE4_SEND_TRANSACTION_REJECTION",
        roomId: "QWXS",
        playerIndex: 2
    });

    assert.equal(passed, original);
    assert.equal(entry.message, "Unhandled error");
    assert.equal(entry.name, "TonConnectError");
    assert.equal(entry.code, "e");
    assert.equal(entry.label, "PAGE4_SEND_TRANSACTION_REJECTION");

    const store = ensureTonConnectAutopsy();

    assert.equal(store.sdkErrors.length, 1);
    assert.equal(store.sdkErrors[0].message, "Unhandled error");
    assert.equal(store.rawObjects.length, 1);
    assert.equal(store.rawObjects[0].kind, "sdkError");
    assert.equal(store.rawObjects[0].value.message, "Unhandled error");

    pushAutopsyTimeline({
        event: "PAGE4_SEND_TRANSACTION_REJECTION",
        payloadSummary: { roomId: "QWXS" }
    });

    assert.equal(store.failureStep, "PAGE4_SEND_TRANSACTION_REJECTION");
    assert.equal(isTonConnectFailureStep("PAGE4_SEND_TRANSACTION_REJECTION"), true);

    delete globalThis.window;

});
