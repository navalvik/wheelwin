import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    LIVE_PAYMENT_ACCEPTANCE_ENABLED,
    LIVE_PAYMENT_ACCEPTANCE_DISABLED_REASON,
    assertLivePaymentAcceptanceEnabled
} from "../../payment/PaymentLifecycleAvailability.js";
import { buildTestnetOutgoingRefundProvider } from "../../payment/runtime/PaymentRuntimeFactory.js";

test("live payment acceptance remains fail-closed without executable refund signer", () => {
    assert.equal(LIVE_PAYMENT_ACCEPTANCE_ENABLED, false);
    assert.equal(LIVE_PAYMENT_ACCEPTANCE_DISABLED_REASON, "REFUND_EXECUTION_NOT_READY");
    assert.throws(assertLivePaymentAcceptanceEnabled, /REFUND_EXECUTION_NOT_READY/);
    assert.equal(buildTestnetOutgoingRefundProvider({
        submitter: null,
        globalId: -3,
        finalityEvidenceProvider: null
    }), null);
});

test("payment status cannot advertise intake when live acceptance is disabled", () => {
    const bridge = readFileSync(new URL("../../socket/RoomLobbyBridge.js", import.meta.url), "utf8");
    assert.match(bridge, /paymentAcceptanceEnabled: LIVE_PAYMENT_ACCEPTANCE_ENABLED/);
    assert.match(bridge, /expectedSenderWalletAddress: intent\.expectedSender/);
    assert.match(bridge, /status: "PAYMENT_UNAVAILABLE"/);
});

test("a MATCHED incoming transfer is not offered for payment again before finality", () => {
    const bridge = readFileSync(new URL("../../socket/RoomLobbyBridge.js", import.meta.url), "utf8");
    const client = readFileSync(new URL("../../../client/src/pages/Page4Payment.jsx", import.meta.url), "utf8");
    const pending = bridge.indexOf("} else if (intent.state === PAYMENT_INTENT_STATE.PENDING) {");
    const matched = bridge.indexOf("} else if (intent.state === PAYMENT_INTENT_STATE.MATCHED) {", pending);
    const terminal = bridge.indexOf("} else {", matched);
    assert.ok(pending >= 0 && matched > pending && terminal > matched);
    assert.match(bridge.slice(pending, matched), /status = "AWAITING_PAYMENT"/);
    assert.match(bridge.slice(matched, terminal), /status = "CONFIRMING_PAYMENT"/);
    assert.ok(client.includes('status === "AWAITING_PAYMENT"'));
    assert.ok(client.includes('status === "CONFIRMING_PAYMENT"'));
    assert.ok(client.includes("Do not pay again."));
});
