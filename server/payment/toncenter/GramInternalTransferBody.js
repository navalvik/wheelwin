/**
 * Strict, bounded parser for TEP-74 internal_transfer in a Toncenter v3
 * message_content.body BOC. Pure parser, NOT a proof of chain inclusion,
 * successful execution, issuer authenticity or settlement.
 *
 * Supports ordinary non-exotic BOCs with one root, no index and no CRC.
 * Unsupported BOC variants fail closed rather than being partially decoded.
 */
import { tonAddressIdentityOrNull } from "../incoming/TonAddressIdentity.js";

const OPCODE = 0x178d4519;
const MAX_BOC_BYTES = 8192;
const MAX_CELLS = 16;

function reject(message) { throw new Error("Invalid TEP-74 internal_transfer: " + message); }

function readUint(bytes, offset, width) {
    if (width < 1 || width > 4 || offset + width > bytes.length) reject("truncated BOC header");
    let value = 0;
    for (let i = 0; i < width; i++) value = value * 256 + bytes[offset + i];
    return value;
}

function parseBoc(value) {
    if (typeof value !== "string" || value.length > 12000
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) reject("expected strict base64 BOC");
    const bytes = Buffer.from(value, "base64");
    if (bytes.length < 12 || bytes.length > MAX_BOC_BYTES
        || bytes.toString("base64") !== value
        || bytes.subarray(0, 4).toString("hex") !== "b5ee9c72") reject("invalid BOC encoding");
    const flags = bytes[4];
    const sizeBytes = flags & 7;
    if ((flags & 0xf8) !== 0 || sizeBytes < 1 || sizeBytes > 4) reject("unsupported BOC flags");
    const offsetBytes = bytes[5];
    if (offsetBytes < 1 || offsetBytes > 4) reject("unsupported offset size");
    let pos = 6;
    const cells = readUint(bytes, pos, sizeBytes); pos += sizeBytes;
    const roots = readUint(bytes, pos, sizeBytes); pos += sizeBytes;
    const absent = readUint(bytes, pos, sizeBytes); pos += sizeBytes;
    const cellSize = readUint(bytes, pos, offsetBytes); pos += offsetBytes;
    if (cells < 1 || cells > MAX_CELLS || roots !== 1 || absent !== 0 || cellSize < 2) {
        reject("unsupported BOC cell counts");
    }
    const root = readUint(bytes, pos, sizeBytes); pos += sizeBytes;
    if (root >= cells || cellSize > MAX_BOC_BYTES || pos + cellSize !== bytes.length) {
        reject("incorrect BOC root or byte count");
    }
    const end = pos + cellSize;
    const parsed = [];
    for (let i = 0; i < cells; i++) {
        if (pos + 2 > end) reject("truncated cell header");
        const descriptor = bytes[pos++];
        const bitsDescriptor = bytes[pos++];
        const refs = descriptor & 7;
        if ((descriptor & ~7) !== 0 || refs > 4) reject("unsupported exotic or large cell");
        const byteLength = Math.ceil(bitsDescriptor / 2);
        if (pos + byteLength + refs * sizeBytes > end) reject("truncated cell data");
        const data = bytes.subarray(pos, pos + byteLength);
        pos += byteLength;
        let bitLength = byteLength * 8;
        if (bitsDescriptor & 1) {
            if (byteLength === 0) reject("missing top-up bit");
            const tail = data[data.length - 1];
            if (!tail) reject("invalid top-up");
            let zeros = 0;
            while (((tail >> zeros) & 1) === 0) zeros++;
            bitLength -= zeros + 1;
        }
        const indexes = [];
        for (let r = 0; r < refs; r++) {
            indexes.push(readUint(bytes, pos, sizeBytes));
            pos += sizeBytes;
        }
        if (indexes.some(index => index <= i || index >= cells)) reject("non-canonical cell references");
        parsed.push({ data, bitLength, indexes });
    }
    if (pos !== end) reject("BOC size mismatch");
    return { cells: parsed, root };
}

class Bits {
    constructor(cell) { this.cell = cell; this.pos = 0; }
    get remaining() { return this.cell.bitLength - this.pos; }
    uint(count) {
        if (!Number.isInteger(count) || count < 0 || count > this.remaining) reject("truncated TL-B field");
        let v = 0n;
        for (let i = 0; i < count; i++) {
            const idx = this.pos++;
            v = (v << 1n) | BigInt((this.cell.data[idx >> 3] >> (7 - (idx & 7))) & 1);
        }
        return v;
    }
    address() {
        const tag = Number(this.uint(2));
        if (tag === 0) return null; // addr_none
        if (tag !== 2 || this.uint(1) !== 0n) reject("unsupported MsgAddress");
        const wc = Number(this.uint(8));
        const hash = this.uint(256).toString(16).padStart(64, "0");
        return `${wc > 127 ? wc - 256 : wc}:${hash}`;
    }
    varUint16() {
        const length = Number(this.uint(4));
        if (length > 15) reject("invalid VarUInteger16 length");
        return this.uint(length * 8);
    }
}

/** Return validated parsed fields only; the caller must independently verify chain evidence. */
export function decodeGramInternalTransferBody(bocBase64) {
    const boc = parseBoc(bocBase64);
    const root = boc.cells[boc.root];
    const bits = new Bits(root);
    if (bits.uint(32) !== BigInt(OPCODE)) reject("incorrect internal_transfer opcode");
    const queryId = bits.uint(64).toString();
    const amount = bits.varUint16();
    if (amount <= 0n) reject("zero GRAM transfer");
    const sender = bits.address();
    const responseDestination = bits.address();
    if (!sender || tonAddressIdentityOrNull(sender) === null) reject("invalid sender owner");
    const forwardTonAmount = bits.varUint16();
    const forwardRef = bits.uint(1) === 1n;
    if (!forwardRef || bits.remaining !== 0 || root.indexes.length !== 1) {
        reject("forward comment must occupy exactly one referenced cell");
    }
    const comment = boc.cells[root.indexes[0]];
    if (comment.indexes.length || comment.bitLength < 32 || comment.bitLength % 8 !== 0) {
        reject("unsupported comment structure");
    }
    const commentBits = new Bits(comment);
    if (commentBits.uint(32) !== 0n) reject("forward payload is not a text comment");
    const length = commentBits.remaining / 8;
    if (length < 5 || length > 68) reject("invalid forward reference length");
    const raw = Buffer.alloc(length);
    for (let i = 0; i < length; i++) raw[i] = Number(commentBits.uint(8));
    const text = raw.toString("utf8");
    if (Buffer.from(text, "utf8").compare(raw) !== 0 || !/^WW1:[A-Za-z0-9_-]{1,64}$/.test(text)) {
        reject("unsupported forward reference");
    }
    return Object.freeze({
        opcode: OPCODE,
        queryId,
        amountAtomic: amount.toString(),
        sender,
        responseDestination,
        forwardTonAmountAtomic: forwardTonAmount.toString(),
        paymentReference: text.slice(4),
        validStructure: true,
        chainInclusionVerified: false,
        receiverSuccessVerified: false,
        gramTransferVerified: false,
        paymentCreditAuthorized: false
    });
}
