import { join } from "node:path";
import { loadMainnetRuntimeConfig } from "./config/MainnetRuntimeConfig.js";
import { MainnetPaymentRuntime } from "./payment/MainnetPaymentRuntime.js";
import { MainnetWalletPoolRegistry } from "./wallet/MainnetWalletPoolRegistry.js";

/** Mainnet-only configuration, wallet pool and payment runtime bootstrap. */
export function createMainnetBootstrap({ env = process.env, logger = null,
    fetchImpl = globalThis.fetch, nowProvider = Date.now } = {}) {
    const config = loadMainnetRuntimeConfig(env);
    const walletPool = new MainnetWalletPoolRegistry({ config, logger });
    let paymentRuntime = null;
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
        get paymentRuntime() { return paymentRuntime; },
        initialize() {
            if (initialized) return walletPool;
            walletPool.initialize({ snapshotDir: join(config.dataDir, "wallet-registry") });
            paymentRuntime = new MainnetPaymentRuntime({ config, fetchImpl, nowProvider }).initialize();
            initialized = true;
            return walletPool;
        }
    });
}
