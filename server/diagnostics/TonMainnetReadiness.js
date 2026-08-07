/**
 * R7.68 / R8.1A — TON_MAINNET_READINESS + dry-run diagnostics (Railway-visible, no secrets).
 */
import { printDeployBlock } from "./DeployPipelineForensics.js";
import { tonAddressesEqual } from "./TonWalletIdentityDebug.js";
import {
    GAME_ESCROW_MODE_V4,
    assertValidGameEscrowMode
} from "../config/gameEscrowMode.js";
import {
    isMainnetRollbackSafe,
    validateMainnetConfiguration
} from "../config/validateMainnetConfiguration.js";
import {
    DEPLOYER_WALLET_CONTRACT_TYPE,
    DEPLOYER_WALLET_WORKCHAIN
} from "../payment/ton/deriveDeployerWalletIdentity.js";
import { verifyGameEscrowArtifact } from "../payment/ton/verifyGameEscrowArtifact.js";

/** @type {null | Record<string, unknown>} */
let _tonMainnetReadiness = null;

/**
 * @param {string|null|undefined} raw
 * @returns {boolean}
 */
export function isTonMainnetDryRunDebugEnabled(raw = process.env.TON_MAINNET_DRY_RUN_DEBUG) {

    if (raw === undefined || raw === null) {

        return false;

    }

    const normalized = String(raw).trim().toLowerCase();

    return normalized === "1"
        || normalized === "true"
        || normalized === "yes"
        || normalized === "on";

}

/**
 * @param {Record<string, unknown>} fields
 */
export function setTonMainnetReadiness(fields = {}) {

    const validationTimestamp = fields.validationTimestamp
        ?? fields.timestamp
        ?? Date.now();

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
        artifactHash: fields.artifactHash ?? null,
        expectedArtifactHash: fields.expectedArtifactHash ?? null,
        artifactMatch: fields.artifactMatch ?? null,
        artifactLoadable: fields.artifactLoadable ?? null,
        oracleAddress: fields.oracleAddress ?? null,
        escrowMode: fields.escrowMode ?? null,
        endpoint: fields.endpoint ?? null,
        rollbackAvailable: fields.rollbackAvailable ?? null,
        checks: fields.checks ?? null,
        reasons: Array.isArray(fields.reasons) ? [...fields.reasons] : [],
        validationTimestamp,
        timestamp: validationTimestamp
    };

    return getTonMainnetReadiness();

}

export function getTonMainnetReadiness() {

    if (!_tonMainnetReadiness) {

        return null;

    }

    return Object.freeze({
        ..._tonMainnetReadiness,
        reasons: Object.freeze([..._tonMainnetReadiness.reasons]),
        checks: _tonMainnetReadiness.checks
            ? Object.freeze({ ..._tonMainnetReadiness.checks })
            : null
    });

}

export function printTonMainnetReadiness(fields = null) {

    const snapshot = fields
        ? Object.freeze({ ...fields })
        : getTonMainnetReadiness();

    if (!snapshot) {

        return;

    }

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
        artifactHash: snapshot.artifactHash,
        expectedArtifactHash: snapshot.expectedArtifactHash,
        artifactMatch: snapshot.artifactMatch,
        artifactLoadable: snapshot.artifactLoadable,
        oracleAddress: snapshot.oracleAddress,
        escrowMode: snapshot.escrowMode,
        endpoint: snapshot.endpoint,
        rollbackAvailable: snapshot.rollbackAvailable,
        checks: snapshot.checks,
        reasons: snapshot.reasons,
        validationTimestamp: snapshot.validationTimestamp ?? snapshot.timestamp
    });

}

/**
 * R8.1A — Extra dry-run diagnostics when TON_MAINNET_DRY_RUN_DEBUG is enabled.
 *
 * @param {Record<string, unknown>|null} [fields]
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 */
export function printTonMainnetDryRunDebug(fields = null, env = process.env) {

    if (!isTonMainnetDryRunDebugEnabled(env.TON_MAINNET_DRY_RUN_DEBUG)) {

        return;

    }

    const snapshot = fields
        ? Object.freeze({ ...fields })
        : getTonMainnetReadiness();

    if (!snapshot) {

        return;

    }

    printDeployBlock("TON_MAINNET_DRY_RUN_DEBUG", {
        network: snapshot.network,
        walletType: snapshot.walletType,
        walletAddress: snapshot.walletAddress,
        expectedAddress: snapshot.expectedAddress,
        walletBalance: snapshot.balanceTon,
        artifactHash: snapshot.artifactHash,
        escrowMode: snapshot.escrowMode,
        validationTimestamp: snapshot.validationTimestamp ?? snapshot.timestamp,
        status: snapshot.status,
        checks: snapshot.checks,
        reasons: snapshot.reasons
    });

}

export function resetTonMainnetReadinessForTests() {

    _tonMainnetReadiness = null;

}

/**
 * @param {"PASS"|"FAIL"|"SKIP"} status
 */
function checkStatus(pass, skip = false) {

    if (skip) {

        return "SKIP";

    }

    return pass ? "PASS" : "FAIL";

}

/**
 * Evaluate Mainnet readiness against the dedicated mainnet profile.
 * Does not enable Mainnet. Does not change Testnet runtime.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv|Record<string, string|undefined>,
 *   activeNetwork?: string|null,
 *   walletType?: string|null,
 *   workchain?: number|null,
 *   walletId?: number|null,
 *   walletAddress?: string|null,
 *   balanceTon?: number|null,
 *   balanceNano?: string|null,
 *   seqno?: number|null,
 *   requireLiveWallet?: boolean,
 *   requireBalance?: boolean
 * }} [input]
 */
export function evaluateMainnetReadiness(input = {}) {

    const env = input.env ?? process.env;
    const validationTimestamp = Date.now();
    const configValidation = validateMainnetConfiguration(env);
    const profile = configValidation.profile ?? {
        network: "mainnet",
        endpoint: null,
        deployWallet: null,
        oracleWallet: null,
        deployerExpectedAddress: null,
        expectedWalletAddress: null,
        gameEscrowMode: null,
        escrowMode: null,
        artifactSha256: null,
        artifact: null
    };
    const reasons = [...configValidation.reasons];

    let escrowModeOk = configValidation.escrowModeValid;

    if (profile.gameEscrowMode != null) {

        try {

            assertValidGameEscrowMode(profile.gameEscrowMode);
            escrowModeOk = true;

        } catch (error) {

            escrowModeOk = false;

            const message = error?.message ?? "Invalid mainnet escrow mode";

            if (!reasons.includes(message)) {

                reasons.push(message);

            }

        }

    } else {

        escrowModeOk = false;

    }

    // R8.1A — Mainnet must remain on v4 until an explicit launch stage enables game.
    if (escrowModeOk && profile.gameEscrowMode !== GAME_ESCROW_MODE_V4) {

        reasons.push(
            `Mainnet escrow mode is "${profile.gameEscrowMode}" — `
                + "R8.1A keeps mainnet on v4 (GameEscrow not production-enabled)"
        );

    }

    const artifact = verifyGameEscrowArtifact({
        expectedSha256: profile.artifactSha256,
        requirePresent: true,
        requireLoadable: true
    });

    for (const reason of artifact.reasons) {

        if (!reasons.includes(reason)) {

            reasons.push(reason);

        }

    }

    if (!artifact.expectedSha256) {

        const missingHash =
            "Expected GameEscrow artifact SHA256 missing "
            + "(set TON_GAME_ESCROW_ARTIFACT_SHA256 or artifact meta)";

        if (!reasons.includes(missingHash)) {

            reasons.push(missingHash);

        }

    }

    const walletAddress = input.walletAddress ?? null;
    const expectedAddress = profile.deployerExpectedAddress
        ?? profile.expectedWalletAddress
        ?? null;
    const walletType = input.walletType ?? null;
    const workchain = input.workchain ?? null;
    const walletId = input.walletId ?? null;
    let identityMatch = null;

    if (walletType != null || walletAddress != null || input.requireLiveWallet) {

        if (walletType && walletType !== DEPLOYER_WALLET_CONTRACT_TYPE) {

            reasons.push(
                `Mainnet wallet type must be ${DEPLOYER_WALLET_CONTRACT_TYPE} `
                    + `| got=${walletType}`
            );

        } else if (input.requireLiveWallet === true && !walletType) {

            reasons.push(
                `Mainnet wallet type missing (expected ${DEPLOYER_WALLET_CONTRACT_TYPE})`
            );

        }

        if (workchain != null && workchain !== DEPLOYER_WALLET_WORKCHAIN) {

            reasons.push(
                `Mainnet wallet workchain must be ${DEPLOYER_WALLET_WORKCHAIN} `
                    + `| got=${workchain}`
            );

        } else if (
            input.requireLiveWallet === true
            && (workchain === null || workchain === undefined)
        ) {

            reasons.push(
                `Mainnet wallet workchain missing (expected ${DEPLOYER_WALLET_WORKCHAIN})`
            );

        }

        if (
            input.requireLiveWallet === true
            && (walletId === null || walletId === undefined || !Number.isFinite(Number(walletId)))
        ) {

            reasons.push("Mainnet wallet id missing or invalid");

        }

    }

    if (walletAddress && expectedAddress) {

        identityMatch = tonAddressesEqual(walletAddress, expectedAddress);

        if (!identityMatch) {

            reasons.push(
                `Mainnet deployer identity mismatch | derived=${walletAddress} | `
                    + `expected=${expectedAddress}`
            );

        }

    } else if (input.requireLiveWallet === true && !walletAddress) {

        reasons.push("Deployer wallet identity not available (mnemonic required)");

    }

    const balanceAvailable = input.balanceTon != null || input.balanceNano != null;

    if (input.requireBalance === true && !balanceAvailable) {

        reasons.push("Mainnet deployer wallet balance unavailable");

    }

    const rollbackAvailable = isMainnetRollbackSafe(profile.gameEscrowMode);

    if (!rollbackAvailable) {

        if (!reasons.some((reason) => reason.includes("rollback") || reason.includes("keeps mainnet on v4") || reason.includes("GameEscrow not production"))) {

            reasons.push(
                "Rollback safety FAIL — Mainnet must remain escrow mode v4 "
                    + "(GameEscrow not production-enabled)"
            );

        }

    }

    const uniqueReasons = [];

    for (const reason of reasons) {

        if (!uniqueReasons.includes(reason)) {

            uniqueReasons.push(reason);

        }

    }

    const configurationPass = configValidation.ok
        && escrowModeOk
        && Boolean(profile.endpoint)
        && Boolean(profile.oracleWallet)
        && Boolean(expectedAddress)
        && Boolean(artifact.expectedSha256);

    const walletIdentityPass = identityMatch === true
        && (walletType == null || walletType === DEPLOYER_WALLET_CONTRACT_TYPE)
        && (workchain == null || workchain === DEPLOYER_WALLET_WORKCHAIN)
        && (walletId == null || Number.isFinite(Number(walletId)))
        && (
            input.requireLiveWallet !== true
            || (
                walletType === DEPLOYER_WALLET_CONTRACT_TYPE
                && workchain === DEPLOYER_WALLET_WORKCHAIN
                && Number.isFinite(Number(walletId))
            )
        );

    const walletIdentitySkip = identityMatch === null
        && (
            !expectedAddress
            || (input.requireLiveWallet !== true && !walletAddress)
        );

    const artifactPass = artifact.present === true
        && artifact.match === true
        && artifact.loadable === true;

    const networkProfilePass = profile.network === "mainnet"
        && Boolean(profile.deployWallet?.type)
        && Boolean(profile.artifact?.bocPath)
        && escrowModeOk;

    const checks = Object.freeze({
        configuration: checkStatus(configurationPass),
        walletIdentity: checkStatus(walletIdentityPass, walletIdentitySkip),
        artifact: checkStatus(artifactPass),
        networkProfile: checkStatus(networkProfilePass),
        rollbackSafety: checkStatus(rollbackAvailable)
    });

    const status = uniqueReasons.length === 0 ? "PASS" : "FAIL";

    return {
        status,
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
        artifactHash: artifact.actualSha256,
        expectedArtifactHash: artifact.expectedSha256,
        artifactMatch: artifact.match,
        artifactLoadable: artifact.loadable,
        oracleAddress: profile.oracleWallet,
        escrowMode: profile.gameEscrowMode,
        endpoint: profile.endpoint,
        rollbackAvailable,
        checks,
        reasons: uniqueReasons,
        validationTimestamp,
        profile,
        artifact,
        configValidation
    };

}

/**
 * Strict Mainnet active-network startup checks.
 * Call only when TON_NETWORK=mainnet.
 *
 * @param {{
 *   profile: object,
 *   walletAddress?: string|null,
 *   walletType?: string|null,
 *   workchain?: number|null,
 *   walletId?: number|null,
 *   artifact: ReturnType<typeof verifyGameEscrowArtifact>
 * }} args
 */
export function assertMainnetStartupSafe({
    profile,
    walletAddress = null,
    walletType = null,
    workchain = null,
    walletId = null,
    artifact
}) {

    const failures = [];

    try {

        assertValidGameEscrowMode(profile.gameEscrowMode);

    } catch (error) {

        failures.push(error?.message ?? "Invalid escrow mode");

    }

    if (!profile?.endpoint) {

        failures.push("Mainnet endpoint missing");

    }

    if (!profile?.oracleWallet) {

        failures.push("TON_MAINNET_ORACLE_ADDRESS is not configured");

    }

    if (!(profile?.deployerExpectedAddress || profile?.expectedWalletAddress)) {

        failures.push("TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS is not configured");

    }

    if (!profile?.deployWallet?.type) {

        failures.push("Mainnet deploy wallet configuration missing");

    }

    if (!profile?.artifact?.bocPath && !artifact?.path) {

        failures.push("Mainnet artifact configuration missing");

    }

    if (!artifact?.present) {

        failures.push("GameEscrow artifact missing");

    }

    if (artifact?.expectedSha256 && artifact.match !== true) {

        failures.push(
            artifact.reasons?.[0]
                ?? "GameEscrow artifact SHA256 mismatch"
        );

    }

    if (artifact?.loadable === false) {

        failures.push(
            artifact.reasons?.find((reason) => reason.includes("loadable"))
                ?? "GameEscrow artifact not loadable by StateInit builder"
        );

    }

    if (walletType && walletType !== DEPLOYER_WALLET_CONTRACT_TYPE) {

        failures.push(
            `TON deployer wallet type mismatch | got=${walletType} | `
                + `expected=${DEPLOYER_WALLET_CONTRACT_TYPE}`
        );

    }

    if (workchain != null && workchain !== DEPLOYER_WALLET_WORKCHAIN) {

        failures.push(
            `TON deployer wallet workchain mismatch | got=${workchain} | `
                + `expected=${DEPLOYER_WALLET_WORKCHAIN}`
        );

    }

    if (walletId != null && !Number.isFinite(Number(walletId))) {

        failures.push("TON deployer wallet id invalid");

    }

    if (profile.deployerExpectedAddress || profile.expectedWalletAddress) {

        const expected = profile.deployerExpectedAddress
            ?? profile.expectedWalletAddress;

        if (!walletAddress) {

            failures.push(
                "Deployer mnemonic required when TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS is set"
            );

        } else if (!tonAddressesEqual(walletAddress, expected)) {

            failures.push(
                `TON deployer wallet identity mismatch | derived=${walletAddress} | `
                    + `expected=${expected}`
            );

        }

    }

    if (failures.length > 0) {

        throw new Error(
            `Mainnet startup validation failed: ${failures.join("; ")}`
        );

    }

}
