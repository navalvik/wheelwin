import {join} from "node:path";
import {tonAddressIdentitiesEqual} from "../incoming/TonAddressIdentity.js";
import {requireToncenterChainConfig} from "../toncenter/ToncenterConstants.js";
import {ToncenterTransactionsClient} from "../toncenter/ToncenterTransactionsClient.js";
import {ToncenterIndexedFinalityEvidenceProvider} from "../toncenter/ToncenterIndexedFinalityEvidenceProvider.js";
import {ToncenterIncomingProvider} from "../toncenter/ToncenterIncomingProvider.js";
import {mapToncenterTransactionsResponse} from "../toncenter/ToncenterTransactionsMapper.js";
import {ToncenterTestnetOutgoingTransferProvider} from "../refund/ToncenterTestnetOutgoingTransferProvider.js";
import {TonapiTestnetPayoutVerifier} from "../refund/TonapiTestnetPayoutVerifier.js";
import {createRoomWalletRuntimeResolver} from "../roomWallet/RoomWalletRuntimeResolver.js";
import {TestnetNativeTonService} from "../roomWallet/TestnetNativeTonService.js";
import {RoomWalletAdapter} from "../roomWallet/RoomWalletAdapter.js";
import {createTestnetNativeRefundCapabilities} from "../roomWallet/TestnetNativeRefundCapabilities.js";
import {TestnetNativeRoomPayoutTransport} from "./TestnetNativeRoomPayoutTransport.js";
import {TestnetPendingRefundReconciler} from "./TestnetPendingRefundReconciler.js";
import {TestnetPendingPayoutReconciler} from "./TestnetPendingPayoutReconciler.js";
import {HistoricalIncomingReceiptReconciler} from "./HistoricalIncomingReceiptReconciler.js";

/**
 * Server-only dependency assembly using exactly the existing Testnet Wallet V4
 * and recovery classes. No new transfer, payout or settlement engine.
 *
 * IMPORTANT: constructing this object alone does not enable acceptance.
 * The app must separately pass TWO explicit Mainnet launch switches through
 * selectAppPaymentRuntimeBuilder. The default app startup never calls this.
 * Test factories are dependency-injection hooks, not environment switches.
 */
export function createMainnetNativeFinancialRelease({
    env=process.env,logger=null,nowProvider=Date.now,
    walletResolverFactory=()=>createRoomWalletRuntimeResolver({env}),
    tonServiceFactory=()=>new TestnetNativeTonService({
        network:"mainnet",apiKey:env.TON_API_KEY
    }),
    clientFactory=()=>new ToncenterTransactionsClient({
        baseUrl:"https://toncenter.com",apiKeyProvider:()=>env.TON_API_KEY
    }),
    independentVerifierFactory=()=>new TonapiTestnetPayoutVerifier({
        network:"mainnet",apiKeyProvider:()=>env.TONAPI_API_KEY
    })
}={}) {
    const chain=requireToncenterChainConfig("mainnet");
    let prepared=null,deps=null,signingCatalogValidated=false;
    const createRefundSubmitter=({walletPool,networkDataDir,network,globalId})=>{
        if (prepared || network!==chain.network || globalId!==chain.globalId
            || walletPool?.network!=="mainnet" || !networkDataDir)
            throw new Error("MAINNET_RELEASE_IDENTITY_OR_DUPLICATE_MISMATCH");
        const walletResolver=walletResolverFactory();
        const tonService=tonServiceFactory();
        if (typeof walletResolver!=="function"
            ||tonService?.network!=="mainnet" ||tonService?.globalId!==-239)
            throw new Error("MAINNET_RELEASE_NATIVE_RPC_UNAVAILABLE");
        const roomWalletAdapter=new RoomWalletAdapter({
            sequenceStateDir:join(networkDataDir,"outbound-sequences"),
            walletResolver,tonService,logger,gasReserveNano:10_000_000n
        });
        const client=clientFactory();
        const observer=new ToncenterTestnetOutgoingTransferProvider({
            client,network:"mainnet",nowProvider
        });
        const independentVerifier=independentVerifierFactory();
        if(independentVerifier?._network!=="mainnet"
            ||typeof independentVerifier.verifyTransfer!=="function")
            throw new Error("MAINNET_RELEASE_INDEPENDENT_VERIFIER_UNAVAILABLE");
        const incomingProvider=new ToncenterIncomingProvider({
            client,mapper:(payload,window)=>mapToncenterTransactionsResponse(payload,{
                ...window,network:"mainnet"
            })
        });
        const indexedFinality=new ToncenterIndexedFinalityEvidenceProvider({
            client,network:"mainnet",nowProvider
        });
        const refundCapabilities=createTestnetNativeRefundCapabilities({
            walletPool,roomWalletAdapter,dataDir:networkDataDir,network:"mainnet"
        });
        prepared=Object.freeze({walletPool,networkDataDir,tonService,
            roomWalletAdapter,observer,independentVerifier,incomingProvider,
            indexedFinality});
        return Object.freeze({
            ...refundCapabilities,
            outgoingTransferProvider:observer,
            finalityEvidenceProvider:indexedFinality
        });
    };
    // Validate ALL 64 existing public pool addresses against the loaded native
    // wallet resolver, not just the address of the first assigned room.
    // Without this check a stale/private-key catalog could sign from a
    // DIFFERENT source wallet while the ledger expects the public pool slot.
    // The check is read-only, never fetches the chain or exposes secrets.
    const validateSigningCatalog=async runtime=>{
        if(!prepared || runtime?.network!=="mainnet"
            || runtime.globalId!==-239 ||runtime.initialized!==true
            ||runtime.walletPool!==prepared.walletPool
            ||runtime.networkDataDir!==prepared.networkDataDir)
            throw new Error("MAINNET_SIGNING_CATALOG_RUNTIME_MISMATCH");
        signingCatalogValidated=false;
        const pool=runtime.walletPool;
        for(let roomNumber=1;roomNumber<=64;roomNumber++){
            const expected=pool.getWalletByRoomNumber(roomNumber);
            const actual=await prepared.roomWalletAdapter._walletResolver(roomNumber);
            if(!expected || !actual ||actual.roomNumber!==roomNumber
                ||(actual.network!=null && actual.network!=="mainnet")
                ||!tonAddressIdentitiesEqual(expected.address,actual.address))
                throw new Error("MAINNET_SIGNING_CATALOG_ADDRESS_MISMATCH");
        }
        signingCatalogValidated=true;
        return true;
    };
    const resolveDependencies=runtime=>{
        if(!prepared ||!signingCatalogValidated
            ||runtime?.network!=="mainnet" ||runtime.globalId!==-239
            ||runtime.walletPool!==prepared.walletPool
            ||runtime.networkDataDir!==prepared.networkDataDir
            ||runtime.initialized!==true)
            throw new Error("MAINNET_RELEASE_RUNTIME_NOT_INITIALIZED");
        if(deps)return deps;
        const {roomWalletAdapter,tonService,observer,independentVerifier,
            incomingProvider}=prepared;
        const payoutTransport=new TestnetNativeRoomPayoutTransport({
            walletPool:runtime.walletPool,adapter:roomWalletAdapter,
            dataDir:runtime.networkDataDir,logger,ledger:runtime.ledger,
            outgoingObserver:observer,independentVerifier,network:"mainnet"
        });
        const pendingRefundRecovery=new TestnetPendingRefundReconciler({
            refundStore:runtime.refundStore,receiptStore:runtime.receiptStore,
            intentStore:runtime.intentStore,toncenterObserver:observer,
            independentVerifier,maxPerPass:2,logger,network:"mainnet",nowProvider
        });
        const pendingPayoutRecovery=new TestnetPendingPayoutReconciler({
            ledgerStore:runtime.ledgerStore,ledger:runtime.ledger,
            walletPool:runtime.walletPool,transport:payoutTransport,
            maxPerPass:2,logger,network:"mainnet"
        });
        const historicalIncoming=new HistoricalIncomingReceiptReconciler({
            runtime,incomingProvider,chainObserver:observer,
            independentVerifier,network:"mainnet",nowProvider
        });
        deps=Object.freeze({
            roomWalletAdapter,tonService,
            outgoingObserver:observer,independentVerifier,
            payoutTransport,pendingRefundRecovery,pendingPayoutRecovery,
            historicalIncoming
        });
        return deps;
    };
    return Object.freeze({createRefundSubmitter,validateSigningCatalog,resolveDependencies});
}
