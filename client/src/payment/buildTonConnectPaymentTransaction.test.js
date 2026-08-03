/**
 * R6.16B — TonConnect payment transaction builder unit checks.
 */

import assert from "node:assert/strict";
import { beginCell } from "@ton/core";

import {
    buildTonCommentPayload,
    buildTonConnectPaymentTransaction,
    requiredGramToNanotonString
} from "../payment/buildTonConnectPaymentTransaction.js";

assert.equal(requiredGramToNanotonString(10), "10000000000");
assert.equal(requiredGramToNanotonString("1"), "1000000000");

assert.throws(
    () => requiredGramToNanotonString(0),
    /positive/
);

assert.throws(
    () => requiredGramToNanotonString(null),
    /requiredGram/
);

const commentBoc = buildTonCommentPayload("payref_session_player");

assert.equal(typeof commentBoc, "string");
assert.ok(commentBoc.length > 0);

const decoded = beginCell()
    .storeUint(0, 32)
    .storeStringTail("payref_session_player")
    .endCell()
    .toBoc()
    .toString("base64");

assert.equal(commentBoc, decoded);

const nowMs = 1_700_000_000_000;

const tx = buildTonConnectPaymentTransaction({
    contractAddress: "EQescrowaddressfortestsXXXXXXXXXXXXXX",
    requiredGram: 25,
    paymentReference: "payref_abc_player1",
    validUntilSeconds: 600,
    nowMs
});

assert.equal(tx.validUntil, Math.floor(nowMs / 1000) + 600);
assert.equal(tx.messages.length, 1);
assert.equal(tx.messages[0].address, "EQescrowaddressfortestsXXXXXXXXXXXXXX");
assert.equal(tx.messages[0].amount, "25000000000");
assert.equal(
    tx.messages[0].payload,
    buildTonCommentPayload("payref_abc_player1")
);

assert.throws(
    () => buildTonConnectPaymentTransaction({
        contractAddress: "",
        requiredGram: 10,
        paymentReference: "ref"
    }),
    /contractAddress/
);

assert.throws(
    () => buildTonConnectPaymentTransaction({
        contractAddress: "EQ1",
        requiredGram: 10,
        paymentReference: ""
    }),
    /paymentReference/
);

console.log("buildTonConnectPaymentTransaction.test.js: all assertions passed");
