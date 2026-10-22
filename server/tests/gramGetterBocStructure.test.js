import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectGramGetterCodeBoc } from "../payment/toncenter/GramGetterBocStructure.js";
import { decodeGramWalletDataStack } from "../payment/toncenter/GramJettonGetterStackDecoder.js";

function checksum(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
    }
    const out = Buffer.alloc(4);
    out.writeUInt32LE((crc ^ 0xffffffff) >>> 0);
    return out;
}
function boc({ indexed = false, crc = false, extraUnreachable = false } = {}) {
    // Topological serialization: root cell has ref -> leaf, leaf has 8 data bits.
    const chunks = [
        Buffer.from([1, 0, 1]), // one ref, zero bits, ref to cell index 1
        Buffer.from([0, 2, 0x7a]) // no refs, eight data bits
    ];
    if (extraUnreachable) chunks.push(Buffer.from([0, 2, 0x01]));
    const data = Buffer.concat(chunks);
    const flags = 1 | (indexed ? 0x80 : 0) | (crc ? 0x40 : 0);
    const prefix = Buffer.from([
        0xb5, 0xee, 0x9c, 0x72, flags, 1, chunks.length, 1, 0,
        data.length, 0,
        ...(indexed ? chunks.map((_, i) =>
            chunks.slice(0, i + 1).reduce((sum, c) => sum + c.length, 0)) : [])
    ]);
    const headAndCells = Buffer.concat([prefix, data]);
    return Buffer.concat([headAndCells, ...(crc ? [checksum(headAndCells)] : [])]);
}
test("accept bounded ordinary two-cell code BOC with index and CRC32C", () => {
    for (const indexed of [false, true]) {
        for (const crc of [false, true]) {
            const parsed = inspectGramGetterCodeBoc(boc({ indexed, crc }).toString("base64"));
            assert.equal(parsed.cellCount, 2);
            assert.equal(parsed.referenceCount, 1);
            assert.equal(parsed.hasIndex, indexed);
            assert.equal(parsed.hasCrc32c, crc);
            assert.equal(parsed.authenticated, false);
            assert.equal(parsed.paymentCreditAuthorized, false);
        }
    }
});
test("tampered CRC, invalid index, exotic cell, cycles and dangling roots fail closed", () => {
    const original = boc({ indexed: true, crc: true });
    const mutate = (offset, newValue) => {
        const changed = Buffer.from(original); changed[offset] = newValue;
        return changed.toString("base64");
    };
    assert.throws(() => inspectGramGetterCodeBoc(mutate(original.length - 1, original.at(-1) ^ 0x01)), /CRC32C/);
    const originalIndexed = boc({ indexed: true });
    originalIndexed[11] ^= 1; // first index offset
    assert.throws(() => inspectGramGetterCodeBoc(originalIndexed.toString("base64")), /index/);
    const originalNoIndex = boc();
    originalNoIndex[11] = 9; // exotic/level flags
    assert.throws(() => inspectGramGetterCodeBoc(originalNoIndex.toString("base64")), /exotic/);
    assert.throws(() => inspectGramGetterCodeBoc(boc({ extraUnreachable: true }).toString("base64")), /unreachable/);
    assert.throws(() => inspectGramGetterCodeBoc("not BOC"), /Invalid GRAM getter/);
});

test("wallet getter stack accepts multi-cell ordinary code but never validates chain authenticity", () => {
    const address = "0:" + "a".repeat(64);
    const bits = [];
    const add = (value, n) => {
        const k = BigInt(value);
        for (let i = n - 1; i >= 0; i--) bits.push(Number((k >> BigInt(i)) & 1n));
    };
    add(2, 2); add(0, 1); add(0, 8);
    for (const byte of Buffer.from(address.slice(2), "hex")) add(byte, 8);
    const data = Buffer.alloc(34);
    bits.forEach((bit, i) => { if (bit) data[i >> 3] |= 1 << (7 - (i & 7)); });
    data[33] |= 1 << 4; // top-up for 267 bits
    const sliceBoc = Buffer.concat([
        Buffer.from([0xb5, 0xee, 0x9c, 0x72, 1, 1, 1, 1, 0, 36, 0, 0, 67]),
        data
    ]).toString("base64");
    const stack = {
        method: "get_wallet_data", exitCode: 0,
        resultStack: [
            { type: "num", value: "1" },
            { type: "slice", value: sliceBoc },
            { type: "slice", value: sliceBoc },
            { type: "cell", value: boc({ indexed: true, crc: true }).toString("base64") }
        ]
    };
    const out = decodeGramWalletDataStack(stack);
    assert.equal(out.ownerAddress, address);
    assert.equal(out.jettonMasterAddress, address);
    assert.equal(out.paymentCreditAuthorized, false);
});
