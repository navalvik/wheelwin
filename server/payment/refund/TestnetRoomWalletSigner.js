import { Buffer } from "node:buffer";
import { tonAddressIdentitiesEqual, tonAddressIdentityOrNull } from "../incoming/TonAddressIdentity.js";

/**
 * Adapter for an explicitly supplied signing service for the 64 existing
 * Testnet wallets. No seed phrase or private key is loaded in this process.
 * The service must attest the public source wallet it actually used.
 */
export class TestnetRoomWalletSigner {
    constructor({ walletPool, signWithWallet } = {}) {
        if (!walletPool || typeof walletPool.listWallets !== "function"
            || typeof signWithWallet !== "function") {
            throw new Error("authorized Testnet wallet pool and signing callback required");
        }
        this._walletPool = walletPool;
        this._sign = signWithWallet;
    }

    async signTransfer(descriptor) {
        if (descriptor?.networkName !== "TESTNET" || descriptor?.globalId !== -3
            || !Number.isSafeInteger(descriptor?.amountAtomic)
            || descriptor.amountAtomic <= 0
            || !tonAddressIdentityOrNull(descriptor?.from)
            || !tonAddressIdentityOrNull(descriptor?.to)
            || typeof descriptor?.idempotencyKey !== "string"
            || descriptor.idempotencyKey.trim() === "") {
            throw new Error("invalid Testnet signing authorization");
        }
        const candidates = this._walletPool.listWallets().filter(wallet =>
            wallet.network === "testnet"
            && tonAddressIdentitiesEqual(wallet.address, descriptor.from)
        );
        if (candidates.length !== 1) throw new Error("source wallet missing or ambiguous");
        const wallet = candidates[0];
        const signed = await this._sign(Object.freeze({
            walletId: wallet.walletId,
            roomNumber: wallet.roomNumber,
            from: descriptor.from,
            to: descriptor.to,
            amountAtomic: descriptor.amountAtomic,
            idempotencyKey: descriptor.idempotencyKey,
            obligationId: descriptor.obligationId,
            networkName: "TESTNET",
            globalId: -3
        }));
        if (!signed || !tonAddressIdentitiesEqual(signed.sourceWalletAddress, wallet.address)
            || !isTonBocEnvelope(signed.boc)) {
            throw new Error("signer response lacks matching source identity or signed BOC");
        }
        return Object.freeze({ boc: signed.boc });
    }
}

/** Minimal envelope check; full Wallet V4 signature validation belongs to the signer. */
export function isTonBocEnvelope(boc) {
    if (typeof boc !== "string" || boc.length < 12
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(boc) || boc.length % 4 !== 0) return false;
    const bytes = Buffer.from(boc, "base64");
    return bytes.length >= 10 && bytes.subarray(0, 4).equals(Buffer.from([0xb5, 0xee, 0x9c, 0x72]));
}
