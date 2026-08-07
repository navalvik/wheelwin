/**
 * R7.68 / R8.1A — Separated Testnet / Mainnet TON configuration profiles.
 * No wallet addresses or artifact hashes hardcoded — all from env / artifact meta.
 * Each profile explicitly defines network, endpoint, deploy wallet, expected address,
 * escrow mode, and artifact reference (no ambiguous inheritance between networks).
 */

import {
    assertValidGameEscrowMode,
    defaultGameEscrowModeForNetwork,
    resolveGameEscrowMode
} from "./gameEscrowMode.js";
import {
    DEPLOYER_WALLET_CONTRACT_TYPE,
    DEPLOYER_WALLET_WORKCHAIN
} from "../payment/ton/deriveDeployerWalletIdentity.js";
import {
    GAME_ESCROW_ARTIFACT_BOC_PATH
} from "../payment/ton/verifyGameEscrowArtifact.js";

const DEFAULT_TESTNET_ENDPOINT = "https://testnet.toncenter.com/api/v2/jsonRPC";
const DEFAULT_MAINNET_ENDPOINT = "https://toncenter.com/api/v2/jsonRPC";

/** Explicit deploy-wallet identity shared by both profiles (WalletContractV4R2). */
const EXPLICIT_DEPLOY_WALLET = Object.freeze({
    type: DEPLOYER_WALLET_CONTRACT_TYPE,
    workchain: DEPLOYER_WALLET_WORKCHAIN
});

function trimOrNull(value) {

    if (typeof value !== "string") {

        return null;

    }

    const trimmed = value.trim();

    return trimmed ? trimmed : null;

}

/**
 * @param {"testnet"|"mainnet"} network
 * @param {{
 *   endpoint: string,
 *   oracleWallet: string|null,
 *   deployerExpectedAddress: string|null,
 *   gameEscrowMode: "v4"|"game",
 *   artifactSha256: string|null
 * }} fields
 */
function freezeTonNetworkProfile(network, fields) {

    return Object.freeze({
        network,
        endpoint: fields.endpoint,
        deployWallet: EXPLICIT_DEPLOY_WALLET,
        oracleWallet: fields.oracleWallet,
        deployerExpectedAddress: fields.deployerExpectedAddress,
        expectedWalletAddress: fields.deployerExpectedAddress,
        gameEscrowMode: fields.gameEscrowMode,
        escrowMode: fields.gameEscrowMode,
        artifactSha256: fields.artifactSha256,
        artifact: Object.freeze({
            bocPath: GAME_ESCROW_ARTIFACT_BOC_PATH,
            sha256Expected: fields.artifactSha256
        })
    });

}

/**
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} env
 * @returns {ReturnType<typeof freezeTonNetworkProfile>}
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

    return freezeTonNetworkProfile("testnet", {
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
 * Mainnet profile for readiness / dry-run / future launch.
 * Escrow mode defaults to v4 — R8.1A does NOT enable GameEscrow on mainnet.
 *
 * Mainnet fields use dedicated TON_MAINNET_* keys only (no cross-network fallback).
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

    return freezeTonNetworkProfile("mainnet", {
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
 * Structural completeness check for a loaded profile (dry-run / startup).
 * Does not enable Mainnet gameplay. Throws on incomplete/ambiguous profiles.
 *
 * @param {object} profile
 * @param {{ requireOracle?: boolean, requireExpectedAddress?: boolean, requireArtifactSha?: boolean }} [options]
 */
export function assertTonNetworkProfileComplete(profile, options = {}) {

    const failures = [];
    const network = profile?.network;

    if (network !== "testnet" && network !== "mainnet") {

        failures.push(`Invalid network value: ${network ?? "<missing>"}`);

    }

    if (!profile?.endpoint || typeof profile.endpoint !== "string") {

        failures.push("TON endpoint is not configured");

    }

    if (!profile?.deployWallet?.type) {

        failures.push("Deploy wallet type is not configured");

    } else if (profile.deployWallet.type !== DEPLOYER_WALLET_CONTRACT_TYPE) {

        failures.push(
            `Deploy wallet type must be ${DEPLOYER_WALLET_CONTRACT_TYPE}`
        );

    }

    if (
        profile?.deployWallet?.workchain !== DEPLOYER_WALLET_WORKCHAIN
    ) {

        failures.push(
            `Deploy wallet workchain must be ${DEPLOYER_WALLET_WORKCHAIN}`
        );

    }

    try {

        assertValidGameEscrowMode(profile?.gameEscrowMode ?? profile?.escrowMode);

    } catch (error) {

        failures.push(error?.message ?? "Invalid escrow mode");

    }

    if (!profile?.artifact?.bocPath) {

        failures.push("Artifact reference (bocPath) is missing");

    }

    if (options.requireOracle === true && !profile?.oracleWallet) {

        failures.push("Oracle wallet is not configured");

    }

    if (
        options.requireExpectedAddress === true
        && !(profile?.deployerExpectedAddress || profile?.expectedWalletAddress)
    ) {

        failures.push("Expected deployer wallet address is not configured");

    }

    if (
        options.requireArtifactSha === true
        && !(profile?.artifactSha256 || profile?.artifact?.sha256Expected)
    ) {

        failures.push("Artifact SHA256 reference is not configured");

    }

    if (failures.length > 0) {

        throw new Error(
            `TON ${network ?? "unknown"} profile incomplete: ${failures.join("; ")}`
        );

    }

    return profile;

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

    const deployerExpectedAddress = trimOrNull(env.TON_DEPLOYER_EXPECTED_ADDRESS);
    const artifactSha256 = trimOrNull(env.TON_GAME_ESCROW_ARTIFACT_SHA256);
    const gameEscrowMode = resolveGameEscrowMode(null, {
        ...env,
        TON_NETWORK: normalized
    });

    return Object.freeze({
        network: normalized || null,
        endpoint: trimOrNull(env.TON_ENDPOINT) || DEFAULT_TESTNET_ENDPOINT,
        deployWallet: EXPLICIT_DEPLOY_WALLET,
        oracleWallet: trimOrNull(env.TON_ORACLE_ADDRESS)
            || trimOrNull(env.GAME_ESCROW_ORACLE),
        deployerExpectedAddress,
        expectedWalletAddress: deployerExpectedAddress,
        gameEscrowMode,
        escrowMode: gameEscrowMode,
        artifactSha256,
        artifact: Object.freeze({
            bocPath: GAME_ESCROW_ARTIFACT_BOC_PATH,
            sha256Expected: artifactSha256
        })
    });

}
