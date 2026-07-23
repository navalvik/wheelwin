export function loadTonConfig(env = process.env) {

    const network = env.TON_NETWORK;

    if (!network) {

        throw new Error("TON_NETWORK environment variable is required");

    }

    const normalizedNetwork = String(network).trim().toLowerCase();

    const defaultEndpoint = normalizedNetwork === "mainnet"
        ? "https://toncenter.com/api/v2/jsonRPC"
        : "https://testnet.toncenter.com/api/v2/jsonRPC";

    const endpoint = typeof env.TON_ENDPOINT === "string"
        && env.TON_ENDPOINT.trim()
        ? env.TON_ENDPOINT.trim()
        : defaultEndpoint;

    const pollIntervalMs = env.TON_POLL_INTERVAL_MS === undefined
        ? 2000
        : Number(env.TON_POLL_INTERVAL_MS);

    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 200) {

        throw new Error("Invalid TON_POLL_INTERVAL_MS environment variable");

    }

    const requestedMode = String(env.TON_DEPLOY_MODE || "stub").trim().toLowerCase();

    const deployMode = requestedMode === "live" ? "live" : "stub";

    return {
        network: normalizedNetwork,
        apiKey: env.TON_API_KEY || null,
        endpoint,
        deployerMnemonic: typeof env.TON_DEPLOYER_MNEMONIC === "string"
            && env.TON_DEPLOYER_MNEMONIC.trim()
            ? env.TON_DEPLOYER_MNEMONIC.trim()
            : null,
        grmJettonMaster: typeof env.TON_GRM_JETTON_MASTER === "string"
            && env.TON_GRM_JETTON_MASTER.trim()
            ? env.TON_GRM_JETTON_MASTER.trim()
            : null,
        pollIntervalMs,
        // live = TonGameContractAdapter; stub = offline adapter for CI without keys.
        deployMode
    };

}
