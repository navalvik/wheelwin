import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { WalletV4SignedNativeGramRefundInspector } from "../payment/refund/WalletV4SignedNativeGramRefundInspector.js";

const NOW = 1_800_000_000;
const from = "0:" + "b".repeat(64);
const to = "0:" + "a".repeat(64);
const CODE_HASH = "feb5ff6820e2ff0d9483e7e0d62c817d846789fb4ae580c878866d959dabd5c0";
const bin = (value, width) => BigInt(value).toString(2).padStart(width, "0");
const hash = bytes => createHash("sha256").update(bytes).digest();

function cell(bits, refs) {
    const padded = bits.length % 8 ? bits + "1" + "0".repeat(7 - bits.length % 8) : bits;
    const bytes = Buffer.from(padded.match(/.{8}/g)?.map(b => parseInt(b, 2)) ?? []);
    const d2 = Math.floor(bits.length / 8) + Math.ceil(bits.length / 8);
    return {
        bytes, descriptor: Buffer.from([refs.length, d2]),
        serialized: Buffer.concat([Buffer.from([refs.length, d2]), bytes, Buffer.from(refs)])
    };
}
function coins(value) {
    const digits = BigInt(value).toString(16);
    const width = BigInt(value) === 0n ? 0 : Math.ceil(digits.length / 2);
    return bin(width, 4) + (width ? bin(value, width * 8) : "");
}
function fixture() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubkey = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const payloadBits = bin(698983191, 32) + bin(NOW + 100, 32) +
        bin(1, 32) + bin(0, 32) + bin(3, 8);
    const messageBits = "0" + "1" + "1" + "0" +
        "00" + "10" + "0" + bin(0, 8) +
        bin(BigInt("0x" + "a".repeat(64)), 256) +
        coins(990000000) + "0" + coins(0) + coins(0) +
        bin(0, 64) + bin(0, 32) + "0" + "0";
    const child = cell(messageBits, []);
    const childHash = hash(Buffer.concat([child.descriptor, child.bytes]));
    const payloadCell = cell(payloadBits, [1]);
    const signedHash = hash(Buffer.concat([
        payloadCell.descriptor, payloadCell.bytes, Buffer.from([0, 0]), childHash
    ]));
    const signature = sign(null, signedHash, privateKey);
    const signatureBits = [...signature].map(v => bin(v, 8)).join("");
    const root = cell(signatureBits + payloadBits, [1]);
    const serialized = Buffer.concat([root.serialized, child.serialized]);
    const boc = Buffer.concat([
        Buffer.from([0xb5, 0xee, 0x9c, 0x72, 1, 1, 2, 1, 0, serialized.length, 0]),
        serialized
    ]);
    return { publicKey: pubkey, boc: boc.toString("base64") };
}
const expected = {
    networkName: "TESTNET", globalId: -3, from, to,
    amountAtomic: "990000000", idempotencyKey: "TESTNET:pay:tx",
    sendRemainingBalance: false
};
function inspector(publicKey, overrides = {}) {
    return new WalletV4SignedNativeGramRefundInspector({
        nowSeconds: () => NOW,
        walletStateReader: {
            async getVerifiedWalletState() {
                return {
                    verifiedOnChain: true, networkName: "TESTNET", globalId: -3,
                    sourceWalletAddress: from, version: "V4R2",
                    codeHash: CODE_HASH, publicKey, walletId: 698983191,
                    seqno: 1, ...overrides
                };
            }
        }
    });
}
test("TON Wallet V4R2 inspector independently decodes and verifies a net refund", async () => {
    const { publicKey, boc } = fixture();
    const result = await inspector(publicKey).inspect({
        signedTransfer: { boc }, expected
    });
    assert.equal(result.verified, true);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].amountAtomic, "990000000");
    assert.equal(result.messages[0].to, to);
    assert.equal(result.messages[0].sendMode, 3);
});
test("pre-broadcast Wallet V4R2 signature method authenticates exact room wallet and rejects spoofed state", async () => {
    const { publicKey, boc } = fixture();
    const valid = inspector(publicKey);
    const request = {
        signedTransfer: { boc },
        sourceWalletAddress: from, networkName: "TESTNET", globalId: -3
    };
    assert.equal(typeof valid.verifyWalletV4Signature, "function");
    assert.equal(await valid.verifyWalletV4Signature(request), true);
    assert.equal(await valid.verifyWalletV4Signature({
        ...request, sourceWalletAddress: to
    }), false);
    assert.equal(await valid.verifyWalletV4Signature({
        ...request, globalId: -239
    }), false);
    const forged = inspector(publicKey, { verifiedOnChain: false });
    assert.equal(await forged.verifyWalletV4Signature(request), false);
    const wrongKey = inspector(fixture().publicKey);
    assert.equal(await wrongKey.verifyWalletV4Signature(request), false);
    const wrongSeqno = inspector(publicKey, { seqno: 2 });
    assert.equal(await wrongSeqno.verifyWalletV4Signature(request), false);
    const wrongCode = inspector(publicKey, { codeHash: "f".repeat(64) });
    assert.equal(await wrongCode.verifyWalletV4Signature(request), false);
    const mutated = Buffer.from(boc, "base64");
    mutated[13] ^= 1; // signed root signature
    assert.equal(await valid.verifyWalletV4Signature({
        ...request, signedTransfer: { boc: mutated.toString("base64") }
    }), false);
});

test("mismatched signer, contract, seqno, network and amount fail closed", async () => {
    const { publicKey, boc } = fixture();
    const wrongPublicKey = fixture().publicKey;
    for (const overrides of [
        { publicKey: wrongPublicKey },
        { verifiedOnChain: false }, { codeHash: "f".repeat(64) },
        { seqno: 2 }, { walletId: 1 }, { globalId: -239 },
        { sourceWalletAddress: to }
    ]) {
        const result = await inspector(publicKey, overrides).inspect({
            signedTransfer: { boc }, expected
        });
        assert.equal(result.verified, false);
    }
    for (const altered of [
        { ...expected, amountAtomic: "1000000000" },
        { ...expected, to: from },
        { ...expected, globalId: -239 },
        { ...expected, sendRemainingBalance: true }
    ]) {
        assert.equal((await inspector(publicKey).inspect({
            signedTransfer: { boc }, expected: altered
        })).verified, false);
    }
});
