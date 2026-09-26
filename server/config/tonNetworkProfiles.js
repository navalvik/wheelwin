/**
 * Separate Testnet / Mainnet TON network profiles for the active Room Wallet
 * payment architecture. Network endpoints, deploy-wallet identity and oracle
 */

import {
    DEPLOYER_WALLET_CONTRACT_TYPE,
    DEPLOYER_WALLET_WORKCHAIN
} from "../payment/ton/deriveDeployerWalletIdentity.js";

const DEFAULT_TESTNET_ENDPOINT = "https://testnet.toncenter.com/api/v2/jsonRPC";
const DEFAULT_MAINNET_ENDPOINT = "https://toncenter.com/api/v2/jsonRPC";

const EXPLICIT_DEPLOY_WALLET = Object.freeze({
    type: DEPLOYER_WALLET_CONTRACT_TYPE,
    workchain: DEPLOYER_WALLET_WORKCHAIN
});

function trimOrNull(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

export function resolveOracleWalletConfig(network, env = process.env) {
    const normalized = String(network ?? "").trim().toLowerCase();

    if (normalized === "mainnet") {
        const address = trimOrNull(env.TON_MAINNET_ORACLE_ADDRESS);
        return Object.freeze({
            address,
            source: address ? "TON_MAINNET_ORACLE_ADDRESS" : null,
            configured: Boolean(address)
        });
    }

    const dedicated = trimOrNull(env.TON_TESTNET_ORACLE_ADDRESS);
    if (dedicated) {
        return Object.freeze({
            address: dedicated,
            source: "TON_TESTNET_ORACLE_ADDRESS",
            configured: true
        });
    }

    const shared = trimOrNull(env.TON_ORACLE_ADDRESS);
    return Object.freeze({
        address: shared,
        source: shared ? "TON_ORACLE_ADDRESS" : null,
        configured: Boolean(shared)
    });
}

function freezeTonNetworkProfile(network, fields) {
    return Object.freeze({
        network,
        endpoint: fields.endpoint,
        deployWallet: EXPLICIT_DEPLOY_WALLET,
        oracleWallet: fields.oracleWallet,
        oracleSource: fields.oracleSource ?? null,
        deployerExpectedAddress: fields.deployerExpectedAddress,
        expectedWalletAddress: fields.deployerExpectedAddress
    });
}

export function loadTestnetTonProfile(env = process.env) {
    const endpoint = trimOrNull(env.TON_TESTNET_ENDPOINT)
        || trimOrNull(env.TON_ENDPOINT)
        || DEFAULT_TESTNET_ENDPOINT;
    const oracle = resolveOracleWalletConfig("testnet", env);

    return freezeTonNetworkProfile("testnet", {
        endpoint,
        oracleWallet: oracle.address,
        oracleSource: oracle.source,
        deployerExpectedAddress:
            trimOrNull(env.TON_TESTNET_DEPLOYER_EXPECTED_ADDRESS)
            || trimOrNull(env.TON_DEPLOYER_EXPECTED_ADDRESS)
    });
}

export function loadMainnetTonProfile(env = process.env) {
    const endpoint = trimOrNull(env.TON_MAINNET_ENDPOINT)
        || DEFAULT_MAINNET_ENDPOINT;
    const oracle = resolveOracleWalletConfig("mainnet", env);

    return freezeTonNetworkProfile("mainnet", {
        endpoint,
        oracleWallet: oracle.address,
        oracleSource: oracle.source,
        deployerExpectedAddress:
            trimOrNull(env.TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS)
    });
}

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
        failures.push(`Deploy wallet type must be ${DEPLOYER_WALLET_CONTRACT_TYPE}`);
    }
    if (profile?.deployWallet?.workchain !== DEPLOYER_WALLET_WORKCHAIN) {
        failures.push(`Deploy wallet workchain must be ${DEPLOYER_WALLET_WORKCHAIN}`);
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

    if (failures.length > 0) {
        throw new Error(
            `TON ${network ?? "unknown"} profile incomplete: ${failures.join("; ")}`
        );
    }
    return profile;
}

export function loadTonNetworkProfiles(env = process.env) {
    return Object.freeze({
        testnet: loadTestnetTonProfile(env),
        mainnet: loadMainnetTonProfile(env)
    });
}

export function resolveActiveTonProfile(network, env = process.env) {
    const normalized = String(network ?? "").trim().toLowerCase();
    const profiles = loadTonNetworkProfiles(env);

    if (normalized === "mainnet") return profiles.mainnet;
    if (normalized === "testnet") return profiles.testnet;

    const deployerExpectedAddress = trimOrNull(env.TON_DEPLOYER_EXPECTED_ADDRESS);
    return Object.freeze({
        network: normalized || null,
        endpoint: trimOrNull(env.TON_ENDPOINT) || DEFAULT_TESTNET_ENDPOINT,
        deployWallet: EXPLICIT_DEPLOY_WALLET,
        oracleWallet: trimOrNull(env.TON_ORACLE_ADDRESS),
        oracleSource: trimOrNull(env.TON_ORACLE_ADDRESS) ? "TON_ORACLE_ADDRESS" : null,
        deployerExpectedAddress,
        expectedWalletAddress: deployerExpectedAddress
    });
}
