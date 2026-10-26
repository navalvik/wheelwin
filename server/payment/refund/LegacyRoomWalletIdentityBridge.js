/**
 * Compatibility boundary for the October 7 RoomWalletAdapter.walletResolver
 * signature. No legacy settlement code is imported or activated here.
 * The public pool binds roomNumber to a unique Testnet wallet; the protected
 * resolver verifies that wallet and returns key material only for an actual
 * signing operation. Never expose this resolver in an HTTP/socket handler.
 */
import { tonAddressIdentitiesEqual } from "../incoming/TonAddressIdentity.js";

export function createLegacyRoomWalletIdentityResolver({ walletPool, keyResolver } = {}) {
    if (typeof walletPool?.listWallets !== "function" || typeof keyResolver !== "function") {
        throw new Error("room-wallet identity resolver requires pool and protected keys");
    }
    return async function resolveRoomWalletIdentity(roomNumber) {
        if (!Number.isSafeInteger(roomNumber) || roomNumber < 1 || roomNumber > 64) {
            throw new Error("invalid Testnet room wallet number");
        }
        const matches = walletPool.listWallets().filter(wallet =>
            wallet?.roomNumber === roomNumber && wallet?.network === "testnet");
        if (matches.length !== 1 || !matches[0].walletId || !matches[0].address) {
            throw new Error("Testnet room wallet identity missing or ambiguous");
        }
        const wallet = matches[0];
        const pair = await keyResolver(wallet.walletId);
        if (!pair?.publicKey || !pair?.secretKey) {
            throw new Error("protected wallet signing identity unavailable");
        }
        // The protected resolver checks keys against the published wallet
        // identity; this bridge also rejects any changes between both reads.
        const current = walletPool.getWallet?.(wallet.walletId);
        if (!current || current.roomNumber !== roomNumber ||
            current.network !== "testnet" ||
            !tonAddressIdentitiesEqual(current.address, wallet.address)) {
            throw new Error("Testnet room wallet identity changed");
        }
        return {
            roomNumber,
            address: wallet.address,
            workchain: wallet.workchain ?? 0,
            publicKey: pair.publicKey,
            secretKey: pair.secretKey
        };
    };
}
