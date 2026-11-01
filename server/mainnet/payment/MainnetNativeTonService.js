import { Address } from "@ton/core";
import { TonClient } from "@ton/ton";
import { MAINNET_GLOBAL_ID } from "../config/MainnetRuntimeConfig.js";

export const MAINNET_TONCENTER_RPC_ENDPOINT = "https://toncenter.com/api/v2/jsonRPC";

const parseAddress = (value) => Address.isAddress(value) ? value : Address.parse(value);

/** Mainnet counterpart of TestnetNativeTonService; transport methods match its behavior. */
export class MainnetNativeTonService {
    constructor({ config, client = null } = {}) {
        if (config?.network !== "mainnet" || config?.globalId !== MAINNET_GLOBAL_ID
            || config?.toncenterBaseUrl !== "https://toncenter.com"
            || typeof config?.apiKeyProvider !== "function") {
            throw new Error("MAINNET_NATIVE_TON_CONFIG_REQUIRED");
        }
        const apiKey = config.apiKeyProvider();
        if (typeof apiKey !== "string" || !apiKey.trim()) {
            throw new Error("MAINNET_NATIVE_TON_API_KEY_REQUIRED");
        }
        this._client = client ?? new TonClient({
            endpoint: MAINNET_TONCENTER_RPC_ENDPOINT,
            apiKey: apiKey.trim()
        });
    }

    async getSeqno(address) {
        const account = parseAddress(address);
        const state = await this._client.getContractState(account);
        if (state?.state === "uninitialized") return 0;
        if (state?.state !== "active") throw new Error("MAINNET_WALLET_STATE_UNAVAILABLE");
        const result = await this._client.runMethod(account, "seqno");
        const seqno = result?.stack?.readNumber?.();
        if (!Number.isSafeInteger(seqno) || seqno < 0) {
            throw new Error("MAINNET_WALLET_SEQNO_INVALID");
        }
        return seqno;
    }

    async getBalance(address) {
        return BigInt(await this._client.getBalance(parseAddress(address)));
    }

    async estimateExternalMessageFee(address, { body, initCode = null, initData = null,
        ignoreSignature = true } = {}) {
        const result = await this._client.estimateExternalMessageFee(parseAddress(address), {
            body, initCode, initData, ignoreSignature
        });
        const source = result?.source_fees;
        if (!source) throw new Error("MAINNET_FEE_QUOTE_MISSING");
        const fee = (name) => {
            const value = source[name];
            if (!Number.isSafeInteger(value) || value < 0) throw new Error("MAINNET_FEE_QUOTE_INVALID");
            return BigInt(value);
        };
        const inFwdFeeNano = fee("in_fwd_fee");
        const storageFeeNano = fee("storage_fee");
        const gasFeeNano = fee("gas_fee");
        const fwdFeeNano = fee("fwd_fee");
        return Object.freeze({ inFwdFeeNano, storageFeeNano, gasFeeNano, fwdFeeNano,
            totalFeeNano: inFwdFeeNano + storageFeeNano + gasFeeNano + fwdFeeNano });
    }

    async broadcastTransaction(base64Boc) {
        if (typeof base64Boc !== "string" || !base64Boc) throw new TypeError("invalid message BOC");
        const boc = Buffer.from(base64Boc, "base64");
        if (!boc.length) throw new TypeError("empty message BOC");
        await this._client.sendFile(boc);
        // As in the Testnet transport, an RPC acknowledgement is not finality evidence.
        return Object.freeze({ status: "SUBMITTED_UNCONFIRMED" });
    }
}
