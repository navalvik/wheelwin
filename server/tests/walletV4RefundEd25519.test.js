import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { decodeOrdinaryTonBocCells } from "../payment/refund/OrdinaryTonBocCells.js";
import { makeNativeRefundV4Boc } from "./fixtures/nativeRefundV4BocFixture.js";
import { verifyWalletV4RefundEd25519 } from "../payment/refund/WalletV4RefundEd25519.js";

const { publicKey } = generateKeyPairSync("ed25519");
const key = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");

test("dummy-signature Wallet V4 fixture is rejected even with a valid Ed25519 key", () => {
    const boc = makeNativeRefundV4Boc().toString("base64");
    assert.equal(verifyWalletV4RefundEd25519({ boc, publicKeyHex: key }), false);
});

test("invalid BOC and invalid trusted key fail closed", () => {
    const boc = makeNativeRefundV4Boc().toString("base64");
    assert.equal(verifyWalletV4RefundEd25519({ boc, publicKeyHex: "00" }), false);
    assert.equal(verifyWalletV4RefundEd25519({ boc: "not-a-boc", publicKeyHex: key }), false);
    assert.equal(verifyWalletV4RefundEd25519({ boc: "", publicKeyHex: key }), false);
    assert.equal(verifyWalletV4RefundEd25519({ boc, publicKeyHex: null }), false);
});

function signedFixture() {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const boc = makeNativeRefundV4Boc();
    const { cells, root } = decodeOrdinaryTonBocCells(boc);
    const body = cells[root];
    const message = cells[body.refs[0]];
    function pack(bits) {
        const padded = bits.length % 8 ? bits + "1" + "0".repeat(7 - bits.length % 8) : bits;
        return Buffer.from(padded.match(/.{8}/g).map(x => parseInt(x, 2)));
    }
    const childRepr = Buffer.concat([
        Buffer.from([0, Math.floor(message.bitLength / 8) + Math.ceil(message.bitLength / 8)]),
        pack(message.bits)
    ]);
    const childHash = createHash("sha256").update(childRepr).digest();
    const unsigned = body.bits.slice(512);
    const rootRepr = Buffer.concat([
        Buffer.from([1, Math.floor(unsigned.length / 8) + Math.ceil(unsigned.length / 8)]),
        pack(unsigned), Buffer.from([0, 0]), childHash
    ]);
    const digest = createHash("sha256").update(rootRepr).digest();
    const signature = sign(null, digest, privateKey);
    // The fixture root begins with 64 dummy signature bytes. Replace them
    // without changing the BOC header, cell descriptors or reference indices.
    const rootDataOffset = 11 + 2;
    signature.copy(boc, rootDataOffset);
    return {
        boc: boc.toString("base64"),
        publicKeyHex: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")
    };
}

test("authentic Wallet V4 Ed25519 signature passes; mutated signature and wrong key fail", () => {
    const signed = signedFixture();
    assert.equal(verifyWalletV4RefundEd25519(signed), true);
    const corrupted = Buffer.from(signed.boc, "base64");
    corrupted[13] ^= 1;
    assert.equal(verifyWalletV4RefundEd25519({
        ...signed, boc: corrupted.toString("base64")
    }), false);
    const other = generateKeyPairSync("ed25519").publicKey;
    assert.equal(verifyWalletV4RefundEd25519({
        ...signed, publicKeyHex: other.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")
    }), false);
});
