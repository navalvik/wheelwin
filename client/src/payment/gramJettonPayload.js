/**
 * Build the TEP-74 jetton transfer body for an external TonConnect wallet.
 * No wallet secrets, network calls or transaction submission occur here.
 * The caller must supply validated server-authoritative intent fields.
 */
const textEncoder = new TextEncoder();
function bytesToBase64(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}
function writeUint(bytes, value, bits) {
    const n = BigInt(value);
    if (n < 0n || n >= (1n << BigInt(bits))) throw new Error("integer outside cell range");
    for (let i = bits - 1; i >= 0; i--) bytes.push(Number((n >> BigInt(i)) & 1n));
}
function crc16(data) {
    let crc = 0;
    for (const byte of data) {
        crc ^= byte << 8;
        for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
}
function account(address) {
    if (typeof address !== "string") throw new Error("invalid TON address");
    const raw = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(address);
    if (raw) {
        const wc = Number(raw[1]);
        if (!Number.isInteger(wc) || wc < -128 || wc > 127) throw new Error("invalid workchain");
        return { wc, hash: Uint8Array.from(raw[2].match(/../g), x => parseInt(x, 16)) };
    }
    if (!/^[A-Za-z0-9_-]{48}$/.test(address)) throw new Error("invalid TON address");
    const bytes = Uint8Array.from(atob(address.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    if (bytes.length !== 36 || crc16(bytes.slice(0, 34)) !== ((bytes[34] << 8) | bytes[35])) throw new Error("invalid address checksum");
    const wc = bytes[1] > 127 ? bytes[1] - 256 : bytes[1];
    return { wc, hash: bytes.slice(2, 34) };
}
function cell(bits, refs = []) {
    if (bits.length > 1023 || refs.length > 4) throw new Error("cell capacity exceeded");
    return { bits, refs };
}
function addressBits(address) {
    const { wc, hash } = account(address);
    const bits = [];
    writeUint(bits, 2, 2); // addr_std
    writeUint(bits, 0, 1); // anycast absent
    writeUint(bits, wc < 0 ? wc + 256 : wc, 8);
    for (const byte of hash) writeUint(bits, byte, 8);
    return bits;
}
function snakeComment(reference) {
    if (typeof reference !== "string" || !/^[\x21-\x7e]{1,160}$/.test(reference)) throw new Error("invalid payment reference");
    const bytes = textEncoder.encode("WW1:" + reference);
    const bits = [];
    writeUint(bits, 0, 32);
    for (const byte of bytes) writeUint(bits, byte, 8);
    return cell(bits);
}
function serialize(root) {
    const cells = [];
    const visit = c => { if (cells.includes(c)) return; cells.push(c); c.refs.forEach(visit); };
    visit(root);
    const bytes = [0xb5, 0xee, 0x9c, 0x72, 0x01, 0x01, cells.length, 0x01];
    const chunks = cells.map(c => {
        const length = Math.ceil(c.bits.length / 8);
        const data = Array(length).fill(0);
        c.bits.forEach((bit, i) => { if (bit) data[i >> 3] |= 1 << (7 - (i & 7)); });
        if (c.bits.length % 8) data[Math.floor(c.bits.length / 8)] |= 1 << (7 - (c.bits.length % 8) - 1);
        return [c.refs.length, Math.floor(c.bits.length / 8) + Math.ceil(c.bits.length / 8), ...data, ...c.refs.map(ref => cells.indexOf(ref))];
    });
    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (size > 255) throw new Error("BOC too large");
    bytes.push(size, 0x00);
    for (const chunk of chunks) bytes.push(...chunk);
    return bytesToBase64(bytes);
}
/**
 * The destination here is the player's derived jetton wallet contract, NOT
 * the room's native TON wallet. A verified derived jetton wallet address must
 * be supplied separately before enabling the payment action.
 */
export function buildGramJettonTransferBody({ amountAtomic, recipient, responseDestination, reference, queryId = "0" }) {
    if (typeof amountAtomic !== "string" || !/^[1-9][0-9]*$/.test(amountAtomic)) throw new Error("invalid GRAM amount");
    const amount = BigInt(amountAtomic);
    const bits = [];
    writeUint(bits, 0x0f8a7ea5, 32);
    writeUint(bits, BigInt(queryId), 64);
    let remaining = amount;
    while (remaining >= 128n) { writeUint(bits, Number(remaining & 127n) | 128, 8); remaining >>= 7n; }
    writeUint(bits, remaining, 8);
    bits.push(...addressBits(recipient), ...addressBits(responseDestination));
    writeUint(bits, 0, 1); // custom_payload absent
    writeUint(bits, 1, 4); // forward_ton_amount = 1 nanotON
    writeUint(bits, 1, 1); // forward_payload in ref
    return serialize(cell(bits, [snakeComment(reference)]));
}
