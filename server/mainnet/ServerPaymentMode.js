import { createMainnetBootstrap } from "./MainnetBootstrap.js";

/** Resolve the server-owned payment mode; unsupported values fail closed. */
export function resolveServerPaymentMode(env = process.env) {
    const network = String(env.TON_NETWORK ?? "").trim().toLowerCase();
    if (network !== "testnet" && network !== "mainnet") {
        throw new Error("TON_NETWORK_MUST_BE_TESTNET_OR_MAINNET");
    }
    return network;
}

/** Initialize only the isolated Mainnet bootstrap selected by server config. */
export function initializeMainnetServerRuntime({ env = process.env, logger = null,
    createBootstrap = createMainnetBootstrap, fetchImpl = globalThis.fetch,
    nowProvider = Date.now } = {}) {
    const bootstrap = createBootstrap({ env, logger, fetchImpl, nowProvider });
    bootstrap.initialize();
    return bootstrap;
}
