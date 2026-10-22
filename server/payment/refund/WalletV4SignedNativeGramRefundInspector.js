/**
 * Read-only inspection of ONE native TON refund signed with Wallet V4R2.
 *
 * The supplied walletStateReader MUST independently authenticate current
 * Testnet account identity, deployed V4R2 code hash, public key, wallet id
 * and seqno from a trusted on-chain source. Signer-provided state is forbidden.
 * The inspector does not sign, broadcast or change the acceptance flag.
 */
import { tonAddressIdentitiesEqual } from "../incoming/TonAddressIdentity.js";
import { signedRefundBocHashOrNull } from "./SignedNativeGramRefundEvidence.js";
import { decodeWalletV4NativeRefundBody } from "./WalletV4NativeRefundDecoder.js";
import { verifyWalletV4SignedPayloadSignature } from "./WalletV4SignedPayloadSignature.js";

const V4R2_CODE_HASH = "feb5ff6820e2ff0d9483e7e0d62c817d846789fb4ae580c878866d959dabd5c0";

export class WalletV4SignedNativeGramRefundInspector {
    constructor({ walletStateReader, nowSeconds = () => Math.floor(Date.now() / 1000) } = {}) {
        if (typeof walletStateReader?.getVerifiedWalletState !== "function")
            throw Error("TRUSTED_TESTNET_WALLET_STATE_READER_REQUIRED");
        this._walletStateReader = walletStateReader;
        this._nowSeconds = nowSeconds;
    }

    async inspect({ signedTransfer, expected }) {
        const reject = Object.freeze({ verified: false });
        if (expected?.networkName !== "TESTNET" || expected?.globalId !== -3 ||
            expected?.sendRemainingBalance !== false ||
            typeof signedTransfer?.boc !== "string") return reject;
        const bocSha256 = signedRefundBocHashOrNull(signedTransfer);
        if (!bocSha256) return reject;
        try {
            const bytes = Buffer.from(signedTransfer.boc, "base64");
            const parsed = decodeWalletV4NativeRefundBody(bytes);
            if (!tonAddressIdentitiesEqual(parsed.to, expected.to) ||
                parsed.amountAtomic !== expected.amountAtomic ||
                (parsed.sendMode !== 1 && parsed.sendMode !== 3)) return reject;

            const state = await this._walletStateReader.getVerifiedWalletState({
                networkName: "TESTNET", globalId: -3,
                sourceWalletAddress: expected.from
            });
            if (state?.networkName !== "TESTNET" || state?.globalId !== -3 ||
                !tonAddressIdentitiesEqual(state?.sourceWalletAddress, expected.from) ||
                state?.version !== "V4R2" ||
                state?.codeHash !== V4R2_CODE_HASH ||
                state?.verifiedOnChain !== true ||
                !Number.isSafeInteger(state.walletId) ||
                state.walletId !== parsed.walletId ||
                !Number.isSafeInteger(state.seqno) ||
                state.seqno !== parsed.seqno ||
                !Buffer.isBuffer(state.publicKey) || state.publicKey.length !== 32 ||
                !verifyWalletV4SignedPayloadSignature(bytes, state.publicKey)) {
                return reject;
            }
            const now = this._nowSeconds();
            if (!Number.isSafeInteger(now) || parsed.validUntil <= now ||
                parsed.validUntil > now + 600) return reject;
            return Object.freeze({
                verified: true, evidenceSource: "decoded-signed-ton-boc",
                bocSha256,
                networkName: "TESTNET", globalId: -3,
                // The idempotency key is authoritative request context, not
                // an independently signed V4 message field.
                idempotencyKey: expected.idempotencyKey,
                from: expected.from,
                messages: Object.freeze([Object.freeze({
                    to: parsed.to, amountAtomic: parsed.amountAtomic,
                    sendMode: parsed.sendMode,
                    sendRemainingBalance: false,
                    bounce: parsed.bounce
                })])
            });
        } catch {
            return reject;
        }
    }
}
