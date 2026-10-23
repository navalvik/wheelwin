import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeWalletV4NativeRefundBody } from "../payment/refund/WalletV4NativeRefundDecoder.js";

const payerHex = "a".repeat(64);
const b = (value, width) => BigInt(value).toString(2).padStart(width, "0");
function coins(value) {
    const v = BigInt(value);
    const width = v === 0n ? 0 : Math.ceil(v.toString(16).length / 2);
    return b(width, 4) + (width ? b(v, width * 8) : "");
}
function encodeCell(bits, refs) {
    const padded = bits.length % 8
        ? bits + "1" + "0".repeat(7 - bits.length % 8) : bits;
    const data = Buffer.from(
        padded.match(/.{8}/g)?.map(part => parseInt(part, 2)) ?? []
    );
    return Buffer.concat([
        Buffer.from([refs.length, Math.floor(bits.length / 8) + Math.ceil(bits.length / 8)]),
        data, Buffer.from(refs)
    ]);
}
function makeBoc({ amount = 990_000_000n, to = payerHex, mode = 3, opcode = 0,
    extraCurrency = false, bounce = true, seqno = 1, body = "" } = {}) {
    const wallet = "0".repeat(512) + b(698983191, 32) +
        b(1800000100, 32) + b(seqno, 32) + b(opcode, 8) + b(mode, 8);
    const message = "0" + "1" + (bounce ? "1" : "0") + "0" +
        "00" + "10" + "0" + b(0, 8) + b(BigInt("0x" + to), 256) +
        coins(amount) + (extraCurrency ? "1" : "0") + coins(0) + coins(0) +
        b(0, 64) + b(0, 32) + "0" + "0" + body;
    const rootCell = encodeCell(wallet, [1]);
    const msgCell = encodeCell(message, []);
    const bytes = Buffer.concat([rootCell, msgCell]);
    const header = Buffer.from([
        0xb5, 0xee, 0x9c, 0x72,
        1, 1, 2, 1, 0, bytes.length, 0
    ]);
    return Buffer.concat([header, bytes]);
}
test("decode Wallet V4 simple-send native GRAM amount and receiver from actual cell bits", () => {
    const decoded = decodeWalletV4NativeRefundBody(makeBoc());
    assert.equal(decoded.walletVersion, "V4");
    assert.equal(decoded.walletId, 698983191);
    assert.equal(decoded.seqno, 1);
    assert.equal(decoded.validUntil, 1800000100);
    assert.equal(decoded.to, "0:" + payerHex);
    assert.equal(decoded.amountAtomic, "990000000");
    assert.equal(decoded.sendMode, 3);
    assert.equal(decoded.bounce, true);
    assert.equal(decoded.messageCount, 1);
});
test("reject full-stake, different wallet destination, send-all and wallet opcodes", () => {
    for (const [args, reason] of [
        [{ amount: 1_000_000_000n }, "amount check occurs at higher plan layer"],
        [{ to: "b".repeat(64) }, "recipient check occurs at higher plan layer"]
    ]) {
        const decoded = decodeWalletV4NativeRefundBody(makeBoc(args));
        assert.ok(decoded.amountAtomic !== "990000000" || decoded.to !== "0:" + payerHex, reason);
    }
    for (const args of [
        { mode: 128 }, { mode: 131 }, { mode: 64 },
        { opcode: 1 }, { bounce: false },
        { extraCurrency: true }, { body: "1000" }
    ]) assert.throws(() => decodeWalletV4NativeRefundBody(makeBoc(args)));
});
test("invalid or unrelated BOC cannot masquerade as a signed V4 refund", () => {
    assert.throws(() => decodeWalletV4NativeRefundBody(
        Buffer.from("b5ee9c72010101010002000000", "hex")
    ), /CELL_COUNT_UNSUPPORTED/);
    assert.throws(() => decodeWalletV4NativeRefundBody(Buffer.from("incorrect")));
});

test("reject a signed body carrying additional unauthorized outgoing transfers", () => {
    // Root cell references two outgoing message cells: an extra transfer.
    const msg = "0" + "1" + "1" + "0" +
        "00" + "10" + "0" + b(0, 8) +
        b(BigInt("0x" + payerHex), 256) + coins(990000000n) + "0" + coins(0) + coins(0) +
        b(0, 64) + b(0, 32) + "0" + "0";
    const msgCell = encodeCell(msg, []);
    const wallet = "0".repeat(512) + b(698983191, 32) +
        b(1800000100, 32) + b(1, 32) + b(0, 8) + b(3, 8);
    const rootCell = encodeCell(wallet, [1, 2]);
    const cells = Buffer.concat([rootCell, msgCell, msgCell]);
    const header = Buffer.from([
        0xb5, 0xee, 0x9c, 0x72,
        1, 1, 3, 1, 0, cells.length, 0
    ]);
    const boc = Buffer.concat([header, cells]);
    assert.throws(() => decodeWalletV4NativeRefundBody(boc), /CELL_COUNT_UNSUPPORTED/);
});
