export function loadTonConfig(env = process.env) {

    const network = env.TON_NETWORK;

    if (!network) {

        throw new Error("TON_NETWORK environment variable is required");

    }

    return {
        network,
        apiKey: env.TON_API_KEY || null
    };

}
