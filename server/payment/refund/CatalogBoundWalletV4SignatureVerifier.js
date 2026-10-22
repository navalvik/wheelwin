/**
 * Resolve a signing key exclusively from the authoritative room-wallet catalog.
 * Never accept a key from signedTransfer, signer metadata or a client request.
 * The catalog itself must be provisioned and validated independently.
 */
import { tonAddressIdentitiesEqual } from "../incoming/TonAddressIdentity.js";
import { verifyWalletV4RefundEd25519 } from "./WalletV4RefundEd25519.js";

export function createCatalogBoundWalletV4SignatureVerifier({ walletPool }) {
    if (typeof walletPool?.listWallets !== "function")
        throw Error("TRUSTED_WALLET_CATALOG_REQUIRED");
    return async function verifyWalletV4Signature({
        signedTransfer, sourceWalletAddress, networkName, globalId
    }) {
        if (networkName !== "testnet" || globalId !== -3 ||
            typeof sourceWalletAddress !== "string" ||
            typeof signedTransfer?.boc !== "string") return false;
        const matches = walletPool.listWallets().filter(wallet => {
            try {
                return wallet.network === "testnet" &&
                    tonAddressIdentitiesEqual(wallet.address, sourceWalletAddress);
            } catch { return false; }
        });
        if (matches.length !== 1) return false;
        const trustedKey = matches[0].publicKey;
        if (typeof trustedKey !== "string" ||
            !/^[a-fA-F0-9]{64}$/.test(trustedKey)) return false;
        return verifyWalletV4RefundEd25519({
            boc: signedTransfer.boc, publicKeyHex: trustedKey
        });
    };
}
