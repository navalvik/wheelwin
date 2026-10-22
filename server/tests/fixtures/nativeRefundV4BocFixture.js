// Deterministic Wallet V4 BOC test fixture. Signature bits are deliberately
// dummy values; these are NOT signed transactions and may never be broadcast.
const b = (value, width) => BigInt(value).toString(2).padStart(width, "0");
const coins = value => {
    const v = BigInt(value);
    const width = v === 0n ? 0 : Math.ceil(v.toString(16).length / 2);
    return b(width, 4) + (width ? b(v, width * 8) : "");
};
function encodeCell(bits, refs) {
    const padded = bits.length % 8 ?
        bits + "1" + "0".repeat(7 - bits.length % 8) : bits;
    const data = Buffer.from(padded.match(/.{8}/g)?.map(x => parseInt(x, 2)) ?? []);
    return Buffer.concat([
        Buffer.from([refs.length, Math.floor(bits.length / 8) + Math.ceil(bits.length / 8)]),
        data, Buffer.from(refs)
    ]);
}
export function makeNativeRefundV4Boc({
    amount = 990_000_000n, to = "a".repeat(64), mode = 3, opcode = 0,
    extraCurrency = false, bounce = true, seqno = 1, body = ""
} = {}) {
    const wallet = "0".repeat(512) + b(698983191, 32) +
        b(1800000100, 32) + b(seqno, 32) + b(opcode, 32) + b(mode, 8);
    const message = "0" + "1" + (bounce ? "1" : "0") + "0" +
        "00" + "10" + "0" + b(0, 8) + b(BigInt("0x" + to), 256) +
        coins(amount) + (extraCurrency ? "1" : "0") + coins(0) + coins(0) +
        b(0, 64) + b(0, 32) + "0" + "0" + body;
    const root = encodeCell(wallet, [1]), msg = encodeCell(message, []);
    const cells = Buffer.concat([root, msg]);
    if (cells.length >= 256) throw Error("FIXTURE_TOO_LARGE");
    return Buffer.concat([
        Buffer.from([0xb5, 0xee, 0x9c, 0x72, 1, 1, 2, 1, 0, cells.length, 0]),
        cells
    ]);
}
