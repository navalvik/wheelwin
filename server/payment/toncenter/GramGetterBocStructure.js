/**
 * Bounded structural validation of TON generic Bag-of-Cells (BOC).
 *
 * Intended for untrusted get_wallet_data Jetton Wallet code cells. Parsing
 * a BOC does NOT authenticate contract code/state or authorize GRAM credit.
 * Supports generic BOC flags: indexed, CRC32C, ordinary multi-cell DAG.
 * Exotic/hash-bearing cells, cache bits and unsupported flags fail closed.
 */
const MAX_BYTES = 16384;
const MAX_CELLS = 128;
function fail(reason) { throw new Error("Invalid GRAM getter code BOC: " + reason); }
function bigEndian(bytes, at, width) {
    if (width < 1 || width > 4 || at + width > bytes.length) fail("truncated integer");
    let n = 0;
    for (let i = 0; i < width; i++) n = n * 256 + bytes[at + i];
    return n;
}
function crc32c(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
export function inspectGramGetterCodeBoc(encoded) {
    if (typeof encoded !== "string" || encoded.length > 24000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail("invalid base64");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length < 14 || bytes.length > MAX_BYTES ||
        bytes.toString("base64") !== encoded ||
        bytes.subarray(0, 4).toString("hex") !== "b5ee9c72") fail("unsupported BOC format");
    const flags = bytes[4], sizeBytes = flags & 7, offBytes = bytes[5];
    const hasIndex = !!(flags & 0x80), hasCrc = !!(flags & 0x40);
    if ((flags & 0x38) !== 0 || sizeBytes < 1 || sizeBytes > 4 ||
        offBytes < 1 || offBytes > 4) fail("invalid flags");
    let at = 6;
    const cells = bigEndian(bytes, at, sizeBytes); at += sizeBytes;
    const roots = bigEndian(bytes, at, sizeBytes); at += sizeBytes;
    const absent = bigEndian(bytes, at, sizeBytes); at += sizeBytes;
    const dataLength = bigEndian(bytes, at, offBytes); at += offBytes;
    if (cells < 1 || cells > MAX_CELLS || roots !== 1 || absent !== 0 ||
        dataLength < 2 || dataLength > MAX_BYTES) fail("unsupported cell counts");
    const rootIndex = bigEndian(bytes, at, sizeBytes); at += sizeBytes;
    if (rootIndex >= cells) fail("invalid root index");
    const index = [];
    if (hasIndex) for (let i = 0; i < cells; i++) {
        index.push(bigEndian(bytes, at, offBytes)); at += offBytes;
    }
    const dataEnd = at + dataLength;
    if (dataEnd + (hasCrc ? 4 : 0) !== bytes.length) fail("BOC length mismatch");
    if (hasCrc) {
        // Generic TON BOC appends CRC32C in little-endian byte order.
        const expected = bytes.readUInt32LE(dataEnd);
        if (expected !== crc32c(bytes.subarray(0, dataEnd)))
            fail("CRC32C mismatch");
    }
    const entries = [];
    let pos = at;
    let edgeCount = 0;
    const cumulative = [];
    for (let i = 0; i < cells; i++) {
        if (pos + 2 > dataEnd) fail("truncated cell header");
        const d1 = bytes[pos++], d2 = bytes[pos++];
        const refs = d1 & 7;
        if (refs > 4 || (d1 & 0xf8) !== 0) fail("unsupported exotic/hash-bearing cell");
        const byteLength = Math.ceil(d2 / 2);
        if (pos + byteLength + refs * sizeBytes > dataEnd) fail("truncated cell data");
        if (d2 & 1) {
            const last = bytes[pos + byteLength - 1];
            if (!last) fail("invalid top-up");
        }
        pos += byteLength;
        const childIndexes = [];
        for (let j = 0; j < refs; j++) {
            const child = bigEndian(bytes, pos, sizeBytes); pos += sizeBytes;
            if (child <= i || child >= cells) fail("non-topological or invalid reference");
            childIndexes.push(child);
        }
        edgeCount += refs;
        entries.push(childIndexes);
        cumulative.push(pos - at);
    }
    if (pos !== dataEnd) fail("cell data length mismatch");
    if (hasIndex && index.some((n, i) => n !== cumulative[i])) fail("inconsistent cell index");
    const reached = new Set(), stack = [rootIndex];
    while (stack.length) {
        const i = stack.pop();
        if (reached.has(i)) continue;
        reached.add(i);
        stack.push(...entries[i]);
    }
    if (reached.size !== cells) fail("unreachable cells");
    return Object.freeze({
        ordinaryCodeBoc: true,
        cellCount: cells,
        referenceCount: edgeCount,
        hasIndex,
        hasCrc32c: hasCrc,
        authenticated: false,
        paymentCreditAuthorized: false
    });
}
