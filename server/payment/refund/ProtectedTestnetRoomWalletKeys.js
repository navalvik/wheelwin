/**
 * Testnet-only protected signing-key lookup for the restored October
 * RoomWalletAdapter. The public WalletPoolRegistry intentionally strips
 * secrets; this resolver reads the existing Railway room-wallet variable
 * separately and verifies every key against the registered WalletV4 address.
 *
 * Construct only on the trusted server. Never expose the returned resolver
 * through HTTP, socket events, logs, snapshots, or payment status.
 * Construction does not sign or broadcast.
 */
import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";
import { tonAddressIdentitiesEqual } from "../incoming/TonAddressIdentity.js";

function decodeKey(value, bytes) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error("Testnet room-wallet signing key is missing");
    }
    const raw = value.trim();
    let decoded;
    if (/^[a-fA-F0-9]+$/.test(raw) && raw.length === bytes * 2) {
        decoded = Buffer.from(raw, "hex");
    } else if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
        decoded = Buffer.from(raw, "base64");
        if (decoded.toString("base64").replace(/=+$/, "") !== raw.replace(/=+$/, "")) {
            throw new Error("Testnet room-wallet signing key encoding is invalid");
        }
    } else {
        throw new Error("Testnet room-wallet signing key encoding is invalid");
    }
    if (decoded.length !== bytes) {
        throw new Error("Testnet room-wallet signing key has incorrect length");
    }
    return decoded;
}

export function createProtectedTestnetRoomWalletKeyResolver({
    walletPool,
    env = process.env,
    network = "testnet"
} = {}) {
    if (network !== "testnet" ||
        (env.TON_NETWORK && String(env.TON_NETWORK).trim().toLowerCase() !== "testnet")) {
        throw new Error("protected room-wallet signing supports Testnet only");
    }
    if (typeof walletPool?.listWallets !== "function" ||
        typeof walletPool?.getWallet !== "function") {
        throw new Error("protected room-wallet signing requires the public wallet pool");
    }
    // The same variable names and precedence as the working October runtime.
    // Never print raw input or include it in exceptions.
    const raw = env.ROOM_WALLETS_TESTNET_JSON || env.ROOM_WALLETS_JSON;
    if (typeof raw !== "string" || !raw.trim()) {
        throw new Error("Testnet room-wallet signing catalog is unavailable");
    }
    let entries;
    try {
        entries = JSON.parse(raw);
    } catch {
        throw new Error("Testnet room-wallet signing catalog is invalid JSON");
    }
    if (!Array.isArray(entries) || entries.length !== 64) {
        throw new Error("Testnet signing catalog must contain exactly 64 wallets");
    }
    const publicWallets = walletPool.listWallets();
    if (!Array.isArray(publicWallets) || publicWallets.length !== 64) {
        throw new Error("public Testnet room-wallet pool must contain 64 wallets");
    }
    const byNumber = new Map();
    for (const wallet of publicWallets) {
        if (!Number.isSafeInteger(wallet.roomNumber) || wallet.roomNumber < 1 ||
            wallet.roomNumber > 64 || wallet.network !== "testnet" ||
            wallet.workchain !== 0 || !wallet.walletId || !wallet.address ||
            byNumber.has(wallet.roomNumber)) {
            throw new Error("public Testnet room-wallet identity is invalid");
        }
        byNumber.set(wallet.roomNumber, wallet);
    }
    const signingPairs = new Map();
    for (const entry of entries) {
        const number = entry?.roomNumber;
        const wallet = byNumber.get(number);
        if (!wallet || signingPairs.has(wallet.walletId) ||
            (entry.network != null && String(entry.network).toLowerCase() !== "testnet") ||
            (entry.workchain != null && Number(entry.workchain) !== 0)) {
            throw new Error("Testnet signing catalog room identity is invalid");
        }
        const publicKey = decodeKey(entry.publicKey, 32);
        const secretKey = decodeKey(entry.secretKey, 64);
        const derived = keyPairFromSeed(secretKey.subarray(0, 32));
        if (!derived.publicKey.equals(publicKey) || !derived.secretKey.equals(secretKey)) {
            throw new Error("Testnet signing key pair does not match");
        }
        const address = WalletContractV4.create({ workchain: 0, publicKey }).address.toString();
        if (!tonAddressIdentitiesEqual(address, wallet.address) ||
            !tonAddressIdentitiesEqual(address, entry.address)) {
            throw new Error("Testnet signing key does not match registered wallet address");
        }
        signingPairs.set(wallet.walletId, {
            roomNumber: number,
            address: wallet.address,
            publicKey,
            secretKey
        });
    }
    if (signingPairs.size !== 64) {
        throw new Error("Testnet signing catalog is missing room wallets");
    }
    // Only the exact registered wallet ID can resolve its signing identity.
    // Return copies to prevent mutation of the protected in-memory key pairs.
    return async function resolveTestnetWalletKey(walletId) {
        const pair = signingPairs.get(walletId);
        const current = walletPool.getWallet(walletId);
        if (!pair || !current || current.network !== "testnet" ||
            current.roomNumber !== pair.roomNumber || current.workchain !== 0 ||
            !tonAddressIdentitiesEqual(current.address, pair.address)) {
            throw new Error("protected Testnet room-wallet identity changed or missing");
        }
        return {
            publicKey: Buffer.from(pair.publicKey),
            secretKey: Buffer.from(pair.secretKey)
        };
    };
}
