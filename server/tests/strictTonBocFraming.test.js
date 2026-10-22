import assert from "node:assert/strict";
import { test } from "node:test";
import { isStructurallyValidTonBoc } from "../payment/refund/StrictTonBocFraming.js";

const EMPTY = Buffer.from("b5ee9c72010101010002000000", "hex");
const ONE_BYTE = Buffer.from("b5ee9c72010101010003000002a0", "hex");
function crc32c(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
        }
    }
    return (~crc) >>> 0;
}
test("valid one-root TON BOC framing and CRC32C are accepted", () => {
    assert.equal(isStructurallyValidTonBoc(EMPTY), true);
    assert.equal(isStructurallyValidTonBoc(ONE_BYTE), true);
    const withCrc = Buffer.from(EMPTY);
    withCrc[4] |= 0x40;
    const footer = Buffer.alloc(4);
    footer.writeUInt32LE(crc32c(withCrc));
    assert.equal(isStructurallyValidTonBoc(Buffer.concat([withCrc, footer])), true);
    const tampered = Buffer.concat([withCrc, footer]);
    tampered[tampered.length - 1] ^= 1;
    assert.equal(isStructurallyValidTonBoc(tampered), false);
});
test("truncated, fake magic, extra bytes and invalid cells all fail closed", () => {
    for (const mutation of [
        Buffer.from("b5ee9c72", "hex"),
        Buffer.concat([EMPTY, Buffer.from([0])]),
        Buffer.from(EMPTY).subarray(0, -1),
        Buffer.from(EMPTY).fill(0, 0, 4),
        Buffer.from(EMPTY).fill(0xff, 4, 5),
        Buffer.from(EMPTY).fill(2, 6, 7),
        Buffer.from(EMPTY).fill(3, 9, 10),
        Buffer.from(EMPTY).fill(1, 10, 11),
        Buffer.from(EMPTY).fill(255, 11, 12),
        Buffer.from(EMPTY).fill(128, 12, 13)
    ]) assert.equal(isStructurallyValidTonBoc(mutation), false);
});
test("non-Buffer data is not a verified serialized TON BOC", () => {
    assert.equal(isStructurallyValidTonBoc(null), false);
    assert.equal(isStructurallyValidTonBoc("b5ee9c72"), false);
});
