import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

test("authoritative payment status provides the expected sender required by Page4", () => {
    const server = readFileSync(new URL("../../../server/socket/RoomLobbyBridge.js", import.meta.url), "utf8");
    const client = readFileSync(new URL("../pages/Page4Payment.jsx", import.meta.url), "utf8");
    assert.match(server, /expectedSenderWalletAddress: intent\.expectedSender/);
    assert.match(client, /expectedSender: payload\.expectedSenderWalletAddress/);
    assert.match(server, /paymentAcceptanceEnabled: LIVE_PAYMENT_ACCEPTANCE_ENABLED/);
});
