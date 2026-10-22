import test from "node:test";
import assert from "node:assert/strict";
import { buildGramJettonTransferBody } from "./gramJettonPayload.js";

const ADDRESS = "0:" + "00".repeat(32);
const request = (amountAtomic) => ({
    amountAtomic,
    recipient: ADDRESS,
    responseDestination: ADDRESS,
    reference: "room-1-seat-2"
});

function rootBits(bocBase64) {
    const bytes = Buffer.from(bocBase64, "base64");
    assert.equal(bytes.subarray(0, 4).toString("hex"), "b5ee9c72");
    const rootStart = 11;
    const refs = bytes[rootStart];
    const descriptor = bytes[rootStart + 1];
    assert.equal(refs, 1);
    const byteLength = Math.ceil(descriptor / 2);
    const data = bytes.subarray(rootStart + 2, rootStart + 2 + byteLength);
    const bits = [...data].map(b => b.toString(2).padStart(8, "0")).join("");
    return descriptor % 2 ? bits.slice(0, bits.lastIndexOf("1")) : bits;
}

test("TEP-74 opcode and 4-bit VarUInteger16 length precede jetton amount", () => {
    for (const [amount, byteCount, hex] of [
        ["1", 1, "01"],
        ["127", 1, "7f"],
        ["128", 1, "80"],
        ["256", 2, "0100"],
        ["1000000000", 4, "3b9aca00"]
    ]) {
        const bits = rootBits(buildGramJettonTransferBody(request(amount)));
        assert.equal(parseInt(bits.slice(0, 32), 2), 0x0f8a7ea5);
        assert.equal(parseInt(bits.slice(96, 100), 2), byteCount);
        const valueBits = bits.slice(100, 100 + byteCount * 8);
        assert.equal(BigInt("0b" + valueBits), BigInt(amount), hex);
    }
});

test("invalid atomic amount and malformed recipient are rejected", () => {
    assert.throws(() => buildGramJettonTransferBody(request("1.5")), /invalid GRAM amount/);
    assert.throws(() => buildGramJettonTransferBody({ ...request("1"), recipient: "invalid" }), /invalid TON address/);
});

test("amounts exceeding VarUInteger16 capacity fail closed", () => {
    assert.throws(() => buildGramJettonTransferBody(request((1n << 120n).toString())), /exceeds VarUInteger16/);
});

test("BOC root descriptor and top-up bit preserve unaligned payload", () => {
    const bytes = Buffer.from(buildGramJettonTransferBody(request("1")), "base64");
    assert.equal(bytes[4], 1); // no index, no CRC, one-byte counters
    assert.equal(bytes[6], 2); // root + comment cell
    assert.equal(bytes[10], 0); // root cell index
    const rootDescriptor = bytes[12];
    assert.equal(rootDescriptor % 2, 1); // unaligned root
    const rootByteLength = Math.ceil(rootDescriptor / 2);
    const lastRootByte = bytes[13 + rootByteLength - 1];
    assert.notEqual(lastRootByte, 0);
    const bits = rootBits(bytes.toString("base64"));
    assert.equal(bits.slice(-1), "1"); // ref branch selector (forward_payload in ref)
});

test("comment cell limit is enforced before BOC serialization", () => {
    assert.doesNotThrow(() => buildGramJettonTransferBody({ ...request("1"), reference: "a".repeat(119) }));
    assert.throws(
        () => buildGramJettonTransferBody({ ...request("1"), reference: "a".repeat(120) }),
        /invalid payment reference/
    );
});

test("forward TON amount is encoded as VarUInteger16 one-byte value", () => {
    const bits = rootBits(buildGramJettonTransferBody(request("1")));
    assert.equal(bits.slice(-14), "0" + "0001" + "00000001" + "1");
});
