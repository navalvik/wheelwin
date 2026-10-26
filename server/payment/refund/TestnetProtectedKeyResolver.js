/**
 * Private Testnet-only key resolver. Construct ONLY inside a protected signer
 * process from a runtime secret, never from the public WalletPoolRegistry.
 * No secret values are included in errors, logs, or output.
 */
import { Buffer } from "node:buffer";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { tonAddressIdentitiesEqual } from "../incoming/TonAddressIdentity.js";

const HEX_32 = /^[a-f0-9]{64}$/i;
const HEX_64 = /^[a-f0-9]{128}$/i;
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function keyPairFromSecret(entry) {
    const privateHex = entry?.secretKey;
    const publicHex = entry?.publicKey;
    if (typeof privateHex !== "string" || !HEX_64.test(privateHex)
        || typeof publicHex !== "string" || !HEX_32.test(publicHex)) {
        throw new Error("protected Testnet signer keys invalid");
    }
    const secretKey = Buffer.from(privateHex, "hex");
    const publicKey = Buffer.from(publicHex, "hex");
    // TON's 64-byte Ed25519 key layout is seed || public key.
    const seed = secretKey.subarray(0, 32);
    const derived = createPublicKey(createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
        format: "der", type: "pkcs8"
    })).export({ format: "der", type: "spki" }).subarray(-32);
    if (!derived.equals(publicKey) || !secretKey.subarray(32).equals(publicKey)) {
        throw new Error("protected Testnet signer key pair mismatch");
    }
    return { publicKey, secretKey };
}

/**
 * Resolver reads the injected secret only when a signing call is authorized.
 * It accepts the room-wallet JSON array used for protected Railway variables.
 * Only a single matching wallet's keypair is returned; no key catalog is cached.
 */
export function createTestnetProtectedKeyResolver({ secretProvider, walletPool }) {
    if (typeof secretProvider !== "function"
        || !walletPool || typeof walletPool.getWallet !== "function") {
        throw new Error("protected signer needs secret provider and public wallet pool");
    }
    return async function resolveKey(walletId) {
        if (typeof walletId !== "string" || !walletId) {
            throw new Error("protected Testnet wallet identifier invalid");
        }
        const publicWallet = walletPool.getWallet(walletId);
        if (!publicWallet || publicWallet.network !== "testnet") {
            throw new Error("protected Testnet wallet not registered");
        }
        const secret = await secretProvider();
        let entries;
        try { entries = JSON.parse(secret); }
        catch { throw new Error("protected Testnet signer catalog unreadable"); }
        if (!Array.isArray(entries) || entries.length !== 64) {
            throw new Error("protected Testnet signer catalog must contain 64 wallets");
        }
        const matches = entries.filter(entry => entry?.walletId === walletId);
        if (matches.length !== 1) {
            throw new Error("protected Testnet signer wallet missing or duplicated");
        }
        const entry = matches[0];
        if (entry.roomNumber !== publicWallet.roomNumber
            || entry.network !== "testnet"
            || !tonAddressIdentitiesEqual(entry.address, publicWallet.address)) {
            throw new Error("protected signer public wallet identity mismatch");
        }
        return keyPairFromSecret(entry);
    };
}
