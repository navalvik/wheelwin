/**
 * Read-only TON Center Testnet outgoing transfer observer.
 *
 * Never signs, broadcasts, or treats a transaction row alone as finality.
 * Validates source wallet, a successful non-aborted wallet action, destination,
 * transferred nanotons, and the enclosing source transaction hash.
 */
import {tonAddressIdentitiesEqual,tonAddressIdentityOrNull} from "../incoming/TonAddressIdentity.js";

function parseAmount(value) {
    if(typeof value!=="string"||!/^(0|[1-9][0-9]*)$/.test(value))return null;
    const n=BigInt(value);
    return n>0n&&n<=BigInt(Number.MAX_SAFE_INTEGER)?Number(n):null;
}
function mapOutputs(row,sourceWalletAddress) {
    if(!row || typeof row.hash!=="string" || !row.hash.trim()
        || !tonAddressIdentitiesEqual(row.account,sourceWalletAddress)
        || row.description?.aborted!==false
        || row.description?.action?.success!==true
        || !Array.isArray(row.out_msgs))return [];
    const seen=[];
    for(const msg of row.out_msgs){
        if(!msg || !tonAddressIdentitiesEqual(msg.source,sourceWalletAddress)
            || msg.bounced===true
            || tonAddressIdentityOrNull(msg.destination)===null)continue;
        const amountAtomic=parseAmount(msg.value);
        if(amountAtomic===null)continue;
        seen.push(Object.freeze({
            transactionId:row.hash,
            sourceAddress:row.account,
            destinationAddress:msg.destination,
            amountAtomic
        }));
    }
    return seen;
}
export class ToncenterTestnetOutgoingTransferProvider {
    constructor({client,nowProvider=Date.now,lookbackMs=7*24*60*60*1000}={}) {
        if(typeof client?.getTransactions!=="function"
            ||typeof nowProvider!=="function"
            ||!Number.isSafeInteger(lookbackMs)||lookbackMs<=0)
            throw new TypeError("Testnet outgoing history provider requires read-only client");
        this._client=client;
        this._now=nowProvider;
        this._window=lookbackMs;
    }
    async _history(sourceWalletAddress,{minCreatedAtMs=null}={}){
        if(tonAddressIdentityOrNull(sourceWalletAddress)===null)
            throw new Error("OUTGOING_SOURCE_ADDRESS_INVALID");
        const nowMs=this._now();
        if(!Number.isSafeInteger(nowMs)||nowMs<this._window)
            throw new Error("OUTGOING_HISTORY_TIME_INVALID");
        if(minCreatedAtMs!==null && (!Number.isSafeInteger(minCreatedAtMs)
            || minCreatedAtMs<0 || minCreatedAtMs>nowMs))
            throw new Error("OUTGOING_HISTORY_START_INVALID");
        const minStartMs=minCreatedAtMs===null?nowMs-this._window
            :Math.max(nowMs-this._window,minCreatedAtMs);
        const response=await this._client.getTransactions({
            account:sourceWalletAddress,
            startUtime:Math.floor(minStartMs/1000),
            endUtime:Math.floor(nowMs/1000),
            limit:1000
        });
        if(!Array.isArray(response?.transactions))
            throw new Error("OUTGOING_TRANSACTIONS_UNAVAILABLE");
        return response.transactions.filter(row=>
            minCreatedAtMs===null ||
            (Number.isSafeInteger(row?.now)
                && row.now>=Math.floor(minCreatedAtMs/1000))
        );
    }

    /**
     * Correlate a source wallet's outgoing internal message to the exact
     * destination wallet's incoming message by message hash. A source-side
     * transaction alone never proves that the recipient was credited.
     *
     * This is TWO independent account-history reads. Historical inclusion is
     * NOT a finality certificate; the result is deliberately unfinalized.
     */
    async observeRecipientCredit({
        sourceWalletAddress,destinationIdentity,transactionId,
        amountAtomic,minCreatedAtMs=null
    }={}){
        if(typeof transactionId!=="string"||!transactionId.trim()
            ||tonAddressIdentityOrNull(sourceWalletAddress)===null
            ||tonAddressIdentityOrNull(destinationIdentity)===null
            ||!Number.isSafeInteger(amountAtomic)||amountAtomic<=0)return null;
        const [sourceRows,recipientRows]=await Promise.all([
            this._history(sourceWalletAddress,{minCreatedAtMs}),
            this._history(destinationIdentity,{minCreatedAtMs})
        ]);
        const sourceTx=sourceRows.filter(row=>row.hash===transactionId
            &&row.description?.aborted===false
            &&row.description?.action?.success===true
            &&tonAddressIdentitiesEqual(row.account,sourceWalletAddress)
            &&Array.isArray(row.out_msgs)&&row.out_msgs.length===1);
        if(sourceTx.length!==1)return null;
        const message=sourceTx[0].out_msgs[0];
        if(typeof message?.hash!=="string"||!message.hash.trim()
            ||!tonAddressIdentitiesEqual(message.source,sourceWalletAddress)
            ||!tonAddressIdentitiesEqual(message.destination,destinationIdentity)
            ||parseAmount(message.value)!==amountAtomic
            ||message.bounced===true)return null;
        const matches=recipientRows.filter(row=>
            typeof row.hash==="string" && row.hash.trim()!==""
            &&tonAddressIdentitiesEqual(row.account,destinationIdentity)
            &&row.description?.aborted===false
            &&row.in_msg?.hash===message.hash
            &&tonAddressIdentitiesEqual(row.in_msg?.source,sourceWalletAddress)
            &&tonAddressIdentitiesEqual(row.in_msg?.destination,destinationIdentity)
            &&parseAmount(row.in_msg?.value)===amountAtomic
            &&row.in_msg?.bounced!==true
        );
        if(matches.length!==1)return null;
        return Object.freeze({
            status:"RECIPIENT_CREDIT_OBSERVED_UNFINALIZED",
            sourceTransactionId:transactionId,
            recipientTransactionId:matches[0].hash,
            messageHash:message.hash,
            sourceWalletAddress,
            destinationAddress:destinationIdentity,
            amountAtomic
        });
    }
    async getOutgoingTransfer({sourceWalletAddress,transactionId}={}){
        if(typeof transactionId!=="string"||!transactionId.trim())return null;
        const transactions=await this._history(sourceWalletAddress);
        const rows=transactions.filter(row=>row.hash===transactionId);
        if(rows.length!==1)return null;
        const outputs=mapOutputs(rows[0],sourceWalletAddress);
        // Refunds have one external Wallet V4 message and exactly one
        // ordinary internal transfer. Extra outputs are held for inspection.
        return outputs.length===1?outputs[0]:null;
    }
    async findOutgoingTransfer({sourceWalletAddress,destinationIdentity,amountAtomic,minCreatedAtMs=null}={}){
        if(tonAddressIdentityOrNull(destinationIdentity)===null
            ||!Number.isSafeInteger(amountAtomic)||amountAtomic<=0)return null;
        const transactions=await this._history(sourceWalletAddress,{minCreatedAtMs});
        const matches=[];
        for(const row of transactions){
            const outputs=mapOutputs(row,sourceWalletAddress);
            // One refund output per source transaction is required.
            if(outputs.length!==1)continue;
            const o=outputs[0];
            if(o.amountAtomic===amountAtomic
                &&tonAddressIdentitiesEqual(o.destinationAddress,destinationIdentity))
                matches.push(o);
        }
        if(matches.length!==1)
            return matches.length>1?Object.freeze({ambiguous:true}):null;
        return matches[0];
    }
}
