/**
 * Isolated Wallet V4R2 cryptographic signer for TON Testnet.
 * This module is NOT wired into server/app.js. Invoke only inside a protected
 * signing process, using an authorized keyResolver; never persist or log keys.
 * @ton/ton and @ton/core must be installed in that isolated process.
 */
import { Buffer } from "node:buffer";
import { tonAddressIdentitiesEqual } from "../incoming/TonAddressIdentity.js";

export class TestnetWalletV4CryptoSigner {
    constructor({ keyResolver, seqnoProvider } = {}) {
        if (typeof keyResolver !== "function" || typeof seqnoProvider !== "function") {
            throw new Error("protected key resolver and Testnet seqno provider required");
        }
        this._keys = keyResolver;
        this._seqno = seqnoProvider;
    }

    async signWithWallet(request) {
        if (request?.globalId !== -3 || request?.networkName !== "TESTNET"
            || !request.walletId || !Number.isSafeInteger(request.amountAtomic)
            || request.amountAtomic <= 0 || !request.from || !request.to) {
            throw new Error("Testnet WalletV4 signing request invalid");
        }

        const { WalletContractV4, internal, SendMode } = await import("@ton/ton");
        const { beginCell, external, storeMessage } = await import("@ton/core");
        const material = await this._keys(request.walletId);
        if (!material || !Buffer.isBuffer(material.publicKey)
            || material.publicKey.length !== 32
            || !Buffer.isBuffer(material.secretKey) || material.secretKey.length !== 64) {
            throw new Error("wallet signing material unavailable or malformed");
        }
        const wallet = WalletContractV4.create({
            workchain: 0, publicKey: material.publicKey
        });
        if (!tonAddressIdentitiesEqual(wallet.address.toRawString(), request.from)) {
            throw new Error("signing key does not match authoritative room wallet");
        }
        const seqno = await this._seqno(wallet.address.toRawString());
        if (!Number.isSafeInteger(seqno) || seqno < 0 || seqno > 0xffffffff) {
            throw new Error("Testnet wallet seqno unavailable");
        }
        const transfer = await wallet.createTransfer({
            seqno,
            secretKey: material.secretKey,
            sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
            messages: [internal({
                to: request.to,
                value: BigInt(request.amountAtomic),
                bounce: false
            })]
        });
        const message = external({
            to: wallet.address,
            init: seqno === 0 ? wallet.init : undefined,
            body: transfer
        });
        const boc = beginCell().store(storeMessage(message)).endCell().toBoc().toString("base64");
        return Object.freeze({ sourceWalletAddress: wallet.address.toRawString(), boc });
    }
}
