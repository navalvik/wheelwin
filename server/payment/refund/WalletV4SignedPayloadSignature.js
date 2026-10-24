/**
 * Independent Ed25519 verification of an ordinary TON Wallet V4 signed body.
 *
 * TON V4 verifies a signature over the hash of the body slice AFTER the first
 * 512 signature bits, preserving its outgoing-message cell reference(s).
 * The public key MUST be obtained independently from the authoritative room
 * wallet's verified contract state; never trust a key carried by the signer.
 *
 * Read-only utility; does NOT itself bind a public key to a wallet address,
 * validate network identity, verify contract code, or authorize broadcasting.
 */
import { createHash, createPublicKey, verify as verifyEd25519 } from "node:crypto";
import { decodeOrdinaryTonBocCells } from "./OrdinaryTonBocCells.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const SIGNATURE_BITS = 512;

/** Stable on-chain body identity, independent of BOC serialization flags. */
export function walletV4SignedBodyHash(boc) {
    const { root, cells } = decodeOrdinaryTonBocCells(boc);
    if (cells[root].bitLength !== 624 || cells[root].refs.length !== 1)
        throw Error("TON_WALLET_V4_BODY_UNSUPPORTED");
    return cellInfo(root, cells, new Map()).hash.toString("hex");
}

function encodedBits(bits) {
    if (!/^[01]*$/.test(bits) || bits.length > 1023) throw Error("INVALID_TON_CELL_BITS");
    const topUp = bits.length % 8 === 0 ? bits
        : bits + "1" + "0".repeat(7 - (bits.length % 8));
    const data = Buffer.from(topUp.match(/.{8}/g)?.map(byte => parseInt(byte, 2)) ?? []);
    const descriptor2 = Math.floor(bits.length / 8) + Math.ceil(bits.length / 8);
    return { data, descriptor2 };
}

function cellInfo(index, cells, memo) {
    if (memo.has(index)) return memo.get(index);
    const cell = cells[index];
    if (!cell || cell.refs.length > 4) throw Error("INVALID_TON_CELL_REF");
    const { data, descriptor2 } = encodedBits(cell.bits);
    const children = cell.refs.map(ref => cellInfo(ref, cells, memo));
    const descriptor = Buffer.from([cell.refs.length, descriptor2]);
    const depths = Buffer.alloc(children.length * 2);
    const hashes = [];
    let depth = 0;
    for (let i = 0; i < children.length; i++) {
        depths.writeUInt16BE(children[i].depth, i * 2);
        hashes.push(children[i].hash);
        depth = Math.max(depth, children[i].depth + 1);
    }
    if (depth > 65535) throw Error("TON_CELL_DEPTH_OVERFLOW");
    const repr = Buffer.concat([descriptor, data, depths, ...hashes]);
    const value = Object.freeze({
        hash: createHash("sha256").update(repr).digest(), depth
    });
    memo.set(index, value);
    return value;
}

/**
 * @param {Buffer} boc - Serialized signed V4 request body (one root).
 * @param {Buffer} trustedPublicKey - Exact 32-byte Ed25519 key verified
 * independently for the expected Testnet room-wallet contract.
 * @returns {boolean} cryptographic verification only, not spend authorization.
 */
export function verifyWalletV4SignedPayloadSignature(boc, trustedPublicKey) {
    if (!Buffer.isBuffer(trustedPublicKey) || trustedPublicKey.length !== 32)
        return false;
    try {
        const { root, cells } = decodeOrdinaryTonBocCells(boc);
        const body = cells[root];
        if (body.bitLength !== 624 || body.refs.length !== 1) return false;
        const signatureBits = body.bits.slice(0, SIGNATURE_BITS);
        const signedBits = body.bits.slice(SIGNATURE_BITS);
        if (signedBits.length !== 112) return false;
        const signature = Buffer.from(
            signatureBits.match(/.{8}/g).map(bit => parseInt(bit, 2))
        );
        const signingRoot = {
            bits: signedBits,
            refs: body.refs
        };
        const modified = cells.slice();
        modified[root] = signingRoot;
        const payloadHash = cellInfo(root, modified, new Map()).hash;
        const key = createPublicKey({
            key: Buffer.concat([ED25519_SPKI_PREFIX, trustedPublicKey]),
            format: "der", type: "spki"
        });
        return verifyEd25519(null, payloadHash, key, signature);
    } catch {
        return false;
    }
}
