import test from "node:test";
import assert from "node:assert/strict";
import { Cell } from "@ton/core";
import { Buffer } from "buffer";
import { buildRoomWalletTonConnectRequest, payerMatchesConnectedWallet } from "../src/payment/buildRoomWalletTonConnectRequest.js";

const FROM = "0:" + "a".repeat(64);
const TO = "0:" + "b".repeat(64);
const NOW = 1789000000000;
function request(overrides = {}) {
    return {
        paymentAcceptanceEnabled: true, status: "AWAITING_PAYMENT",
        network: "testnet", asset: "TON",
        payerAddress: FROM, destinationWalletAddress: TO,
        amountAtomic: 2_500_000_000,
        paymentReference: "WW_pay123", expiresAt: NOW + 250_000,
        ...overrides
    };
}

test("single native TON transfer to room, with authentic WW1 text memo", () => {
    const tx = buildRoomWalletTonConnectRequest(request(), NOW);
    assert.equal(tx.network, "-3");
    assert.equal(tx.validUntil, Math.floor((NOW + 250_000) / 1000));
    assert.equal(tx.messages.length, 1);
    assert.equal(tx.messages[0].address, TO);
    assert.equal(tx.messages[0].amount, "2500000000");
    assert.deepEqual(Object.keys(tx.messages[0]).sort(), ["address", "amount", "payload"]);
    const cell = Cell.fromBoc(Buffer.from(tx.messages[0].payload, "base64"))[0];
    const slice = cell.beginParse();
    assert.equal(slice.loadUint(32), 0);
    assert.equal(slice.loadStringTail(), "WW1:WW_pay123");
});
test("wallet must be same account and explicitly connected to Testnet", () => {
    assert.equal(payerMatchesConnectedWallet(FROM, {account:{address:FROM,chain:"-3"}}), true);
    assert.equal(payerMatchesConnectedWallet(FROM, {account:{address:FROM,chain:"-239"}}), false);
    assert.equal(payerMatchesConnectedWallet(FROM, {account:{address:TO,chain:"-3"}}), false);
    assert.equal(payerMatchesConnectedWallet(FROM, null), false);
});
test("do not request payment when authority, amount, deadline, or chain is wrong", () => {
    for (const modified of [
        {paymentAcceptanceEnabled:false}, {status:"SETTLED"},
        {network:"mainnet"}, {asset:"JETTON"},
        {amountAtomic:0},{amountAtomic:NaN},
        {paymentReference:"bad ref"},{destinationWalletAddress:FROM},
        {destinationWalletAddress:"not-address"},{payerAddress:"not-address"},
        {expiresAt:NOW-1}
    ]) {
        assert.throws(() => buildRoomWalletTonConnectRequest(request(modified),NOW));
    }
});
test("TonConnect expiry is capped at five minutes and bounded by actual session", () => {
    const tx=buildRoomWalletTonConnectRequest(request({expiresAt:NOW+900_000}),NOW);
    assert.equal(tx.validUntil,Math.floor(NOW/1000)+300);
});
