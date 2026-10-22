import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
    verifyWalletV4SignedPayloadSignature
} from "../payment/refund/WalletV4SignedPayloadSignature.js";

const sha256 = bytes => createHash("sha256").update(bytes).digest();

function signedWalletBody() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const trustedPublicKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    // V4 signed slice: wallet_id(32) | valid_until(32) |
    // seqno(32) | opcode(32) | send_mode(8) = 136 bits = 17 bytes.
    const payload = Buffer.alloc(17);
    payload.writeUInt32BE(698983191, 0);
    payload.writeUInt32BE(1800000100, 4);
    payload.writeUInt32BE(1, 8);
    payload.writeUInt32BE(0, 12);
    payload[16] = 3;
    // Empty child cell: TON ordinary level-0 cell repr is [0,0].
    const childHash = sha256(Buffer.from([0, 0]));
    // Unsigned root references child 1. TON hash repr includes child depth.
    const payloadHash = sha256(Buffer.concat([
        Buffer.from([1, 34]), payload, Buffer.from([0, 0]), childHash
    ]));
    const signature = sign(null, payloadHash, privateKey);
    assert.equal(signature.length, 64);
    const rootCell = Buffer.concat([
        Buffer.from([1, 162]), signature, payload, Buffer.from([1])
    ]);
    const child = Buffer.from([0, 0]);
    const cellData = Buffer.concat([rootCell, child]);
    const header = Buffer.from([
        0xb5, 0xee, 0x9c, 0x72, 1, 1, 2, 1, 0, cellData.length, 0
    ]);
    return {
        boc: Buffer.concat([header, cellData]),
        trustedPublicKey, payloadHash
    };
}

test("Wallet V4 signature verifies actual TON signed-slice cell hash", () => {
    const fixture = signedWalletBody();
    assert.equal(verifyWalletV4SignedPayloadSignature(
        fixture.boc, fixture.trustedPublicKey
    ), true);
});

test("invalid signature, altered message, unrelated public key and truncated BOC fail", () => {
    const fixture = signedWalletBody();
    const alteredSignature = Buffer.from(fixture.boc);
    alteredSignature[13] ^= 1;
    assert.equal(verifyWalletV4SignedPayloadSignature(
        alteredSignature, fixture.trustedPublicKey
    ), false);
    const alteredPayload = Buffer.from(fixture.boc);
    alteredPayload[13 + 64] ^= 1;
    assert.equal(verifyWalletV4SignedPayloadSignature(
        alteredPayload, fixture.trustedPublicKey
    ), false);
    const other = generateKeyPairSync("ed25519").publicKey
        .export({ format: "der", type: "spki" }).subarray(-32);
    assert.equal(verifyWalletV4SignedPayloadSignature(fixture.boc, other), false);
    assert.equal(verifyWalletV4SignedPayloadSignature(
        fixture.boc.subarray(0, -1), fixture.trustedPublicKey
    ), false);
    assert.equal(verifyWalletV4SignedPayloadSignature(fixture.boc, Buffer.alloc(31)), false);
});
