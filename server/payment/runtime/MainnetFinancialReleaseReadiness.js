import {resolve} from "node:path";

/**
 * Read-only Mainnet launch preflight for the EXISTING Testnet financial path.
 * Never creates a signer, opens payment acceptance or changes the Page5 gate.
 * Every dependency is server-owned; no client-provided readiness flag counts.
 */
const deny=reason=>Object.freeze({ready:false,reason});
export function assessMainnetFinancialReleaseReadiness({
    runtime,roomWalletAdapter,tonService,outgoingRefundProvider,
    payoutTransport,pendingRefundRecovery,pendingPayoutRecovery
}={}) {
    try {
        if (runtime?.network!=="mainnet" || runtime.globalId!==-239
            || runtime.initialized!==true)
            return deny("MAINNET_RUNTIME_NOT_INITIALIZED");
        if (runtime.walletPool?.network!=="mainnet"
            || runtime.ledger?.network!=="mainnet"
            || runtime.networkDataDir==null
            || !runtime.observationService)
            return deny("MAINNET_LEDGER_OR_INCOMING_UNAVAILABLE");
        const dir=runtime.networkDataDir;
        if (roomWalletAdapter?.supportsDurableTransferRetry?.()!==true
            || typeof roomWalletAdapter._sequenceStateDir!=="string"
            || resolve(roomWalletAdapter._sequenceStateDir)!==resolve(dir,"outbound-sequences"))
            return deny("MAINNET_SHARED_DURABLE_SEQNO_UNAVAILABLE");
        if (tonService?.network!=="mainnet" || tonService.globalId!==-239)
            return deny("MAINNET_NATIVE_RPC_IDENTITY_MISMATCH");

        const refund=outgoingRefundProvider;
        if (!refund || refund!==runtime.outgoingRefundProvider
            || refund.networkName!=="MAINNET" || refund.globalId!==-239
            || refund.canExecute?.()!==true
            || refund.canPrepareRefundTransfer?.()!==true)
            return deny("MAINNET_REFUND_EXECUTOR_UNAVAILABLE");
        if (runtime.refundLifecycle?._networkName!=="MAINNET"
            || runtime.refundLifecycle?._globalId!==-239
            || runtime.refundLifecycle?._outgoingProvider!==refund
            || runtime.refundLifecycle?._mainnetOutgoingEnabled!==true)
            return deny("MAINNET_REFUND_LIFECYCLE_NOT_AUTHORIZED");

        const payout=payoutTransport;
        if (payout?._network!=="mainnet" || payout._globalId!==-239
            || payout._pool!==runtime.walletPool
            || payout._ledger!==runtime.ledger
            || payout._adapter!==roomWalletAdapter
            || typeof payout.submit!=="function"
            || typeof payout.reconcileAndSettle!=="function")
            return deny("MAINNET_PAYOUT_EXECUTOR_UNAVAILABLE");
        const observer=payout._outgoingObserver;
        const independent=payout._independentVerifier;
        if (typeof observer?.verifyIndexedRecipientCredit!=="function"
            || typeof observer?.findOutgoingTransfer!=="function"
            || observer?._chain?.network!=="mainnet"
            || observer?._chain?.globalId!==-239
            || refund._observation!==observer
            || typeof independent?.verifyTransfer!=="function"
            || independent._network!=="mainnet")
            return deny("MAINNET_DUAL_FINALITY_UNAVAILABLE");
        if (pendingRefundRecovery?._identity?.network!=="mainnet"
            || pendingRefundRecovery._identity.globalId!==-239
            || pendingRefundRecovery._refunds!==runtime.refundStore
            || pendingRefundRecovery._chain!==observer
            || pendingRefundRecovery._independent!==independent
            || pendingPayoutRecovery?._identity?.network!=="mainnet"
            || pendingPayoutRecovery._identity.globalId!==-239
            || pendingPayoutRecovery._store!==runtime.ledgerStore
            || pendingPayoutRecovery._transport!==payout)
            return deny("MAINNET_DURABLE_RECOVERY_UNAVAILABLE");
        return Object.freeze({ready:true,reason:null});
    } catch {
        return deny("MAINNET_FINANCIAL_PREFLIGHT_UNAVAILABLE");
    }
}
