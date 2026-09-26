import { printDeployBlock } from "./DeployPipelineForensics.js";
import { isValidTonAddress, tonAddressesEqual } from "./TonWalletIdentityDebug.js";
import {
    DEPLOYER_WALLET_CONTRACT_TYPE,
    DEPLOYER_WALLET_WORKCHAIN
} from "../payment/ton/deriveDeployerWalletIdentity.js";
import { loadMainnetTonProfile } from "../config/tonNetworkProfiles.js";

let _tonMainnetReadiness = null;

export function isTonMainnetDryRunDebugEnabled(raw = process.env.TON_MAINNET_DRY_RUN_DEBUG) {
    const normalized = String(raw ?? "").trim().toLowerCase();
    return ["1", "true", "yes", "on"].includes(normalized);
}

export function setTonMainnetReadiness(fields = {}) {
    const validationTimestamp = fields.validationTimestamp ?? fields.timestamp ?? Date.now();
    _tonMainnetReadiness = {
        status: fields.status ?? "UNKNOWN",
        network: fields.network ?? null,
        activeNetwork: fields.activeNetwork ?? null,
        walletType: fields.walletType ?? null,
        workchain: fields.workchain ?? null,
        walletId: fields.walletId ?? null,
        walletAddress: fields.walletAddress ?? null,
        expectedAddress: fields.expectedAddress ?? null,
        identityMatch: fields.identityMatch ?? null,
        balanceTon: fields.balanceTon ?? null,
        balanceNano: fields.balanceNano ?? null,
        balanceAvailable: fields.balanceAvailable ?? null,
        seqno: fields.seqno ?? null,
        oracleAddress: fields.oracleAddress ?? null,
        endpoint: fields.endpoint ?? null,
        checks: fields.checks ?? null,
        reasons: Array.isArray(fields.reasons) ? [...fields.reasons] : [],
        validationTimestamp,
        timestamp: validationTimestamp
    };
    return getTonMainnetReadiness();
}

export function getTonMainnetReadiness() {
    if (!_tonMainnetReadiness) return null;
    return Object.freeze({
        ..._tonMainnetReadiness,
        reasons: Object.freeze([..._tonMainnetReadiness.reasons]),
        checks: _tonMainnetReadiness.checks
            ? Object.freeze({ ..._tonMainnetReadiness.checks }) : null
    });
}

export function printTonMainnetReadiness(fields = null) {
    const snapshot = fields ? Object.freeze({ ...fields }) : getTonMainnetReadiness();
    if (!snapshot) return;
    printDeployBlock("TON_MAINNET_READINESS", {
        status: snapshot.status,
        network: snapshot.network,
        activeNetwork: snapshot.activeNetwork,
        walletType: snapshot.walletType,
        workchain: snapshot.workchain,
        walletId: snapshot.walletId,
        walletAddress: snapshot.walletAddress,
        expectedAddress: snapshot.expectedAddress,
        identityMatch: snapshot.identityMatch,
        balanceTon: snapshot.balanceTon,
        balanceNano: snapshot.balanceNano,
        balanceAvailable: snapshot.balanceAvailable,
        seqno: snapshot.seqno,
        oracleAddress: snapshot.oracleAddress,
        endpoint: snapshot.endpoint,
        checks: snapshot.checks,
        reasons: snapshot.reasons,
        validationTimestamp: snapshot.validationTimestamp ?? snapshot.timestamp
    });
}

export function printTonMainnetDryRunDebug(fields = null, env = process.env) {
    if (!isTonMainnetDryRunDebugEnabled(env.TON_MAINNET_DRY_RUN_DEBUG)) return;
    const snapshot = fields ? Object.freeze({ ...fields }) : getTonMainnetReadiness();
    if (!snapshot) return;
    printDeployBlock("TON_MAINNET_DRY_RUN_DEBUG", {
        network: snapshot.network,
        walletType: snapshot.walletType,
        walletAddress: snapshot.walletAddress,
        expectedAddress: snapshot.expectedAddress,
        walletBalance: snapshot.balanceTon,
        validationTimestamp: snapshot.validationTimestamp ?? snapshot.timestamp,
        status: snapshot.status,
        checks: snapshot.checks,
        reasons: snapshot.reasons
    });
}

export function resetTonMainnetReadinessForTests() {
    _tonMainnetReadiness = null;
}

function checkStatus(pass, skip = false) {
    if (skip) return "SKIP";
    return pass ? "PASS" : "FAIL";
}

export function evaluateMainnetReadiness(input = {}) {
    const env = input.env ?? process.env;
    const profile = loadMainnetTonProfile(env);
    const reasons = [];
    const endpointOk = Boolean(profile.endpoint);
    const expectedAddress = profile.deployerExpectedAddress ?? profile.expectedWalletAddress ?? null;
    const oracleAddress = profile.oracleWallet ?? null;

    if (!endpointOk) reasons.push("Mainnet TON endpoint is not configured");
    if (!profile.deployWallet?.type) reasons.push("Mainnet deploy wallet configuration is missing");
    if (!expectedAddress) reasons.push("TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS is not configured");
    if (!oracleAddress) reasons.push("TON_MAINNET_ORACLE_ADDRESS is not configured");
    if (oracleAddress && !isValidTonAddress(oracleAddress)) reasons.push("TON_MAINNET_ORACLE_ADDRESS is not a valid TON address");

    const walletType = input.walletType ?? null;
    const workchain = input.workchain ?? null;
    const walletId = input.walletId ?? null;
    const walletAddress = input.walletAddress ?? null;
    let identityMatch = null;

    if (input.requireLiveWallet === true) {
        if (walletType !== DEPLOYER_WALLET_CONTRACT_TYPE) reasons.push(`Mainnet wallet type must be ${DEPLOYER_WALLET_CONTRACT_TYPE}`);
        if (workchain !== DEPLOYER_WALLET_WORKCHAIN) reasons.push(`Mainnet wallet workchain must be ${DEPLOYER_WALLET_WORKCHAIN}`);
        if (!Number.isFinite(Number(walletId))) reasons.push("Mainnet wallet id missing or invalid");
        if (!walletAddress) reasons.push("Deployer wallet identity not available");
    }

    if (walletAddress && expectedAddress) {
        identityMatch = tonAddressesEqual(walletAddress, expectedAddress);
        if (!identityMatch) reasons.push(`Mainnet deployer identity mismatch | derived=${walletAddress} | expected=${expectedAddress}`);
    }

    const balanceAvailable = input.balanceTon != null || input.balanceNano != null;
    if (input.requireBalance === true && !balanceAvailable) reasons.push("Mainnet deployer wallet balance unavailable");

    const walletIdentityPass = walletType === DEPLOYER_WALLET_CONTRACT_TYPE
        && workchain === DEPLOYER_WALLET_WORKCHAIN
        && Number.isFinite(Number(walletId))
        && Boolean(walletAddress)
        && (expectedAddress ? identityMatch === true : true);

    const walletIdentitySkip = !input.requireLiveWallet;
    const oracleConfigurationPass = Boolean(oracleAddress)
        && isValidTonAddress(oracleAddress);

    const checks = Object.freeze({
        configuration: checkStatus(endpointOk && Boolean(expectedAddress) && oracleConfigurationPass),
        networkProfile: checkStatus(profile.network === "mainnet" && Boolean(profile.deployWallet?.type)),
        walletDerivation: checkStatus(walletIdentityPass, walletIdentitySkip),
        expectedAddressMatch: checkStatus(identityMatch === true, identityMatch === null),
        oracleConfiguration: checkStatus(oracleConfigurationPass)
    });

    const uniqueReasons = [...new Set(reasons)];
    return {
        status: uniqueReasons.length === 0 ? "PASS" : "FAIL",
        network: profile.network,
        activeNetwork: input.activeNetwork ?? null,
        walletType,
        workchain,
        walletId,
        walletAddress,
        expectedAddress,
        identityMatch,
        balanceTon: input.balanceTon ?? null,
        balanceNano: input.balanceNano ?? null,
        balanceAvailable,
        seqno: input.seqno ?? null,
        oracleAddress,
        endpoint: profile.endpoint,
        checks,
        reasons: uniqueReasons,
        validationTimestamp: Date.now(),
        profile
    };
}

export function assertMainnetStartupSafe({
    profile,
    walletAddress = null,
    walletType = null,
    workchain = null,
    walletId = null
} = {}) {
    const failures = [];
    if (!profile?.endpoint) failures.push("Mainnet endpoint missing");
    if (!profile?.oracleWallet) failures.push("TON_MAINNET_ORACLE_ADDRESS is not configured");
    if (!(profile?.deployerExpectedAddress || profile?.expectedWalletAddress)) {
        failures.push("TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS is not configured");
    }
    if (!profile?.deployWallet?.type) failures.push("Mainnet deploy wallet configuration missing");
    if (walletType && walletType !== DEPLOYER_WALLET_CONTRACT_TYPE) failures.push(`TON deployer wallet type mismatch | got=${walletType}`);
    if (workchain != null && workchain !== DEPLOYER_WALLET_WORKCHAIN) failures.push(`TON deployer wallet workchain mismatch | got=${workchain}`);
    if (walletId != null && !Number.isFinite(Number(walletId))) failures.push("TON deployer wallet id invalid");

    const expected = profile?.deployerExpectedAddress ?? profile?.expectedWalletAddress ?? null;
    if (expected) {
        if (!walletAddress) failures.push("Deployer mnemonic required when TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS is set");
        else if (!tonAddressesEqual(walletAddress, expected)) failures.push(`TON deployer wallet identity mismatch | derived=${walletAddress} | expected=${expected}`);
    }

    if (profile?.oracleWallet && !isValidTonAddress(profile.oracleWallet)) {
        failures.push("TON_MAINNET_ORACLE_ADDRESS is not a valid TON address");
    }

    if (failures.length > 0) {
        throw new Error(`Mainnet startup validation failed: ${failures.join("; ")}`);
    }
}
