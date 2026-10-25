import test from "node:test";
import assert from "node:assert/strict";
import { verifyOutgoingPaymentFromBothProviders } from "../payment/roomWallet/RoomWalletDualSourceOutgoingReceipt.js";

const ROOM = "0:c6423c1a3f43921316bd31f66287ad437b94d0b9421340f622619c9fa80173a6";
const OLGA = "0:bdab0280cbbda45f5a0fb6bc97fa0e72e380769986440761d574901e269ae56b";
const LENA = "0:de5819f3012bf5bb3f0e502aa3a066ffcab5bf4d52dcf384b9b33a857e3907c8";
const BOB = "0:2d8205bb979c1f41c3f2cb7f18ee656e5e7874c111dca4528f21db426dc4476f";
const OLGATX = "decf4284978c28153475f4ac94668f77e233bed93d6aaf32f3ed9e737514565c";
const EXT = "b".repeat(64);
const OUT = "a".repeat(64);
const encoded = x => Buffer.from(x, "hex").toString("base64");

const tx = (source = "tonapi", overrides = {}) => ({
    account: source === "tonapi" ? { address: ROOM } : ROOM.toUpperCase(),
    lt: source === "tonapi" ? Number("105271924000001") : "105271924000001",
    hash: source === "tonapi" ? OLGATX : encoded(OLGATX),
    ...(source === "tonapi" ? { success: true } : {}),
    in_msg: { hash: source === "tonapi" ? EXT : encoded(EXT) },
    out_msgs: [{
        destination: source === "tonapi" ? { address: OLGA } : OLGA.toUpperCase(),
        value: source === "tonapi" ? 998611722 : "998611722",
        hash: source === "tonapi" ? OUT : encoded(OUT)
    }],
    ...overrides
});

function verify(extra = {}) {
    return verifyOutgoingPaymentFromBothProviders({
        tonapiTransactions: [tx("tonapi")],
        toncenterTransactions: [tx("toncenter")],
        roomWallet: ROOM,
        recipientWallet: OLGA,
        valueNano: "998611722",
        knownWalletTransactionHash: OLGATX,
        knownWalletTransactionLt: "105271924000001",
        ...extra
    });
}

test("oj7v: the known Olga refund has an exact dual-source proof", () => {
    const result = verify();
    assert.equal(result.confirmed, true);
    assert.equal(result.state, "CHAIN_CONFIRMED");
    assert.equal(result.receipt.roomWalletTxHash, OLGATX);
    assert.equal(result.receipt.valueNano, "998611722");
    assert.equal(result.receipt.recipient, OLGA);
    assert.equal(result.receipt.outboundMessageHash, OUT);
    assert.equal(result.broadcastAuthorized, false);
});

test("Lena and Bob cannot be marked as refunded just by 1 GRAM transactions to Olga", () => {
    for (const to of [LENA, BOB]) {
        const result = verify({ recipientWallet: to });
        assert.equal(result.confirmed, false);
        assert.equal(result.receipt, null);
        assert.equal(result.state, "CONFIRMATION_UNKNOWN");
    }
});

test("matching only the same recipient and amount without signed intent is prohibited", () => {
    assert.throws(
        () => verify({
            knownWalletTransactionHash: null,
            knownWalletTransactionLt: null
        }),
        err => err.code === "OUTGOING_PROOF_IDENTITY_REQUIRED"
    );
});

test("provider indexed-lag is CONFIRMATION_UNKNOWN, never FAILED", () => {
    const result = verify({ toncenterTransactions: [] });
    assert.equal(result.confirmed, false);
    assert.equal(result.stillIndexing, 1);
    assert.equal(result.state, "CONFIRMATION_UNKNOWN");
});

test("LT collision and conflicting hash fail closed", () => {
    assert.throws(
        () => verify({
            toncenterTransactions: [tx("toncenter", { hash: encoded("f".repeat(64)) })]
        }),
        err => err.code === "OUTGOING_PROVIDERS_DISAGREE"
    );
});

test("outgoing message hash mismatch blocks false confirmation", () => {
    assert.throws(
        () => verify({
            toncenterTransactions: [tx("toncenter", {
                out_msgs: [{ destination: OLGA, value: "998611722", hash: encoded("1".repeat(64)) }]
            })]
        }),
        err => err.code === "OUTGOING_MESSAGES_DISAGREE"
    );
});

test("a failed wallet transaction cannot confirm a transfer", () => {
    const result = verify({
        tonapiTransactions: [tx("tonapi", { success: false })]
    });
    assert.equal(result.confirmed, false);
    assert.equal(result.state, "CONFIRMATION_UNKNOWN");
});

test("a signed external intent hash verifies both providers", () => {
    const proof = verify({
        knownWalletTransactionHash: null,
        knownWalletTransactionLt: null,
        signedExternalMessageHash: EXT
    });
    assert.equal(proof.confirmed, true);
    assert.equal(proof.receipt.signedExternalMessageHash, EXT);
    assert.throws(
        () => verify({
            knownWalletTransactionHash: null,
            knownWalletTransactionLt: null,
            signedExternalMessageHash: EXT,
            toncenterTransactions: [tx("toncenter", { in_msg: { hash: encoded("e".repeat(64)) } })]
        }),
        err => err.code === "OUTGOING_SIGNED_INTENT_NOT_VERIFIED"
    );
});

test("different game reuse or duplicate execution with same intent fails closed", () => {
    const other = tx("tonapi", { lt: 105271925000001, hash: "c".repeat(64) });
    const otherB = tx("toncenter", {
        lt: "105271925000001",
        hash: encoded("c".repeat(64))
    });
    assert.throws(
        () => verify({
            knownWalletTransactionHash: null,
            knownWalletTransactionLt: null,
            signedExternalMessageHash: EXT,
            tonapiTransactions: [tx("tonapi"), other],
            toncenterTransactions: [tx("toncenter"), otherB]
        }),
        err => err.code === "OUTGOING_DUPLICATE_EXECUTION"
    );
});

test("source mismatch is never a valid refund proof", () => {
    assert.throws(
        () => verify({ toncenterTransactions: [tx("toncenter", { account: BOB })] }),
        err => err.code === "OUTGOING_SOURCE_ACCOUNT_MISMATCH"
    );
});
