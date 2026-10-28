/**
 * Minimal TON Testnet RPC surface required by the restored native Wallet V4
 * adapter. It never reads signing material; only the room-wallet resolver does.
 * No escrow, game contract, Jetton, or Mainnet endpoint.
 */
import {Address} from "@ton/core";
import {TonClient} from "@ton/ton";
const parseAddress = value => Address.isAddress(value) ? value : Address.parse(value);

export class TestnetNativeTonService {
    constructor({client=null,endpoint="https://testnet.toncenter.com/api/v2/jsonRPC",
        apiKey=process.env.TON_API_KEY}={}) {
        this._client=client??new TonClient({endpoint,apiKey:apiKey||undefined});
    }
    async getSeqno(address) {
        const account=parseAddress(address);
        // Only an authoritative "uninitialized" account state permits
        // WalletV4 seqno 0 and StateInit. A failed RPC is not evidence that
        // the wallet is fresh; never sign seqno 0 on an unknown active wallet.
        const state=await this._client.getContractState(account);
        if(state?.state==="uninitialized")return 0;
        if(state?.state!=="active")
            throw new Error("TESTNET_WALLET_STATE_UNAVAILABLE");
        const result=await this._client.runMethod(account,"seqno");
        const seqno=result?.stack?.readNumber?.();
        if(!Number.isSafeInteger(seqno)||seqno<0)
            throw new Error("TESTNET_WALLET_SEQNO_INVALID");
        return seqno;
    }
    async getBalance(address) {
        return BigInt(await this._client.getBalance(parseAddress(address)));
    }
    async estimateExternalMessageFee(address,{body,initCode=null,initData=null,ignoreSignature=true}={}) {
        const result = await this._client.estimateExternalMessageFee(parseAddress(address),{
            body,initCode,initData,ignoreSignature
        });
        const source = result?.source_fees;
        if (!source) throw new Error("TESTNET_FEE_QUOTE_MISSING");
        const fee = name => {
            const value = source[name];
            if (!Number.isSafeInteger(value) || value < 0)
                throw new Error("TESTNET_FEE_QUOTE_INVALID");
            return BigInt(value);
        };
        const inFwdFeeNano=fee("in_fwd_fee");
        const storageFeeNano=fee("storage_fee");
        const gasFeeNano=fee("gas_fee");
        const fwdFeeNano=fee("fwd_fee");
        return Object.freeze({
            inFwdFeeNano,storageFeeNano,gasFeeNano,fwdFeeNano,
            totalFeeNano:inFwdFeeNano+storageFeeNano+gasFeeNano+fwdFeeNano
        });
    }
    async broadcastTransaction(base64Boc) {
        if(typeof base64Boc!=="string"||!base64Boc)throw new TypeError("invalid message BOC");
        const boc=Buffer.from(base64Boc,"base64");
        if(!boc.length)throw new TypeError("empty message BOC");
        await this._client.sendFile(boc);
        // RPC acknowledgement is not proof of inclusion or outgoing delivery.
        return Object.freeze({status:"SUBMITTED_UNCONFIRMED"});
    }
}
