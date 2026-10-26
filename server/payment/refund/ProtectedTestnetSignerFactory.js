/**
 * Opt-in composition of the existing public Testnet room wallet registry,
 * protected signing catalog, WalletV4R2 crypto and read-only seqno lookup.
 * Never called by app.js and never enables payment acceptance.
 */
import { TestnetRoomWalletSigner } from "./TestnetRoomWalletSigner.js";
import { TestnetWalletV4CryptoSigner } from "./TestnetWalletV4CryptoSigner.js";
import { createTestnetProtectedKeyResolver } from "./TestnetProtectedKeyResolver.js";

export function createProtectedTestnetRoomWalletSigner({
    walletPool, secretProvider, seqnoProvider
} = {}) {
    if (!walletPool || typeof walletPool.getWallet !== "function"
        || typeof walletPool.listWallets !== "function"
        || typeof secretProvider !== "function"
        || typeof seqnoProvider !== "function") {
        throw new Error("protected Testnet signer requires wallet pool, secret and seqno providers");
    }
    const keyResolver = createTestnetProtectedKeyResolver({
        walletPool, secretProvider
    });
    const cryptoSigner = new TestnetWalletV4CryptoSigner({
        keyResolver, seqnoProvider
    });
    return new TestnetRoomWalletSigner({
        walletPool,
        signWithWallet: request => cryptoSigner.signWithWallet(request)
    });
}
