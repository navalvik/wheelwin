/**
 * R7.68 — Separated Testnet / Mainnet TON configuration profiles.
 * No wallet addresses or artifact hashes hardcoded — all from env / artifact meta.
 */

import {
    assertValidGameEscrowMode,
    defaultGameEscrowModeForNetwork,
    resolveGameEscrowMode
} from "./gameEscrowMode.js";

const DEFAULT_TESTNET_ENDPOINT = "https://testnet.toncenter.com/api/v2/jsonRPC";
const DEFAULT_MAINNET_ENDPOINT = "https://toncenter.com/api/v2/jsonRPC";

function trimOrNull(value) {

    if (typeof value !== "string") {

        return null;

    }

    const trimmed = value.trim();

    return trimmed ? trimmed : null;

}

/**
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} env
 * @returns {{
 *   network: "testnet",
 *   endpoint: string,
 *   oracleWallet: string|null,
 *   deployerExpectedAddress: string|null,
 *   gameEscrowMode: "v4"|"game",
 *   artifactSha256: string|null
 * }}
 */
export function loadTestnetTonProfile(env = process.env) {

    const endpoint = trimOrNull(env.TON_TESTNET_ENDPOINT)
        || trimOrNull(env.TON_ENDPOINT)
        || DEFAULT_TESTNET_ENDPOINT;

    const resolveEnv = {
        ...env,
        TON_NETWORK: "testnet"
    };

    const testnetModeOverride = trimOrNull(env.TON_TESTNET_GAME_ESCROW_MODE);

    if (testnetModeOverride) {

        resolveEnv.GAME_ESCROW_MODE = testnetModeOverride;

    }

    const gameEscrowMode = resolveGameEscrowMode(null, resolveEnv);

    return Object.freeze({
        network: "testnet",
        endpoint,
        oracleWallet: trimOrNull(env.TON_TESTNET_ORACLE_ADDRESS)
            || trimOrNull(env.TON_ORACLE_ADDRESS)
            || trimOrNull(env.GAME_ESCROW_ORACLE),
        deployerExpectedAddress: trimOrNull(env.TON_TESTNET_DEPLOYER_EXPECTED_ADDRESS)
            || trimOrNull(env.TON_DEPLOYER_EXPECTED_ADDRESS),
        gameEscrowMode,
        artifactSha256: trimOrNull(env.TON_GAME_ESCROW_ARTIFACT_SHA256)
    });

}

/**
 * Mainnet profile for readiness / future launch.
 * Escrow mode defaults to v4 — R7.68 does NOT enable GameEscrow on mainnet.
 *
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} env
 */
export function loadMainnetTonProfile(env = process.env) {

    const endpoint = trimOrNull(env.TON_MAINNET_ENDPOINT)
        || DEFAULT_MAINNET_ENDPOINT;

    const modeRaw = trimOrNull(env.TON_MAINNET_GAME_ESCROW_MODE);
    const gameEscrowMode = modeRaw
        ? assertValidGameEscrowMode(modeRaw)
        : defaultGameEscrowModeForNetwork("mainnet");

    return Object.freeze({
        network: "mainnet",
        endpoint,
        oracleWallet: trimOrNull(env.TON_MAINNET_ORACLE_ADDRESS),
        deployerExpectedAddress: trimOrNull(
            env.TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS
        ),
        gameEscrowMode,
        artifactSha256: trimOrNull(env.TON_GAME_ESCROW_ARTIFACT_SHA256)
    });

}

/**
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} env
 */
export function loadTonNetworkProfiles(env = process.env) {

    return Object.freeze({
        testnet: loadTestnetTonProfile(env),
        mainnet: loadMainnetTonProfile(env)
    });

}

/**
 * Active-network fields merged into loadTonConfig().
 *
 * @param {"testnet"|"mainnet"|string} network
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} env
 */
export function resolveActiveTonProfile(network, env = process.env) {

    const normalized = String(network ?? "").trim().toLowerCase();
    const profiles = loadTonNetworkProfiles(env);

    if (normalized === "mainnet") {

        return profiles.mainnet;

    }

    if (normalized === "testnet") {

        return profiles.testnet;

    }

    return Object.freeze({
        network: normalized || null,
        endpoint: trimOrNull(env.TON_ENDPOINT) || DEFAULT_TESTNET_ENDPOINT,
        oracleWallet: trimOrNull(env.TON_ORACLE_ADDRESS)
            || trimOrNull(env.GAME_ESCROW_ORACLE),
        deployerExpectedAddress: trimOrNull(env.TON_DEPLOYER_EXPECTED_ADDRESS),
        gameEscrowMode: resolveGameEscrowMode(null, {
            ...env,
            TON_NETWORK: normalized
        }),
        artifactSha256: trimOrNull(env.TON_GAME_ESCROW_ARTIFACT_SHA256)
    });

}
