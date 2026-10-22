/**
 * Independent signed-message evidence contract for net native GRAM refunds.
 * The caller's inspector MUST decode the actual signed TON BOC. This helper
 * binds the inspected result to the exact signed bytes and authoritative plan.
 * It does not decode TON cells, verify signatures, or move funds itself.
 */
import { createHash } from "node:crypto";
import { tonAddressIdentitiesEqual } from "../incoming/TonAddressIdentity.js";

export function signedRefundBocHashOrNull(signedTransfer) {
    const boc = signedTransfer?.boc;
    if (typeof boc !== "string" || boc.length < 8 || boc.length > 131072 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(boc)) return null;
    const bytes = Buffer.from(boc, "base64");
    // Standard TON Bag-of-Cells magic; arbitrary base64 is not a BOC.
    // This is a framing check, NOT cell decoding or signature validation.
    if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0xb5ee9c72 ||
        bytes.toString("base64") !== boc) return null;
    return createHash("sha256").update(bytes).digest("hex");
}

export function verifyInspectedNativeGramRefund({ signedTransfer, inspected, expected }) {
    const digest = signedRefundBocHashOrNull(signedTransfer);
    if (!digest || inspected?.verified !== true ||
        inspected?.evidenceSource !== "decoded-signed-ton-boc" ||
        inspected?.bocSha256 !== digest ||
        inspected?.networkName !== expected?.networkName ||
        inspected?.globalId !== expected?.globalId ||
        inspected?.idempotencyKey !== expected?.idempotencyKey ||
        !tonAddressIdentitiesEqual(inspected?.from, expected?.from) ||
        !Array.isArray(inspected?.messages) || inspected.messages.length !== 1) return false;
    const message = inspected.messages[0];
    if (!tonAddressIdentitiesEqual(message?.to, expected.to) ||
        message?.amountAtomic !== expected.amountAtomic ||
        !Number.isSafeInteger(message?.sendMode) ||
        (message.sendMode & 128) !== 0 ||
        message?.sendRemainingBalance !== false ||
        message?.bounce !== true) return false;
    return true;
}
