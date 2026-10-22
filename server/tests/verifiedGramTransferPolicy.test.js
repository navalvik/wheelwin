import assert from "node:assert/strict";
import { test } from "node:test";
import { requireVerifiedGramTransfer } from "../payment/incoming/VerifiedGramTransferPolicy.js";

const master = "0:" + "a".repeat(64);
const sender = "0:" + "b".repeat(64);
const recipient = "0:" + "c".repeat(64);
const wrong = "0:" + "d".repeat(64);

function crc16(bytes) {
    let crc = 0;
    for (const byte of bytes) {
        crc ^= byte << 8;
        for (let i = 0; i < 8; i++) crc = (crc & 0x8000)
            ? ((crc << 1) ^ 0x1021) & 0xffff
            : (crc << 1) & 0xffff;
    }
    return crc;
}
function friendly(raw, tag = 0x91) {
    const [wc, hash] = raw.split(":");
    const bytes = Buffer.concat([
        Buffer.from([tag, Number(wc) & 255]),
        Buffer.from(hash, "hex")
    ]);
    const checksum = crc16(bytes);
    return Buffer.concat([bytes, Buffer.from([checksum >> 8, checksum & 255])])
        .toString("base64url");
}

const expected = {
    expectedTokenMaster: master,
    expectedSender: sender,
    expectedRecipient: recipient,
    expectedAmountAtomic: "1500000000",
    expectedPaymentReference: "payment-ref"
};
const valid = {
    asset: "GRAM",
    kind: "VERIFIED_JETTON_TRANSFER",
    finalized: true,
    aborted: false,
    tokenMaster: master,
    sender: sender,
    recipient: recipient,
    amountAtomic: "1500000000",
    paymentReference: "payment-ref",
    transactionId: "tx-1"
};

test("native TON transfer cannot confirm GRAM stake", () => {
    assert.throws(() => requireVerifiedGramTransfer({
        ...valid, asset: "TON", kind: "NATIVE_TON_TRANSFER"
    }, expected), /GRAM payment requires/);
});

test("GRAM token master, sender, recipient, amount and reference must all match", () => {
    for (const field of ["tokenMaster", "sender", "recipient", "amountAtomic", "paymentReference"]) {
        assert.throws(() => requireVerifiedGramTransfer({
            ...valid, [field]: ["tokenMaster", "sender", "recipient"].includes(field) ? wrong : "wrong"
        }, expected), /does not match/);
    }
});

test("unfinalized or aborted token event cannot confirm payment", () => {
    assert.throws(() => requireVerifiedGramTransfer({
        ...valid, finalized: false
    }, expected), /finalized/);
    assert.throws(() => requireVerifiedGramTransfer({
        ...valid, aborted: true
    }, expected), /finalized/);
});

test("matching finalized GRAM evidence returns only transaction identity and amount", () => {
    assert.deepEqual(requireVerifiedGramTransfer(valid, expected), {
        transactionId: "tx-1", asset: "GRAM", amountAtomic: "1500000000"
    });
});

test("friendly Testnet and raw addresses for identical TON accounts match", () => {
    const alternate = {
        ...valid,
        tokenMaster: friendly(master, 0x91),
        sender: friendly(sender, 0xd1),
        recipient: friendly(recipient, 0x11)
    };
    assert.deepEqual(requireVerifiedGramTransfer(alternate, expected), {
        transactionId: "tx-1", asset: "GRAM", amountAtomic: "1500000000"
    });
});

test("malformed addresses are rejected even when expected and observed text are equal", () => {
    assert.throws(() => requireVerifiedGramTransfer({
        ...valid, tokenMaster: "not-a-real-address"
    }, { ...expected, expectedTokenMaster: "not-a-real-address" }), /does not match/);
    assert.throws(() => requireVerifiedGramTransfer({
        ...valid, sender: "not-a-real-address"
    }, { ...expected, expectedSender: "not-a-real-address" }), /does not match/);
    assert.throws(() => requireVerifiedGramTransfer({
        ...valid, recipient: "not-a-real-address"
    }, { ...expected, expectedRecipient: "not-a-real-address" }), /does not match/);
});
