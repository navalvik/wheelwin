/**
 * R6.16B / R7.70C10 — TonConnect payment transaction builder unit checks.
 */

import assert from "node:assert/strict";
import { beginCell, Cell } from "@ton/core";

import {
    GAME_ESCROW_STAKE_OPCODE,
    buildGameEscrowStakePayload,
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
const escrowAddress = "EQescrowaddressfortestsXXXXXXXXXXXXXX";

// TEST 4 — intentional legacy comment mode (opt-in only).
const legacyTx = buildTonConnectPaymentTransaction({
    contractAddress: escrowAddress,
    requiredGram: 25,
    paymentReference: "payref_abc_player1",
    allowLegacyComment: true,
    validUntilSeconds: 600,
    nowMs
});

assert.equal(legacyTx.validUntil, Math.floor(nowMs / 1000) + 600);
assert.equal(legacyTx.messages.length, 1);
assert.equal(legacyTx.messages[0].address, escrowAddress);
assert.equal(legacyTx.messages[0].amount, "25000000000");
assert.equal(
    legacyTx.messages[0].payload,
    buildTonCommentPayload("payref_abc_player1")
);

assert.throws(
    () => buildTonConnectPaymentTransaction({
        contractAddress: "",
        requiredGram: 10,
        playerIndex: 0
    }),
    /contractAddress/
);

assert.throws(
    () => buildTonConnectPaymentTransaction({
        contractAddress: "EQ1",
        requiredGram: 10,
        paymentReference: "",
        allowLegacyComment: true
    }),
    /paymentReference/
);

// TEST 3 — missing playerIndex fails closed (no legacy comment, no tx object).
assert.throws(
    () => buildTonConnectPaymentTransaction({
        contractAddress: escrowAddress,
        requiredGram: 1,
        paymentReference: "payref_must_not_be_sent",
        nowMs
    }),
    /playerIndex is required for GameEscrow STAKE payment/
);

assert.throws(
    () => buildTonConnectPaymentTransaction({
        contractAddress: escrowAddress,
        requiredGram: 1,
        playerIndex: null,
        paymentReference: "payref_must_not_be_sent",
        nowMs
    }),
    /playerIndex is required for GameEscrow STAKE payment/
);

function decodeStakePayload(payloadBase64) {

    const slice = Cell.fromBase64(payloadBase64).beginParse();
    const opcode = slice.loadUint(32);
    const index = slice.loadUint(8);

    return { opcode, index };

}

// TEST 2 — GameEscrow STAKE for playerIndex 0 / 1 / 2 (decoded).
for (const index of [0, 1, 2]) {

    const stakeTx = buildTonConnectPaymentTransaction({
        contractAddress: escrowAddress,
        requiredGram: 1,
        playerIndex: index,
        paymentReference: "payref_ignored_when_stake",
        nowMs
    });

    assert.equal(stakeTx.messages.length, 1);
    assert.equal(stakeTx.messages[0].address, escrowAddress);
    assert.equal(stakeTx.messages[0].amount, "1000000000");
    assert.equal(
        stakeTx.messages[0].payload,
        buildGameEscrowStakePayload(index)
    );
    assert.notEqual(
        stakeTx.messages[0].payload,
        buildTonCommentPayload("payref_ignored_when_stake")
    );

    const decodedStake = decodeStakePayload(stakeTx.messages[0].payload);

    assert.equal(decodedStake.opcode, GAME_ESCROW_STAKE_OPCODE);
    assert.equal(decodedStake.index, index);

}

{
    const p0 = buildGameEscrowStakePayload(0);
    const p1 = buildGameEscrowStakePayload(1);
    const p2 = buildGameEscrowStakePayload(2);

    assert.notEqual(p0, p1);
    assert.notEqual(p1, p2);
    assert.notEqual(p0, p2);
}

console.log("buildTonConnectPaymentTransaction.test.js: all assertions passed");
