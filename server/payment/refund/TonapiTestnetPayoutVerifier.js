/**
 * Independently check TON Center v3 source and recipient credit using the
 * separate TonAPI Testnet indexed blockchain service (Tonviewer ecosystem).
 * Read-only: no signing, no broadcast, no secret catalog access.
 * A 404, rate limit or unexpected field shape is never proof of payment.
 */
import { tonAddressIdentitiesEqual } from "../incoming/TonAddressIdentity.js";

const DEFAULT_BASE = "https://testnet.tonapi.io";
function validHash(hash) {
    // TON transaction/message hashes are 32 bytes, base64/base64url or hex.
    if(typeof hash !== "string") return false;
    return /^[a-fA-F0-9]{64}$/.test(hash)
        || /^[A-Za-z0-9_+\/-]{43}=?$/.test(hash);
}
function equalHash(a,b) {
    if(!validHash(a)||!validHash(b))return false;
    const decode=value => /^[a-fA-F0-9]{64}$/.test(value)
        ? Buffer.from(value,"hex") : Buffer.from(value.replace(/-/g,"+").replace(/_/g,"/"),"base64");
    return decode(a).equals(decode(b));
}
function nano(value) {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    if(typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))return null;
    const n=BigInt(value);
    return n<=BigInt(Number.MAX_SAFE_INTEGER)?Number(n):null;
}
function identity(account){
    return typeof account === "string" ? account : account?.address;
}
function transactionIsSuccessful(tx,hash,address) {
    return tx && equalHash(tx.hash,hash)
        && tonAddressIdentitiesEqual(identity(tx.account),address)
        && tx.success === true
        && tx.aborted === false;
}
export class TonapiTestnetPayoutVerifier {
    constructor({fetchImpl=globalThis.fetch,baseUrl=DEFAULT_BASE,
        apiKeyProvider=()=>process.env.TONAPI_API_KEY,timeoutMs=7000}={}) {
        if(typeof fetchImpl!=="function"||baseUrl!==DEFAULT_BASE
            ||typeof apiKeyProvider!=="function"
            ||!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>30000)
            throw new TypeError("invalid TonAPI Testnet read-only configuration");
        this._fetch=fetchImpl;
        this._apiKey=apiKeyProvider;
        this._timeout=timeoutMs;
        this._base=baseUrl;
    }
    async _transaction(hash) {
        if(!validHash(hash))return null;
        const controller=new AbortController();
        const timeout=setTimeout(()=>controller.abort(),this._timeout);
        try {
            const token=this._apiKey();
            const headers={Accept:"application/json"};
            if(typeof token==="string"&&token.trim()) headers.Authorization="Bearer "+token.trim();
            const url=this._base+"/v2/blockchain/transactions/"+encodeURIComponent(hash);
            const response=await this._fetch(url,{method:"GET",headers,signal:controller.signal});
            if(response.status!==200)return null;
            const data=await response.json();
            return data && !Array.isArray(data) && typeof data==="object"?data:null;
        } catch {return null;}
        finally {clearTimeout(timeout);}
    }
    async verifyTransfer({sourceTransactionId,recipientTransactionId,messageHash,
        sourceWalletAddress,destinationAddress,amountAtomic}={}) {
        if(!validHash(sourceTransactionId)||!validHash(recipientTransactionId)
            ||!validHash(messageHash)||sourceTransactionId===recipientTransactionId
            ||!Number.isSafeInteger(amountAtomic)||amountAtomic<=0)return null;
        const [source,recipient]=await Promise.all([
            this._transaction(sourceTransactionId),
            this._transaction(recipientTransactionId)
        ]);
        if(!transactionIsSuccessful(source,sourceTransactionId,sourceWalletAddress)
            ||!transactionIsSuccessful(recipient,recipientTransactionId,destinationAddress)
            ||!Array.isArray(source.out_msgs) ||source.out_msgs.length!==1)return null;
        const outgoing=source.out_msgs[0],incoming=recipient.in_msg;
        if(!incoming ||!equalHash(outgoing.hash,messageHash)
            ||!equalHash(incoming.hash,messageHash)
            ||!tonAddressIdentitiesEqual(identity(outgoing.source),sourceWalletAddress)
            ||!tonAddressIdentitiesEqual(identity(outgoing.destination),destinationAddress)
            ||!tonAddressIdentitiesEqual(identity(incoming.source),sourceWalletAddress)
            ||!tonAddressIdentitiesEqual(identity(incoming.destination),destinationAddress)
            ||nano(outgoing.value)!==amountAtomic ||nano(incoming.value)!==amountAtomic
            ||outgoing.bounced===true||incoming.bounced===true)return null;
        const actualFeeAtomic=nano(source.total_fees);
        // Amount of actual chain fee MUST be independently documented.
        if(actualFeeAtomic===null)return null;
        return Object.freeze({
            status:"INDEPENDENT_INDEXED_CREDIT_OBSERVED",
            sourceTransactionId,recipientTransactionId,messageHash,
            sourceWalletAddress,destinationAddress,amountAtomic,actualFeeAtomic,
            provider:"tonapi-testnet"
        });
    }
}
