/**
 * Verify a Wallet V4 external-message Ed25519 signature against a trusted
 * 32-byte public key. The caller MUST independently bind that key to the
 * authorized source wallet (e.g. authenticated wallet deployment data).
 * This function does not derive a V4 address from StateInit.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { decodeOrdinaryTonBocCells } from "./OrdinaryTonBocCells.js";
import { decodeWalletV4NativeRefundBody } from "./WalletV4NativeRefundDecoder.js";

function packed(bits) {
    const padded = bits.length % 8
        ? bits + "1" + "0".repeat(7 - bits.length % 8) : bits;
    return Buffer.from(padded.match(/.{8}/g)?.map(v => parseInt(v, 2)) ?? []);
}
function cellHash(cells, index, memo) {
    if (memo.has(index)) return memo.get(index);
    const cell = cells[index];
    const refs = cell.refs.map(i => cellHash(cells, i, memo));
    const d1 = cell.refs.length;
    const d2 = Math.floor(cell.bitLength / 8) + Math.ceil(cell.bitLength / 8);
    const depth = refs.length ? 1 + Math.max(...refs.map(v => v.depth)) : 0;
    if (depth > 65535) throw Error("TON_CELL_DEPTH_OVERFLOW");
    const refDepths = Buffer.concat(refs.map(v => {
        const bytes = Buffer.alloc(2);
        bytes.writeUInt16BE(v.depth);
        return bytes;
    }));
    const repr = Buffer.concat([
        Buffer.from([d1, d2]), packed(cell.bits),
        refDepths, ...refs.map(v => v.hash)
    ]);
    const value = { depth, hash: createHash("sha256").update(repr).digest() };
    memo.set(index, value);
    return value;
}

export function verifyWalletV4RefundEd25519({ boc, publicKeyHex }) {
    try {
        if (typeof boc !== "string" ||
            !/^[a-fA-F0-9]{64}$/.test(publicKeyHex ?? "")) return false;
        const bytes = Buffer.from(boc, "base64");
        if (bytes.toString("base64") !== boc) return false;
        decodeWalletV4NativeRefundBody(bytes);
        const { root, cells } = decodeOrdinaryTonBocCells(bytes);
        const signed = cells[root];
        if (signed.bitLength !== 624 || signed.refs.length !== 1) return false;
        const signature = packed(signed.bits.slice(0, 512));
        const unsigned = {
            ...signed,
            bits: signed.bits.slice(512),
            bitLength: signed.bitLength - 512
        };
        const unsignedCells = cells.slice();
        unsignedCells[root] = unsigned;
        const digest = cellHash(unsignedCells, root, new Map()).hash;
        // Node's Ed25519 SPKI prefix for a raw 32-byte public key.
        const der = Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            Buffer.from(publicKeyHex, "hex")
        ]);
        const key = createPublicKey({ key: der, format: "der", type: "spki" });
        return verify(null, digest, key, signature);
    } catch {
        return false;
    }
}
