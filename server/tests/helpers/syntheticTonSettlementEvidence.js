import { TonPaymentSettlementEvidenceProvider } from "../../payment/toncenter/index.js";

/** Test-only provider. It models documented provider evidence and makes no network calls. */
export class SyntheticTonSettlementEvidenceProvider extends TonPaymentSettlementEvidenceProvider {
    constructor({ nowProvider = Date.now, evidenceFactory = null } = {}) {
        super();
        this._nowProvider = nowProvider;
        this._evidenceFactory = evidenceFactory;
    }

    async getSettlementEvidence(query) {
        if (this._evidenceFactory) return this._evidenceFactory(query);
        const observedAtMs = this._nowProvider();
        const block = { workchain: 0, shard: "8000000000000000", seqno: 10 };
        return {
            networkIdentity: {
                network: "testnet",
                globalId: -3,
                source: "toncenter-masterchain-info",
                observedAtMs
            },
            transactionInclusion: {
                transactionId: query.providerTransactionId,
                accountId: query.accountId,
                block
            },
            finality: {
                status: "finalized",
                source: "toncenter-streaming-v2",
                transactionId: query.providerTransactionId,
                accountId: query.accountId,
                block,
                masterchainSeqno: 11,
                observedAtMs
            }
        };
    }
}
