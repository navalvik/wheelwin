/**
 * Read-only decoder for ordinary level-0, one-root TON Bag-of-Cells.
 * Produces exact unpadded cell bitstrings and forward references.
 *
 * Deliberately DOES NOT interpret wallet TL-B, verify signatures or authorize
 * outgoing money. Unsupported/exotic/hash-bearing BOCs fail closed.
 */
import { isStructurallyValidTonBoc } from "./StrictTonBocFraming.js";

function bitAt(data, index) {
    return (data[index >> 3] >> (7 - (index & 7))) & 1;
}

function unpaddedBits(data, descriptor) {
    if ((descriptor & 1) === 0) return data.length * 8;
    // TON top-up: last nonzero bit is a terminator; bits before it are data.
    if (!data.length || data[data.length - 1] === 0) throw Error("INVALID_TOPUP");
    let zeros = 0;
    let last = data[data.length - 1];
    while ((last & 1) === 0) {
        zeros++;
        last >>= 1;
    }
    if (zeros === 7) throw Error("INVALID_TOPUP");
    return data.length * 8 - zeros - 1;
}

export function decodeOrdinaryTonBocCells(bytes) {
    if (!isStructurallyValidTonBoc(bytes)) {
        throw Error("INVALID_TON_BOC");
    }
    let pos = 4;
    const flags = bytes[pos++];
    const offsetBytes = bytes[pos++];
    const sizeBytes = flags & 7;
    const hasIndex = (flags & 0x80) !== 0;
    function readN(n) {
        let value = 0;
        for (let i = 0; i < n; i++) value = value * 256 + bytes[pos++];
        return value;
    }
    const count = readN(sizeBytes);
    readN(sizeBytes); // roots=1 checked in validator
    readN(sizeBytes); // absent=0 checked in validator
    const byteLength = readN(offsetBytes);
    const root = readN(sizeBytes);
    if (hasIndex) pos += count * offsetBytes;
    const payloadEnd = pos + byteLength;
    const cells = [];
    for (let i = 0; i < count; i++) {
        const d1 = bytes[pos++];
        const d2 = bytes[pos++];
        const refsCount = d1 & 7;
        const byteCount = Math.ceil(d2 / 2);
        const data = bytes.subarray(pos, pos + byteCount);
        pos += byteCount;
        const bitLength = unpaddedBits(data, d2);
        const refs = [];
        for (let j = 0; j < refsCount; j++) refs.push(readN(sizeBytes));
        cells.push(Object.freeze({
            index: i, bitLength,
            bits: Array.from({ length: bitLength }, (_, bit) => bitAt(data, bit)).join(""),
            refs: Object.freeze(refs)
        }));
    }
    if (pos !== payloadEnd) throw Error("INVALID_TON_BOC");
    // Even a syntactically valid container can hide unrelated cells. Require
    // all cells to be reachable from its single root.
    const seen = new Set();
    function visit(i) {
        if (seen.has(i)) return;
        seen.add(i);
        for (const child of cells[i].refs) visit(child);
    }
    visit(root);
    if (seen.size !== cells.length) throw Error("UNREACHABLE_TON_BOC_CELL");
    return Object.freeze({ root, cells: Object.freeze(cells) });
}
