/**
 * Minimal TON Testnet RPC surface required by the restored native Wallet V4
 * adapter. It never reads signing material; only the room-wallet resolver does.
 * No escrow, game contract, Jetton, or Mainnet endpoint.
 */
import {Address} from "@ton/core";
import {TonClient} from "@ton/ton";

export class TestnetNativeTonService {
    constructor({client=null,endpoint="https://testnet.toncenter.com/api/v2/jsonRPC",
        apiKey=process.env.TON_API_KEY}={}) {
        this._client=client??new TonClient({endpoint,apiKey:apiKey||undefined});
    }
    async getSeqno(address) {
        const result=await this._client.runMethod(Address.parse(address),"seqno");
        return result.stack.readNumber();
    }
    async getBalance(address) {
        return BigInt(await this._client.getBalance(Address.parse(address)));
    }
    async estimateExternalMessageFee(address,{body,initCode=null,initData=null,ignoreSignature=true}={}) {
        return this._client.estimateExternalMessageFee(Address.parse(address),{
            body,initCode,initData,ignoreSignature
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
