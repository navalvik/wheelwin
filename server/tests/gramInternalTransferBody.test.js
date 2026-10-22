import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeGramInternalTransferBody } from "../payment/toncenter/GramInternalTransferBody.js";
import { inspectIndexedGramInternalTransfer } from "../payment/toncenter/GramJettonInternalTransferInspection.js";
import { inspectIndexedGramRecipientExecution } from "../payment/toncenter/GramRecipientExecutionCheck.js";

const owner = "0:" + "a".repeat(64);
const response = "0:" + "b".repeat(64);

function write(bits, value, width) {
    const n = BigInt(value);
    for (let i = width - 1; i >= 0; i--) bits.push(Number((n >> BigInt(i)) & 1n));
}
function address(bits, raw) {
    const [wc, hash] = raw.split(":");
    write(bits, 2, 2); write(bits, 0, 1);
    write(bits, Number(wc) & 255, 8);
    for (const byte of Buffer.from(hash, "hex")) write(bits, byte, 8);
}
function varUint(bits, amount) {
    let n = BigInt(amount);
    const bytes = [];
    while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
    write(bits, bytes.length, 4);
    for (const byte of bytes) write(bits, byte, 8);
}
function cell(bits, refs = []) {
    const data = Buffer.alloc(Math.ceil(bits.length / 8));
    bits.forEach((bit, i) => { if (bit) data[i >> 3] |= 1 << (7 - (i & 7)); });
    if (bits.length % 8) data[data.length - 1] |= 1 << (7 - (bits.length % 8));
    return [refs.length, Math.floor(bits.length / 8) + Math.ceil(bits.length / 8), ...data, ...refs];
}
function body({ opcode = 0x178d4519, amount = "1500000000", sender = owner,
    ref = "room1-seat2", queryId = 42n, forwardTon = 1n } = {}) {
    const bits = [];
    write(bits, opcode, 32);
    write(bits, queryId, 64);
    varUint(bits, amount);
    address(bits, sender);
    address(bits, response);
    varUint(bits, forwardTon);
    write(bits, 1, 1); // payload in ref
    const comment = [];
    write(comment, 0, 32);
    for (const byte of Buffer.from("WW1:" + ref)) write(comment, byte, 8);
    const payload = [...cell(bits, [1]), ...cell(comment)];
    return Buffer.from([
        0xb5, 0xee, 0x9c, 0x72,
        0x01, 0x01, 0x02, 0x01, 0x00,
        payload.length, 0x00, ...payload
    ]).toString("base64");
}

test("strict binary TEP-74 internal_transfer decoder checks opcode, amount, sender and reference", () => {
    const result = decodeGramInternalTransferBody(body());
    assert.equal(result.opcode, 0x178d4519);
    assert.equal(result.queryId, "42");
    assert.equal(result.amountAtomic, "1500000000");
    assert.equal(result.sender, owner);
    assert.equal(result.responseDestination, response);
    assert.equal(result.paymentReference, "room1-seat2");
    assert.equal(result.forwardTonAmountAtomic, "1");
    assert.equal(result.validStructure, true);
    assert.equal(result.chainInclusionVerified, false);
    assert.equal(result.receiverSuccessVerified, false);
    assert.equal(result.paymentCreditAuthorized, false);
});

test("wrong opcode, zero amount, malformed reference and invalid BOC fail closed", () => {
    for (const fields of [
        { opcode: 0x0f8a7ea5 },
        { amount: "0" },
        { ref: "bad/reference" },
        { ref: "x".repeat(65) }
    ]) assert.throws(() => decodeGramInternalTransferBody(body(fields)), /Invalid TEP-74/);
    assert.throws(() => decodeGramInternalTransferBody("garbage"), /Invalid TEP-74/);
    assert.throws(() => decodeGramInternalTransferBody(""), /Invalid TEP-74/);
    assert.throws(() => decodeGramInternalTransferBody(body().slice(0, -4)), /Invalid TEP-74/);
});

test("decoder safely handles different VarUInteger16 amounts and query IDs", () => {
    for (const amount of ["1", "255", "256", "10000000000", "1208925819614629174706175"]) {
        const result = decodeGramInternalTransferBody(body({
            amount, queryId: 18446744073709551615n
        }));
        assert.equal(result.amountAtomic, amount);
        assert.equal(result.queryId, "18446744073709551615");
    }
});

test("indexed sender-receiver edge and strict internal_transfer agree but NEVER authorize GRAM credit", () => {
    const sourceWallet = "0:" + "c".repeat(64);
    const receiverWallet = "0:" + "d".repeat(64);
    const txHash = "1".repeat(64), receivingTx = "2".repeat(64),
        msgHash = "3".repeat(64), traceId = "4".repeat(64);
    const candidate = {
        sourceJettonWallet: sourceWallet, transactionHash: txHash,
        traceId, amountAtomic: "1500000000"
    };
    const trace = {
        trace_id: traceId, is_incomplete: false, trace_info: { pending_messages: 0 },
        trace: {
            tx_hash: txHash, transaction: {
                account: sourceWallet,
                out_msgs: [{ hash: msgHash, source: sourceWallet, destination: receiverWallet }]
            }, children: [{
                tx_hash: receivingTx, transaction: {
                    account: receiverWallet,
                    description: { type: "ord", aborted: false,
                        compute_ph: { skipped: false, success: true, exit_code: 0 },
                        action: { success: true, valid: true, no_funds: false, result_code: 0 } },
                    in_msg: { hash: msgHash, source: sourceWallet,
                        destination: receiverWallet, message_content: { body: body() } }
                }, children: []
            }]
        }
    };
    const args = {
        indexedTrace: trace, candidate, recipientJettonWallet: receiverWallet,
        expectedSender: owner, expectedAmountAtomic: "1500000000",
        expectedPaymentReference: "room1-seat2"
    };
    const result = inspectIndexedGramInternalTransfer(args);
    assert.equal(result.indexedInternalTransferDecoded, true);
    assert.equal(result.paymentReferenceHintMatched, true);
    assert.equal(result.onChainMessageBodyAuthenticated, false);
    assert.equal(result.indexedReceiverExecutionAppearsSuccessful, true);
    assert.equal(result.receiverExecutionVerified, false);
    assert.equal(result.jettonWalletMasterVerified, false);
    assert.equal(result.paymentCreditAuthorized, false);
    assert.equal(inspectIndexedGramInternalTransfer({
        ...args, expectedAmountAtomic: "1"
    }), null);
    assert.equal(inspectIndexedGramInternalTransfer({
        ...args, expectedPaymentReference: "other"
    }), null);
    assert.equal(inspectIndexedGramInternalTransfer({
        ...args, expectedSender: response
    }), null);
    trace.trace.children[0].transaction.in_msg.message_content.body =
        body({ opcode: 0x0f8a7ea5 });
    assert.equal(inspectIndexedGramInternalTransfer(args), null);
});


test("failed or incomplete recipient execution rejects otherwise matching TEP-74 internal transfer", () => {
    const source = "0:" + "c".repeat(64);
    const recipient = "0:" + "d".repeat(64);
    const edgeHash = "3".repeat(64);
    const base = {
        account: recipient,
        in_msg: { hash: edgeHash, source, destination: recipient },
        description: { type: "ord", aborted: false,
            compute_ph: { skipped: false, success: true, exit_code: 0 },
            action: { success: true, valid: true, no_funds: false, result_code: 0 } }
    };
    const check = tx => inspectIndexedGramRecipientExecution({
        receiverTransaction: tx, recipientJettonWallet: recipient,
        sourceJettonWallet: source, internalMessageHash: edgeHash
    });
    assert.equal(check(base).indexedReceiverExecutionAppearsSuccessful, true);
    for (const description of [
        { ...base.description, aborted: true },
        { ...base.description, type: "tick_tock" },
        { ...base.description, compute_ph: { skipped: true, success: true, exit_code: 0 } },
        { ...base.description, compute_ph: { skipped: false, success: true, exit_code: 13 } },
        { ...base.description, compute_ph: { skipped: false, success: true } },
        { ...base.description, action: { ...base.description.action, result_code: 7 } },
        { ...base.description, action: { success: true, valid: true } },
        { ...base.description, compute_ph: { skipped: false, success: false } },
        { ...base.description, action: { success: false, valid: true } },
        { ...base.description, action: { success: true, valid: false } },
        { ...base.description, action: { success: true, valid: true, no_funds: true } },
        { ...base.description, action: undefined },
        { ...base.description, compute_ph: undefined }
    ]) assert.equal(check({ ...base, description }), null);
    assert.equal(check({ ...base, in_msg: { ...base.in_msg, bounced: true } }), null);
    assert.equal(check({ ...base, in_msg: { ...base.in_msg, hash: "4".repeat(64) } }), null);
    assert.equal(check({ ...base, in_msg: { ...base.in_msg, source: recipient } }), null);
    assert.equal(check({ ...base, description: null }), null);
});
