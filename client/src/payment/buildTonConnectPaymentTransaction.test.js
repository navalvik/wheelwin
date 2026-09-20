import assert from "node:assert/strict";
import {
    GAME_ESCROW_STAKE_OPCODE,
    buildGameEscrowStakePayload,
    buildTonCommentPayload,
    buildTonConnectPaymentTransaction,
    requiredGramToNanotonString
} from "./buildTonConnectPaymentTransaction.js";

assert.equal(requiredGramToNanotonString(10), "10000000000");
assert.equal(requiredGramToNanotonString("1"), "1000000000");
assert.equal(GAME_ESCROW_STAKE_OPCODE, 0x5354414B);

assert.throws(() => buildTonCommentPayload("legacy"), /disabled/);
assert.throws(() => buildGameEscrowStakePayload(0), /disabled/);
assert.throws(() => buildTonConnectPaymentTransaction({
    contractAddress: "EQlegacy",
    requiredGram: 1
}), /disabled/);

const tx = buildTonConnectPaymentTransaction({
    contractAddress: "EQroomWallet",
    requiredGram: 1,
    plainTransfer: true,
    nowMs: 1700000000000
});
assert.equal(tx.messages.length, 1);
assert.equal(tx.messages[0].address, "EQroomWallet");
assert.equal(tx.messages[0].amount, "1000000000");
assert.equal(tx.messages[0].payload, undefined);
assert.equal(tx.validUntil, 1700000600);

console.log("buildTonConnectPaymentTransaction.test.js: all assertions passed");
