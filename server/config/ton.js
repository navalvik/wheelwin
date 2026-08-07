import { resolveGameEscrowMode } from "./gameEscrowMode.js";
import {
    loadTonNetworkProfiles,
    resolveActiveTonProfile
} from "./tonNetworkProfiles.js";

export function loadTonConfig(env = process.env) {

    const network = env.TON_NETWORK;

    if (!network) {

        throw new Error("TON_NETWORK environment variable is required");

    }

    const normalizedNetwork = String(network).trim().toLowerCase();
    const profiles = loadTonNetworkProfiles(env);
    const activeProfile = resolveActiveTonProfile(normalizedNetwork, env);

    const endpoint = typeof env.TON_ENDPOINT === "string"
        && env.TON_ENDPOINT.trim()
        ? env.TON_ENDPOINT.trim()
        : activeProfile.endpoint;

    const pollIntervalMs = env.TON_POLL_INTERVAL_MS === undefined
        ? 2000
        : Number(env.TON_POLL_INTERVAL_MS);

    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 200) {

        throw new Error("Invalid TON_POLL_INTERVAL_MS environment variable");

    }

    const requestedMode = String(env.TON_DEPLOY_MODE || "stub").trim().toLowerCase();

    const deployMode = requestedMode === "live" ? "live" : "stub";

    // Active network escrow mode (testnet default game; mainnet default v4).
    const gameEscrowMode = resolveGameEscrowMode(null, {
        ...env,
        TON_NETWORK: normalizedNetwork
    });

    // R7.67B / R7.68 — expected deployer pin (active network profile preferred).
    const deployerExpectedAddress = activeProfile.deployerExpectedAddress
        ?? (typeof env.TON_DEPLOYER_EXPECTED_ADDRESS === "string"
            && env.TON_DEPLOYER_EXPECTED_ADDRESS.trim()
            ? env.TON_DEPLOYER_EXPECTED_ADDRESS.trim()
            : null);

    return {
        network: normalizedNetwork,
        apiKey: env.TON_API_KEY || null,
        endpoint,
        deployerMnemonic: typeof env.TON_DEPLOYER_MNEMONIC === "string"
            && env.TON_DEPLOYER_MNEMONIC.trim()
            ? env.TON_DEPLOYER_MNEMONIC.trim()
            : null,
        deployerExpectedAddress,
        oracleAddress: activeProfile.oracleWallet,
        artifactSha256Expected: activeProfile.artifactSha256,
        profiles,
        grmJettonMaster: typeof env.TON_GRM_JETTON_MASTER === "string"
            && env.TON_GRM_JETTON_MASTER.trim()
            ? env.TON_GRM_JETTON_MASTER.trim()
            : null,
        pollIntervalMs,
        // live = TonGameContractAdapter; stub = offline adapter for CI without keys.
        deployMode,
        gameEscrowMode
    };

}
