import {ToncenterTransactionsClient} from "../toncenter/ToncenterTransactionsClient.js";
import {ToncenterIncomingProvider} from "../toncenter/ToncenterIncomingProvider.js";
import {mapToncenterTransactionsResponse} from "../toncenter/ToncenterTransactionsMapper.js";
import {requireToncenterChainConfig} from "../toncenter/ToncenterConstants.js";
import {ToncenterTestnetOutgoingTransferProvider} from "../refund/ToncenterTestnetOutgoingTransferProvider.js";
import {TonapiTestnetPayoutVerifier} from "../refund/TonapiTestnetPayoutVerifier.js";
import {TestnetPendingRefundReconciler} from "./TestnetPendingRefundReconciler.js";
import {HistoricalIncomingReceiptReconciler} from "./HistoricalIncomingReceiptReconciler.js";

/**
 * Connect the EXISTING Testnet recovery workers to the Mainnet namespace.
 * These workers only read Toncenter/TonAPI and reconcile persisted evidence.
 * There is NO signer, payout transport, refund executor or wallet-key loader.
 * Only closed rooms and ambiguous/submitted obligations are scanned, never
 * a continuous scan of all 64 wallets.
 */
export function createMainnetReadOnlyFinancialRecovery({
    runtime,client=null,independentVerifier=null,logger=null,
    nowProvider=Date.now
}={}) {
    const chain=requireToncenterChainConfig("mainnet");
    if (runtime?.network!=="mainnet" || runtime.globalId!==chain.globalId
        || runtime.initialized!==true
        || runtime.outgoingRefundProvider!==null
        || runtime.getCapabilities?.().livePaymentAcceptanceEnabled!==false) {
        throw new Error("MAINNET_READ_ONLY_RUNTIME_REQUIRED");
    }
    const toncenter=client??new ToncenterTransactionsClient({baseUrl:chain.baseUrl});
    // Both the incoming and outgoing worker use precisely this one client
    // and this one chain identity. A Testnet endpoint is rejected here.
    const observer=new ToncenterTestnetOutgoingTransferProvider({
        client:toncenter,network:"mainnet",nowProvider
    });
    const independent=independentVerifier??new TonapiTestnetPayoutVerifier({
        network:"mainnet"
    });
    if (independent._network!=="mainnet"
        || typeof independent.verifyTransfer!=="function") {
        throw new Error("MAINNET_READ_ONLY_INDEPENDENT_VERIFIER_REQUIRED");
    }
    const incoming=new ToncenterIncomingProvider({
        client:toncenter,
        mapper:(payload,window)=>mapToncenterTransactionsResponse(payload,{
            ...window,network:"mainnet"
        })
    });
    const historicalIncoming=new HistoricalIncomingReceiptReconciler({
        runtime,incomingProvider:incoming,chainObserver:observer,
        independentVerifier:independent,nowProvider,network:"mainnet"
    });
    const pendingRefunds=new TestnetPendingRefundReconciler({
        refundStore:runtime.refundStore,intentStore:runtime.intentStore,
        receiptStore:runtime.receiptStore,
        toncenterObserver:observer,independentVerifier:independent,
        logger,maxPerPass:2,nowProvider,network:"mainnet"
    });
    return Object.freeze({
        historicalIncoming,pendingRefunds,
        // Read-only references are useful to verify shared identity in tests;
        // no secret or signer is returned.
        observer,independentVerifier:independent,
        incomingProvider:incoming
    });
}
