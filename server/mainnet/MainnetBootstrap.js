import { join } from "node:path";
import { loadMainnetRuntimeConfig } from "./config/MainnetRuntimeConfig.js";
import { MainnetWalletPoolRegistry } from "./wallet/MainnetWalletPoolRegistry.js";
import { buildPaymentRuntime } from "./testnet_source/payment/runtime/PaymentRuntimeFactory.js";
import { createMainnetWalletV4Transport } from "./payment/MainnetWalletV4Transport.js";
import { createMainnetNativeRefundCapabilities } from "./testnet_source/payment/roomWallet/TestnetNativeRefundCapabilities.js";
import { ToncenterTransactionsClient } from "./testnet_source/payment/toncenter/ToncenterTransactionsClient.js";
import { ToncenterMainnetOutgoingTransferProvider } from "./testnet_source/payment/refund/ToncenterTestnetOutgoingTransferProvider.js";
import { TonapiMainnetPayoutVerifier } from "./testnet_source/payment/refund/TonapiTestnetPayoutVerifier.js";

/** Mainnet-only configuration and the copied Testnet financial runtime. */
export function createMainnetBootstrap({ env = process.env, logger = null,
    fetchImpl = globalThis.fetch, walletV4Client = null, nowProvider = Date.now } = {}) {
    const config = loadMainnetRuntimeConfig(env);
    const walletPool = new MainnetWalletPoolRegistry({ config, logger });
    const client = new ToncenterTransactionsClient({
        baseUrl: config.toncenterBaseUrl,
        apiKeyProvider: config.apiKeyProvider,
        fetchImpl
    });
    const outgoingObserver = new ToncenterMainnetOutgoingTransferProvider({ client, nowProvider });
    const independentVerifier = new TonapiMainnetPayoutVerifier({ fetchImpl, nowProvider });
    const liveOperationsEnabled = String(env.TON_NETWORK ?? "").trim().toLowerCase() === "mainnet"
        && env.ROOM_WALLET_PAYMENTS_ENABLED === "true"
        && String(env.ROOM_WALLET_PAYMENT_INTAKE_MODE ?? "").trim().toUpperCase() !== "DISABLED";
    let walletV4Transport = null;
    let paymentRuntime = null;
    let recovery = null;
    let initialized = false;
    return Object.freeze({
        config: Object.freeze({
            network: config.network,
            globalId: config.globalId,
            toncenterBaseUrl: config.toncenterBaseUrl,
            dataDir: config.dataDir,
            walletCount: config.walletCatalog.length
        }),
        walletPool,
        client,
        outgoingObserver,
        independentVerifier,
        get walletV4Transport() { return walletV4Transport; },
        get paymentRuntime() { return paymentRuntime; },
        get recovery() { return recovery; },
        get liveOperationsEnabled() { return liveOperationsEnabled; },
        initialize() {
            if (initialized) return walletPool;
            paymentRuntime = buildPaymentRuntime({
                dataDir: config.dataDir,
                network: config.network,
                walletPool,
                logger,
                nowProvider,
                fetchImpl,
                apiKeyProvider: config.apiKeyProvider,
                refundSubmitterFactory: liveOperationsEnabled
                    ? ({ walletPool: activeWalletPool, networkDataDir }) => {
                        walletV4Transport = createMainnetWalletV4Transport({
                            config, env, client: walletV4Client, logger
                        });
                        return Object.freeze({
                            ...createMainnetNativeRefundCapabilities({
                                walletPool: activeWalletPool,
                                roomWalletAdapter: walletV4Transport,
                                dataDir: networkDataDir
                            }),
                            outgoingTransferProvider: outgoingObserver
                        });
                    }
                    : null
            });
            recovery = paymentRuntime.initialize();
            initialized = true;
            return walletPool;
        }
    });
}
