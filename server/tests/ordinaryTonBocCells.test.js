import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeOrdinaryTonBocCells } from "../payment/refund/OrdinaryTonBocCells.js";

test("ordinary TON BOC decoder extracts exact bits and respects top-up", () => {
    const empty = decodeOrdinaryTonBocCells(
        Buffer.from("b5ee9c72010101010002000000", "hex")
    );
    assert.deepEqual(empty, { root: 0, cells: [
        { index: 0, bitLength: 0, bits: "", refs: [] }
    ] });
    const oneByte = decodeOrdinaryTonBocCells(
        Buffer.from("b5ee9c72010101010003000002a0", "hex")
    );
    assert.equal(oneByte.cells[0].bits, "10100000");
    const partial = decodeOrdinaryTonBocCells(
        Buffer.from("b5ee9c72010101010003000001b0", "hex")
    );
    assert.equal(partial.cells[0].bits, "101");
    assert.equal(partial.cells[0].bitLength, 3);
});

test("TON BOC decoder reads root references and rejects unreachable cells", () => {
    const referenced = decodeOrdinaryTonBocCells(
        Buffer.from("b5ee9c72010102010005000100010000", "hex")
    );
    assert.equal(referenced.cells.length, 2);
    assert.deepEqual(referenced.cells[0].refs, [1]);
    assert.deepEqual(referenced.cells[1].refs, []);
    assert.throws(() => decodeOrdinaryTonBocCells(
        Buffer.from("b5ee9c720101020100040000000000", "hex")
    ), /UNREACHABLE_TON_BOC_CELL/);
});

test("invalid and top-up-only cells cannot decode into transfer data", () => {
    assert.throws(() => decodeOrdinaryTonBocCells(
        Buffer.from("b5ee9c7201010101000300000180", "hex")
    ), /INVALID_TOPUP/);
    assert.throws(() => decodeOrdinaryTonBocCells(
        Buffer.from("b5ee9c72010101010003000001ff", "hex")
    ), /INVALID_TOPUP/);
    assert.throws(() => decodeOrdinaryTonBocCells(Buffer.from([0])), /INVALID_TON_BOC/);
});
