/**
 * READ-ONLY cryptographic and account-state preflight for a TON Wallet V4R2
 * native GRAM refund. No signer, broadcast or wallet release lives here.
 *
 * Two indexer snapshots are INPUT assertions, not trusted network evidence
 * until fetched independently by a validated production adapter. Even a
 * successful result explicitly never authorizes broadcasting.
 */
import { createPublicKey, verify as verifyEd25519 } from "node:crypto";
import { Address, Cell, loadMessage } from "@ton/core";
import { WalletContractV4 } from "@ton/ton";
import { inspectProtectedRefundV4Boc } from "./ProtectedRefundV4Boc.js";

export class ProtectedRefundAuthorizationError extends Error {
    constructor(code) { super(code); this.name = "ProtectedRefundAuthorizationError"; this.code = code; }
}
const insist = (okay, code) => {
    if (!okay) throw new ProtectedRefundAuthorizationError(code);
};
const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
function uint(value) {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
    return BigInt(value);
}
function checkSnapshot(value, expectedProvider, sourceAddress, computedCodeHash, nowMs) {
    insist(value?.provider === expectedProvider && value.network === "testnet"
        && value.account === sourceAddress && value.status === "active",
        "PREFLIGHT_STATE_SOURCE_INVALID");
    insist(Number.isSafeInteger(value.seqno) && value.seqno >= 0
        && value.seqno < 2 ** 32
        && /^[a-f0-9]{64}$/.test(value.publicKeyHex)
        && /^[a-f0-9]{64}$/.test(value.codeHash)
        && value.codeHash === computedCodeHash
        && typeof value.tipLt === "string" && /^[1-9][0-9]*$/.test(value.tipLt)
        && typeof value.tipHash === "string" && /^[a-f0-9]{64}$/.test(value.tipHash)
        && uint(value.balanceAtomic) !== null
        && Number.isSafeInteger(value.observedAtMs)
        && value.observedAtMs <= nowMs
        && nowMs - value.observedAtMs <= 15_000,
        "PREFLIGHT_STATE_STALE_OR_MALFORMED");
}
export function verifyProtectedRefundV4Authorization({
    bocBase64, fromWallet, toWallet, netAtomic, grossAtomic,
    snapshots, nowMs = Date.now()
} = {}) {
    insist(Number.isSafeInteger(nowMs) && nowMs > 0
        && Number.isSafeInteger(grossAtomic) && grossAtomic >= netAtomic
        && grossAtomic > 0, "PREFLIGHT_AMOUNT_INVALID");
    insist(Array.isArray(snapshots) && snapshots.length === 2,
        "PREFLIGHT_TWO_SOURCES_REQUIRED");
    const parsed = inspectProtectedRefundV4Boc({
        bocBase64, fromWallet, toWallet, netAtomic,
        nowSeconds: Math.floor(nowMs / 1000)
    });
    const [one, two] = snapshots;
    const keyHex = one?.publicKeyHex;
    insist(typeof keyHex === "string" && /^[a-f0-9]{64}$/.test(keyHex)
        && keyHex === two?.publicKeyHex, "PREFLIGHT_PUBLIC_KEYS_DISAGREE");
    const rawKey = Buffer.from(keyHex, "hex");
    const expectedWallet = WalletContractV4.create({workchain:0, publicKey:rawKey});
    insist(Address.parse(fromWallet).equals(expectedWallet.address)
        && expectedWallet.walletId === parsed.walletId,
        "PREFLIGHT_PUBLIC_KEY_WALLET_MISMATCH");
    const expectedCodeHash = expectedWallet.init.code.hash().toString("hex");
    checkSnapshot(one, "tonapi", parsed.roomWallet, expectedCodeHash, nowMs);
    checkSnapshot(two, "toncenter-v3", parsed.roomWallet, expectedCodeHash, nowMs);
    insist(one.seqno === two.seqno && one.tipLt === two.tipLt
        && one.tipHash === two.tipHash
        && one.balanceAtomic === two.balanceAtomic,
        "PREFLIGHT_STATE_PROVIDERS_DISAGREE");
    insist(parsed.seqno === one.seqno, "PREFLIGHT_SEQNO_MISMATCH");
    // Source wallet has to cover the FULL gross refund including recipient's
    // reserved network fee. This is a conservative account sufficiency check;
    // an actual sender must re-read state/fee and preserve the room reserve.
    insist(uint(one.balanceAtomic) >= BigInt(grossAtomic),
        "PREFLIGHT_INSUFFICIENT_BALANCE");
    let signingHash, signature;
    try {
        const roots = Cell.fromBoc(Buffer.from(bocBase64, "base64"));
        insist(roots.length === 1, "PREFLIGHT_BOC_INVALID");
        const envelope = loadMessage(roots[0].beginParse());
        const body = envelope.body.beginParse();
        signature = body.loadBuffer(64);
        signingHash = body.asCell().hash();
    } catch (error) {
        if (error instanceof ProtectedRefundAuthorizationError) throw error;
        throw new ProtectedRefundAuthorizationError("PREFLIGHT_SIGNED_PAYLOAD_INVALID");
    }
    const publicKey = createPublicKey({
        key: Buffer.concat([spkiPrefix, rawKey]),
        format: "der", type: "spki"
    });
    insist(verifyEd25519(null, signingHash, publicKey, signature),
        "PREFLIGHT_SIGNATURE_INVALID");
    return Object.freeze({
        ...parsed,
        signatureAuthenticated: true,
        walletAddressDerivedFromPublicKey: true,
        observedSeqnoMatches: true,
        providersAgree: true,
        accountHeadLt: one.tipLt,
        accountHeadHash: one.tipHash,
        accountCodeHash: expectedCodeHash,
        publicKeyHex: keyHex,
        balanceAtomic: one.balanceAtomic,
        broadcastAuthorized: false,
        refundCompleteAuthorized: false,
        walletReleaseAuthorized: false
    });
}
