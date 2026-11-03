import assert from "node:assert/strict";
import { Address } from "@ton/core";
import { getMainnetPlayerPaymentStatus, normalizeMainnetPaymentRequest } from "./mainnetPaymentRequest.js";

const payerAddress = new Address(0, Buffer.alloc(32, 1)).toRawString();
const destination = new Address(0, Buffer.alloc(32, 2)).toRawString();
const base = {
    roomId: "room-6WCn", playerId: "player-1", paymentReference: "WW_test-1",
    payerAddress, destination, amountAtomic: "2500000000", asset: "TON",
    network: "mainnet", expiresAt: 2_000_000_000_000
};
const context = { roomId: base.roomId, playerId: base.playerId,
    paymentAcceptanceEnabled: true, now: 1_900_000_000_000 };

assert.deepEqual(normalizeMainnetPaymentRequest(base, context), {
    roomId: base.roomId, playerId: base.playerId, paymentReference: base.paymentReference,
    payerAddress, destinationWalletAddress: destination, amountAtomic: 2_500_000_000,
    asset: "TON", network: "mainnet", expiresAt: base.expiresAt,
    paymentAcceptanceEnabled: true
});
for (const changed of [
    { roomId: "other-room" }, { playerId: "other-player" }, { network: "testnet" },
    { amountAtomic: "9007199254740992" }, { amountAtomic: "2.5" },
    { payerAddress: "bad-address" }, { destination: "bad-address" },
    { expiresAt: context.now }, { asset: "JETTON" }
]) {
    assert.equal(normalizeMainnetPaymentRequest({ ...base, ...changed }, context), null);
}
assert.equal(normalizeMainnetPaymentRequest(base, {
    ...context, paymentAcceptanceEnabled: false
}), null);
assert.equal(normalizeMainnetPaymentRequest(base, {
    ...context, playerId: "wrong-player"
}), null);
assert.equal(getMainnetPlayerPaymentStatus("PENDING"), "Waiting for payments");
assert.equal(getMainnetPlayerPaymentStatus("SETTLED"), "Payment verified");
assert.equal(getMainnetPlayerPaymentStatus(undefined), "Waiting for payments");
process.stdout.write("mainnetPaymentRequest tests passed\n");
