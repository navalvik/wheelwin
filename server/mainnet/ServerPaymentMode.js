import { createMainnetBootstrap } from "./MainnetBootstrap.js";

/** Resolve the server-owned payment mode; unsupported values fail closed. */
export function resolveServerPaymentMode(env = process.env) {
    const network = String(env.TON_NETWORK ?? "").trim().toLowerCase();
    if (network !== "testnet" && network !== "mainnet") {
        throw new Error("TON_NETWORK_MUST_BE_TESTNET_OR_MAINNET");
    }
    return network;
}

/** Format startup diagnostics from the initialized Mainnet runtime state. */
export function formatMainnetRuntimeStartupLine({ config, paymentRuntime,
    liveOperationsEnabled = null } = {}) {
    const liveEnabled = typeof liveOperationsEnabled === "boolean"
        ? liveOperationsEnabled
        : typeof paymentRuntime?.liveOperationsEnabled === "boolean"
            ? paymentRuntime.liveOperationsEnabled
            : paymentRuntime?.getCapabilities?.().livePaymentAcceptanceEnabled === true;
    if (typeof liveEnabled !== "boolean") {
        throw new Error("MAINNET_PAYMENT_RUNTIME_STATE_INVALID");
    }
    const paidGameStartEnabled = liveEnabled
        && typeof paymentRuntime?.paymentGate?.getGameStartGateStatus === "function";
    return `MainnetPaymentRuntime (globalId=${config?.globalId}`
        + ` | wallets=${config?.walletCount}`
        + ` | storage=isolated | liveOperations=${liveEnabled ? "enabled" : "disabled"}`
        + ` | paidGameStart=${paidGameStartEnabled ? "enabled (3/3 gated)" : "disabled"})`;
}

/** Initialize only the isolated Mainnet bootstrap selected by server config. */
export function initializeMainnetServerRuntime({ env = process.env, logger = null,
    createBootstrap = createMainnetBootstrap, fetchImpl = globalThis.fetch,
    nowProvider = Date.now, initializeOptions = {} } = {}) {
    const bootstrap = createBootstrap({ env, logger, fetchImpl, nowProvider });
    bootstrap.initialize(initializeOptions);
    return bootstrap;
}
