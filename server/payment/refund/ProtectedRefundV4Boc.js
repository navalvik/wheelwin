/**
 * Strict offline structural validator for TON Wallet V4 native-GRAM messages.
 *
 * A BOC is NOT evidence that its Ed25519 signature is authentic. Signing key
 * authorization, network account seqno and balance checks are separate gates
 * before any future broadcaster may use it. This module CANNOT send GRAM.
 */
import { Address, Cell, loadMessage, loadMessageRelaxed, SendMode } from "@ton/core";

export class ProtectedRefundBocError extends Error {
    constructor(code) { super(code); this.name = "ProtectedRefundBocError"; this.code = code; }
}
const fail = code => { throw new ProtectedRefundBocError(code); };
function account(value) {
    try {
        const a = Address.parse(value);
        if (a.workChain !== 0) fail("BOC_WORKCHAIN_UNSUPPORTED");
        return a.toRawString().toLowerCase();
    } catch (error) {
        if (error instanceof ProtectedRefundBocError) throw error;
        fail("BOC_ADDRESS_INVALID");
    }
}

/** Common wallet v4 (workchain 0) walletId; other versions FAIL closed. */
const WALLET_V4_ID = 698983191;

/**
 * Checks actual serialized bytes, not a caller's separately supplied
 * recipient, amount, seqno or hash. Does NOT authenticate the signature.
 */
export function inspectProtectedRefundV4Boc({
    bocBase64, fromWallet, toWallet, netAtomic, nowSeconds = Math.floor(Date.now() / 1000)
} = {}) {
    if (typeof bocBase64 !== "string" || bocBase64.length < 12
        || bocBase64.length > 65_536
        || !/^[a-z0-9+/]+={0,2}$/i.test(bocBase64)
        || !Number.isSafeInteger(netAtomic) || netAtomic <= 0
        || !Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) {
        fail("BOC_PREPARED_INPUT_INVALID");
    }
    const source = account(fromWallet), target = account(toWallet);
    let root, outer;
    try {
        const bytes = Buffer.from(bocBase64, "base64");
        if (bytes.toString("base64") !== bocBase64) fail("BOC_NONCANONICAL_BASE64");
        const parsed = Cell.fromBoc(bytes);
        if (parsed.length !== 1) fail("BOC_ROOT_COUNT_INVALID");
        root = parsed[0];
        const outerSlice = root.beginParse();
        outer = loadMessage(outerSlice);
        // TON core intentionally leaves inline message bodies in the original
        // slice (asCell), so remainingBits is NOT evidence of trailing data.
        // The decoded V4 body is checked for exact bit/ref consumption below.
    } catch (error) {
        if (error instanceof ProtectedRefundBocError) throw error;
        fail("BOC_MALFORMED");
    }
    if (outer.info?.type !== "external-in"
        || outer.info.dest?.toRawString().toLowerCase() !== source
        || outer.init != null) fail("BOC_WALLET_NOT_AUTHORIZED");

    let validUntil, seqno;
    try {
        const s = outer.body.beginParse();
        if (s.remainingBits < 512 + 32 + 32 + 32 + 8 + 8
            || s.remainingRefs !== 1) fail("BOC_V4_BODY_INVALID");
        s.skip(512); // signature bytes only; NOT cryptographic signature verification
        const walletId = s.loadUint(32);
        validUntil = s.loadUint(32);
        seqno = s.loadUint(32);
        const action = s.loadUint(8);
        if (walletId !== WALLET_V4_ID || action !== 0
            || s.remainingBits !== 8 || s.remainingRefs !== 1) {
            fail("BOC_V4_ACTION_INVALID");
        }
        if (s.loadUint(8) !== SendMode.PAY_GAS_SEPARATELY) {
            fail("BOC_SEND_MODE_INVALID");
        }
        const ref = s.loadRef();
        if (s.remainingBits !== 0 || s.remainingRefs !== 0) fail("BOC_EXTRA_MESSAGES");
        const outSlice = ref.beginParse();
        const inner = loadMessageRelaxed(outSlice);
        if (inner.info?.type !== "internal" || inner.init != null
            || inner.info.dest?.toRawString().toLowerCase() !== target
            || inner.info.value?.coins !== BigInt(netAtomic)) {
            fail("BOC_RECIPIENT_AMOUNT_MISMATCH");
        }
        const body = inner.body?.beginParse();
        if (!body || body.remainingBits !== 0 || body.remainingRefs !== 0) {
            fail("BOC_UNEXPECTED_TRANSFER_PAYLOAD");
        }
        const others = inner.info.value?.other;
        if (others?.size > 0) fail("BOC_EXTRA_CURRENCIES_FORBIDDEN");
    } catch (error) {
        if (error instanceof ProtectedRefundBocError) throw error;
        fail("BOC_V4_DECODE_INVALID");
    }
    if (!Number.isSafeInteger(seqno) || seqno < 0
        || !Number.isSafeInteger(validUntil)
        || validUntil <= nowSeconds || validUntil > nowSeconds + 300) {
        fail("BOC_V4_EXPIRY_INVALID");
    }
    return Object.freeze({
        roomWallet: source, recipient: target, netAtomic,
        seqno, validUntil, walletId: WALLET_V4_ID,
        signedHash: root.hash().toString("hex"),
        signatureAuthenticated: false,
        broadcastAuthorized: false
    });
}
