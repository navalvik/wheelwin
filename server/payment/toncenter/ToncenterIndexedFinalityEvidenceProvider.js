/**
 * Page4 Testnet settlement evidence from historical, indexed Toncenter v3
 * transactions. No Streaming/SSE subscription, no requirement to observe
 * a transfer after a subscription was opened.
 *
 * We only authorize an already indexed, non-emulated incoming transaction
 * with a real shard-block reference and masterchain inclusion watermark.
 * The same authenticated Testnet client supplies a current masterchain head.
 * Sender, destination, amount, reference, time, duplicates and the 3/3
 * game gate continue to be checked by the existing settlement coordinator.
 */
import { PaymentConfigurationError, PaymentValidationError } from "../PaymentErrors.js";
import { TonPaymentSettlementEvidenceProvider, TON_TESTNET_GLOBAL_ID } from "../incoming/TonPaymentSettlementEvidence.js";
import { tonAddressIdentitiesEqual } from "../incoming/TonAddressIdentity.js";
import { ToncenterTransactionsClient } from "./ToncenterTransactionsClient.js";
import { requireToncenterChainConfig } from "./ToncenterConstants.js";

const sessions = new WeakMap();

function validBlock(block) {
    return block && Number.isSafeInteger(block.workchain)
        && typeof block.shard === "string" && block.shard.length > 0
        && Number.isSafeInteger(block.seqno) && block.seqno > 0;
}

export class ToncenterIndexedFinalityEvidenceProvider extends TonPaymentSettlementEvidenceProvider {
    constructor({client,nowProvider=Date.now,minimumMasterchainDepth=1,network="testnet"}={}) {
        super();
        if (!(client instanceof ToncenterTransactionsClient))
            throw new PaymentConfigurationError("indexed finality requires ToncenterTransactionsClient");
        const chain = requireToncenterChainConfig(network);
        let base;
        try {base=new URL(client.baseUrl);}catch{}
        if (!base || base.origin !== chain.baseUrl || base.pathname !== "/"
            || base.search || base.hash || base.username || base.password)
            throw new PaymentConfigurationError(chain.network === "testnet"
                ? "indexed finality restricted to Testnet"
                : "indexed finality restricted to selected TON network");
        if(typeof nowProvider !== "function"
            || !Number.isSafeInteger(minimumMasterchainDepth)
            || minimumMasterchainDepth<0)
            throw new PaymentConfigurationError("invalid indexed finality configuration");
        this._client=client;
        this._chain=chain;
        this._now=nowProvider;
        this._depth=minimumMasterchainDepth;
    }

    async beginObservation({accountId}={}) {
        if (typeof accountId !== "string" || !accountId.trim())
            throw new PaymentValidationError("accountId is required");
        const session=Object.freeze({});
        sessions.set(session,{accountId:accountId.trim(),closed:false,valid:true,masterchainPromise:null});
        return session; // no network request and no SSE stream
    }

    async getSettlementEvidence({accountId,providerTransactionId,
        observationSession,indexedTransaction}={}) {
        const state=sessions.get(observationSession);
        if(!state || state.closed || !state.valid
            || typeof accountId !== "string"
            || !tonAddressIdentitiesEqual(accountId,state.accountId)
            || !indexedTransaction || indexedTransaction.transactionId !== providerTransactionId
            || !tonAddressIdentitiesEqual(indexedTransaction.accountId,accountId)
            || !validBlock(indexedTransaction.block)
            || !Number.isSafeInteger(indexedTransaction.mcBlockSeqno)
            || indexedTransaction.mcBlockSeqno <= 0
            || indexedTransaction.emulated !== false) return null;

        if(!state.masterchainPromise) {
            state.masterchainPromise=this._client.getMasterchainInfo();
        }
        let chain;
        try {chain=await state.masterchainPromise;}
        catch {state.valid=false; return null;}
        const head=chain?.last;
        if(head?.global_id !== this._chain.globalId
            || !Number.isSafeInteger(head.seqno)
            || head.seqno < indexedTransaction.mcBlockSeqno + this._depth) {
            return null;
        }
        const now=this._now();
        const block=indexedTransaction.block;
        const inclusion=Object.freeze({
            workchain:block.workchain,shard:block.shard,seqno:block.seqno
        });
        return Object.freeze({
            networkIdentity:Object.freeze({
                network:this._chain.network,globalId:this._chain.globalId,
                source:"toncenter-masterchain-info",observedAtMs:now
            }),
            transactionInclusion:Object.freeze({
                transactionId:providerTransactionId,accountId,
                block:inclusion
            }),
            finality:Object.freeze({
                status:"finalized",source:"toncenter-indexed-v3-masterchain",
                transactionId:providerTransactionId,accountId,
                block:inclusion,
                masterchainSeqno:indexedTransaction.mcBlockSeqno,
                observedAtMs:now
            })
        });
    }

    // Evidence remains valid after the HTTP observation completes. Closing a
    // local session is NOT revocation of an already finalized blockchain tx.
    isObservationValid(session) {
        return sessions.get(session)?.valid === true;
    }
    async endObservation(session) {
        const state=sessions.get(session);
        if(state) state.closed=true;
    }
}
