/**
 * Narrow, read-only TON Wallet V4 simple-send body decoder.
 * Requires a single plain native TON MessageRelaxed reference, no init,
 * no extra currency, no body payload, and safe send mode.
 *
 * This parses the BOC bytes INDEPENDENTLY of signer-reported metadata.
 * It does NOT verify Ed25519 or bind the V4 wallet public key to the source
 * wallet address. A signed message MUST NOT be broadcast based on this alone.
 *
 * TON wallet v4 body: signature:512, wallet_id:32, valid_until:32,
 * seqno:32, opcode:32 (0 simple send), send_mode:8, message:^Cell.
 */
import { decodeOrdinaryTonBocCells } from "./OrdinaryTonBocCells.js";

function reader(bits) {
    let position = 0;
    return {
        take(count) {
            if (!Number.isInteger(count) || count < 0 || position + count > bits.length)
                throw Error("TON_BITS_TRUNCATED");
            const result = bits.slice(position, position + count);
            position += count;
            return result;
        },
        uint(count) {
            const bitsValue = this.take(count);
            return bitsValue.length ? BigInt("0b" + bitsValue) : 0n;
        },
        get remaining() { return bits.length - position; }
    };
}

function readStdAddress(r) {
    if (r.uint(2) !== 2n) throw Error("TON_ADDRESS_NOT_STANDARD");
    if (r.uint(1) !== 0n) throw Error("TON_ANYCAST_NOT_SUPPORTED");
    const workchain = Number(r.uint(8));
    if (workchain !== 0) throw Error("TON_WORKCHAIN_UNSUPPORTED");
    const accountBits = r.take(256);
    return "0:" + BigInt("0b" + accountBits).toString(16).padStart(64, "0");
}

function readCoins(r) {
    const length = Number(r.uint(4));
    if (length > 15) throw Error("TON_COIN_LENGTH_INVALID");
    return r.uint(length * 8);
}

export function decodeWalletV4NativeRefundBody(bytes) {
    const decoded = decodeOrdinaryTonBocCells(bytes);
    if (decoded.cells.length !== 2) throw Error("TON_REFUND_CELL_COUNT_UNSUPPORTED");
    const body = decoded.cells[decoded.root];
    if (body.refs.length !== 1 || body.bitLength !== 648)
        throw Error("TON_WALLET_V4_BODY_UNSUPPORTED");
    const root = reader(body.bits);
    root.take(512); // Ed25519 signature is NOT verified by this decoder
    const walletId = Number(root.uint(32));
    const validUntil = Number(root.uint(32));
    const seqno = Number(root.uint(32));
    const op = root.uint(32);
    if (op !== 0n) throw Error("TON_WALLET_V4_OPERATION_UNSUPPORTED");
    const sendMode = Number(root.uint(8));
    if (sendMode !== 1 && sendMode !== 3)
        throw Error("TON_REFUND_SEND_MODE_UNSAFE");
    if (root.remaining !== 0) throw Error("TON_WALLET_V4_TRAILING_DATA");

    const message = decoded.cells[body.refs[0]];
    if (message.refs.length !== 0) throw Error("TON_REFUND_MESSAGE_REFS_UNSUPPORTED");
    const r = reader(message.bits);
    if (r.uint(1) !== 0n) throw Error("TON_REFUND_NOT_INTERNAL");
    if (r.uint(1) !== 1n) throw Error("TON_REFUND_IHR_NOT_DISABLED");
    const bounce = r.uint(1) === 1n;
    if (!bounce || r.uint(1) !== 0n) throw Error("TON_REFUND_BOUNCED_UNSUPPORTED");
    if (r.uint(2) !== 0n) throw Error("TON_REFUND_SOURCE_MUST_BE_NONE");
    const to = readStdAddress(r);
    const amountAtomic = readCoins(r);
    if (amountAtomic <= 0n) throw Error("TON_REFUND_AMOUNT_INVALID");
    if (r.uint(1) !== 0n) throw Error("TON_EXTRA_CURRENCY_NOT_ALLOWED");
    // No forward or IHR fee is allowed inside the unsigned message template.
    if (readCoins(r) !== 0n || readCoins(r) !== 0n)
        throw Error("TON_REFUND_TEMPLATE_FEES_NONZERO");
    if (r.uint(64) !== 0n || r.uint(32) !== 0n)
        throw Error("TON_REFUND_TEMPLATE_TIMESTAMP_NONZERO");
    if (r.uint(1) !== 0n) throw Error("TON_REFUND_STATE_INIT_NOT_ALLOWED");
    if (r.uint(1) !== 0n || r.remaining !== 0)
        throw Error("TON_REFUND_BODY_MUST_BE_EMPTY");
    return Object.freeze({
        walletVersion: "V4", walletId, validUntil, seqno,
        sendMode, to, amountAtomic: amountAtomic.toString(),
        bounce, messageCount: 1
    });
}
