/**
 * R6.1 — Application environment labels (blockchain / operations mode).
 */

export const APP_ENVIRONMENT = Object.freeze({
    DEVELOPMENT: "DEVELOPMENT",
    TESTNET: "TESTNET",
    MAINNET: "MAINNET"
});

const VALID = new Set(Object.values(APP_ENVIRONMENT));

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {"DEVELOPMENT"|"TESTNET"|"MAINNET"}
 */
export function resolveAppEnvironment(env = process.env) {

    const explicit = String(
        env.APP_ENVIRONMENT
        || env.BLOCKCHAIN_NETWORK
        || ""
    ).trim().toUpperCase();

    if (VALID.has(explicit)) {

        return explicit;

    }

    const nodeEnv = String(env.NODE_ENV || "development").trim().toLowerCase();

    if (nodeEnv === "development") {

        return APP_ENVIRONMENT.DEVELOPMENT;

    }

    const tonNetwork = String(env.TON_NETWORK || "testnet").trim().toLowerCase();

    return tonNetwork === "mainnet"
        ? APP_ENVIRONMENT.MAINNET
        : APP_ENVIRONMENT.TESTNET;

}

/**
 * @param {"DEVELOPMENT"|"TESTNET"|"MAINNET"} appEnvironment
 * @returns {"testnet"|"mainnet"}
 */
export function tonNetworkForAppEnvironment(appEnvironment) {

    if (appEnvironment === APP_ENVIRONMENT.MAINNET) {

        return "mainnet";

    }

    return "testnet";

}

export function isValidAppEnvironment(value) {

    return VALID.has(String(value || "").trim().toUpperCase());

}

export function normalizeAppEnvironment(value) {

    const normalized = String(value || "").trim().toUpperCase();

    return VALID.has(normalized) ? normalized : null;

}
