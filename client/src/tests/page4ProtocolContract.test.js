import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { INCOMING_SOCKET_EVENTS } from "../socket/socketEvents.js";

test("authoritative payment status provides the expected sender required by Page4", () => {
    const server = readFileSync(new URL("../../../server/socket/RoomLobbyBridge.js", import.meta.url), "utf8");
    const client = readFileSync(new URL("../pages/Page4Payment.jsx", import.meta.url), "utf8");
    assert.match(server, /expectedSenderWalletAddress: intent\.expectedSender/);
    assert.match(client, /expectedSender: payload\.expectedSenderWalletAddress/);
    assert.match(server, /paymentAcceptanceEnabled = LIVE_PAYMENT_ACCEPTANCE_ENABLED/);
    assert.match(server, /paymentAcceptanceEnabled: this\._paymentAcceptanceEnabled/);
});

test("Page4 initial PAYMENT_REQUEST event is registered and matches the server protocol", () => {
    const server = readFileSync(new URL("../../../server/socket/lobbyProtocol.js", import.meta.url), "utf8");
    const client = readFileSync(new URL("../pages/Page4Payment.jsx", import.meta.url), "utf8");
    assert.equal(INCOMING_SOCKET_EVENTS.PAYMENT_REQUEST, "PAYMENT_REQUEST");
    assert.match(server, /PAYMENT_REQUEST: "PAYMENT_REQUEST"/);
    assert.match(client, /INCOMING_SOCKET_EVENTS\.PAYMENT_REQUEST/);
    assert.match(client, /const handleInitialPaymentRequest/);
});
