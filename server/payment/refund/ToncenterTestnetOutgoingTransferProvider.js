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
    constructor({client,nowProvider=Date.now,lookbackMs=7*24*60*60*1000,
        pageSize=1000,maxPages=5}={}) {
        if(typeof client?.getTransactions!=="function"
            ||typeof nowProvider!=="function"
            ||!Number.isSafeInteger(lookbackMs)||lookbackMs<=0
            ||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>1000
            ||!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>50)
            throw new TypeError("Testnet outgoing history provider requires bounded read-only client");
        this._client=client;
        this._now=nowProvider;
        this._window=lookbackMs;
        this._pageSize=pageSize;
        this._maxPages=maxPages;
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
        // An explicit durable claim may be older than seven days.
        // Never silently truncate its history. The page budget still bounds
        // costs and reports OUTGOING_HISTORY_INCOMPLETE when necessary.
        const minStartMs=minCreatedAtMs===null?nowMs-this._window
            :minCreatedAtMs;
        const rows=[];
        const unique=new Set();
        // Pages are by descending logical time. Never interpret a partial
        // scan (provider cap, malformed page, page drift) as "no transfer".
        for(let page=0;page<this._maxPages;page++){
            const response=await this._client.getTransactions({
                account:sourceWalletAddress,
                startUtime:Math.floor(minStartMs/1000),
                endUtime:Math.floor(nowMs/1000),
                limit:this._pageSize,
                offset:page*this._pageSize
            });
            const batch=response?.transactions;
            if(!Array.isArray(batch) || batch.length>this._pageSize)
                throw new Error("OUTGOING_TRANSACTIONS_UNAVAILABLE");
            for(const row of batch){
                if(typeof row?.hash!=="string"||!row.hash)
                    throw new Error("OUTGOING_HISTORY_MALFORMED");
                if(unique.has(row.hash))
                    throw new Error("OUTGOING_HISTORY_PAGE_DRIFT");
                unique.add(row.hash);
                if(minCreatedAtMs===null ||
                    (Number.isSafeInteger(row.now)
                        &&row.now>=Math.floor(minCreatedAtMs/1000)))rows.push(row);
            }
            if(batch.length<this._pageSize)return rows;
        }
        throw new Error("OUTGOING_HISTORY_INCOMPLETE");

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
            amountAtomic,
            sourceIndex: Object.freeze({
                mcBlockSeqno: sourceTx[0].mc_block_seqno ?? null,
                blockRef: sourceTx[0].block_ref ?? null,
                emulated: sourceTx[0].emulated ?? null,
                finality: sourceTx[0].finality ?? null
            }),
            recipientIndex: Object.freeze({
                mcBlockSeqno: matches[0].mc_block_seqno ?? null,
                blockRef: matches[0].block_ref ?? null,
                emulated: matches[0].emulated ?? null,
                finality: matches[0].finality ?? null
            })
        });
    }

    /**
     * Restart-safe read-only historical reconciliation, from v3 indexed
     * transaction history plus v3 masterchainInfo. A matching outgoing message
     * and destination credit must BOTH be indexed under valid Testnet
     * masterchain blocks strictly behind the latest indexed masterchain head.
     *
     * This is explicitly PROVIDER-INDEXED evidence; do not pretend it is an
     * SSE finalized event, cryptographic Merkle proof, or successful ledger
     * settlement. SSE subscriptions cannot replay past finalized events.
     */
    async verifyIndexedRecipientCredit(query = {}) {
        const observed = await this.observeRecipientCredit(query);
        if (!observed || typeof this._client.getMasterchainInfo !== "function")
            return null;

        const validBlock = (index) =>
            Number.isSafeInteger(index?.mcBlockSeqno)
            && index.mcBlockSeqno > 0
            && index.emulated !== true
            // TON Indexer models.FinalityStateFinalized == 2.
            && index.finality === 2
            && index.blockRef?.workchain === 0
            && Number.isSafeInteger(index.blockRef.seqno)
            && index.blockRef.seqno > 0
            && typeof index.blockRef.shard === "string"
            && index.blockRef.shard.length > 0;
        if (!validBlock(observed.sourceIndex)
            || !validBlock(observed.recipientIndex))
            return null;

        const info = await this._client.getMasterchainInfo();
        const latest = info?.last;
        if (latest?.global_id !== -3
            || !Number.isSafeInteger(latest.seqno)
            || latest.seqno <= observed.sourceIndex.mcBlockSeqno
            || latest.seqno <= observed.recipientIndex.mcBlockSeqno)
            return null;

        return Object.freeze({
            status: "MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED",
            sourceTransactionId: observed.sourceTransactionId,
            recipientTransactionId: observed.recipientTransactionId,
            messageHash: observed.messageHash,
            sourceWalletAddress: observed.sourceWalletAddress,
            destinationAddress: observed.destinationAddress,
            amountAtomic: observed.amountAtomic,
            sourceMcBlockSeqno: observed.sourceIndex.mcBlockSeqno,
            recipientMcBlockSeqno: observed.recipientIndex.mcBlockSeqno,
            sourceBlockRef: Object.freeze({...observed.sourceIndex.blockRef}),
            recipientBlockRef: Object.freeze({...observed.recipientIndex.blockRef}),
            latestIndexedMcBlockSeqno: latest.seqno,
            globalId: -3,
            sourceFinality: "finalized",
            recipientFinality: "finalized"
        });
    }
    async getOutgoingTransfer({sourceWalletAddress,transactionId,minCreatedAtMs=null}={}){
        if(typeof transactionId!=="string"||!transactionId.trim())return null;
        const transactions=await this._history(sourceWalletAddress,{minCreatedAtMs});
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
