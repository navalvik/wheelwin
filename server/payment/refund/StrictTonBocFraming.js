/**
 * Strict, dependency-free TON BOC framing validation.
 * Checks container structure, cell descriptors, references and CRC32C.
 * This does NOT decode wallet TL-B operations or validate Ed25519 signatures.
 * Invalid/unrecognized serializations fail closed.
 */
const MAGIC = 0xb5ee9c72;
const MAX_CELLS = 256;
const MAX_SIZE = 65536;

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

export function isStructurallyValidTonBoc(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 13 || bytes.length > MAX_SIZE ||
        bytes.readUInt32BE(0) !== MAGIC) return false;
    try {
        let pos = 4;
        const flagsByte = bytes[pos++];
        const offsetSize = bytes[pos++];
        const size = flagsByte & 0x07;
        const hasIndex = (flagsByte & 0x80) !== 0;
        const hasCrc = (flagsByte & 0x40) !== 0;
        const cacheBits = (flagsByte & 0x20) !== 0;
        const flags = (flagsByte >> 3) & 3;
        if (cacheBits || flags !== 0 || size < 1 || size > 4 ||
            offsetSize < 1 || offsetSize > 8) return false;
        const readNum = length => {
            if (length < 1 || pos + length > bytes.length) throw Error("BOC_TRUNCATED");
            let value = 0;
            for (let i = 0; i < length; i++) value = value * 256 + bytes[pos++];
            if (!Number.isSafeInteger(value)) throw Error("BOC_INTEGER_OVERFLOW");
            return value;
        };
        const cells = readNum(size);
        const roots = readNum(size);
        const absent = readNum(size);
        const cellBytes = readNum(offsetSize);
        if (roots !== 1 || cells < 1 || cells > MAX_CELLS ||
            absent !== 0 || cellBytes < 2 || cellBytes > MAX_SIZE) return false;
        const rootIndex = readNum(size);
        if (rootIndex >= cells) return false;
        const index = [];
        if (hasIndex) for (let n = 0; n < cells; n++) index.push(readNum(offsetSize));
        const end = pos + cellBytes;
        if (end + (hasCrc ? 4 : 0) !== bytes.length) return false;
        const start = pos;
        let previousEnd = 0;
        for (let n = 0; n < cells; n++) {
            if (pos + 2 > end) return false;
            const first = bytes[pos++];
            const second = bytes[pos++];
            const refs = first & 7;
            const exotic = (first & 8) !== 0;
            const level = (first >> 5) & 3;
            if (refs > 4 || exotic || level !== 0) return false;
            const dataBytes = Math.ceil(second / 2);
            if (second > 255 || dataBytes > 128 || pos + dataBytes + refs * size > end) return false;
            if ((second & 1) !== 0) {
                // Top-upped bitstring must have a terminating 1 bit.
                const last = bytes[pos + dataBytes - 1];
                if (dataBytes < 1 || last === 0) return false;
            }
            pos += dataBytes;
            for (let r = 0; r < refs; r++) {
                const ref = readNum(size);
                // TON BOC cells are topologically sorted: refs point forward.
                if (ref <= n || ref >= cells) return false;
            }
            previousEnd = pos - start;
            if (hasIndex && index[n] !== previousEnd) return false;
        }
        if (pos !== end) return false;
        if (hasCrc && bytes.readUInt32LE(end) !== crc32c(bytes.subarray(0, end))) return false;
        return true;
    } catch {
        return false;
    }
}
