/**
 * R7.68 — TON_MAINNET_READINESS diagnostics (Railway-visible, no secrets).
 */
import { printDeployBlock } from "./DeployPipelineForensics.js";
import { tonAddressesEqual } from "./TonWalletIdentityDebug.js";
import {
    GAME_ESCROW_MODE_V4,
    assertValidGameEscrowMode
} from "../config/gameEscrowMode.js";
import { loadMainnetTonProfile } from "../config/tonNetworkProfiles.js";
import { verifyGameEscrowArtifact } from "../payment/ton/verifyGameEscrowArtifact.js";

/** @type {null | Record<string, unknown>} */
let _tonMainnetReadiness = null;

/**
 * @param {Record<string, unknown>} fields
 */
export function setTonMainnetReadiness(fields = {}) {

    _tonMainnetReadiness = {
        status: fields.status ?? "UNKNOWN",
        network: fields.network ?? null,
        activeNetwork: fields.activeNetwork ?? null,
        walletType: fields.walletType ?? null,
        walletAddress: fields.walletAddress ?? null,
        expectedAddress: fields.expectedAddress ?? null,
        identityMatch: fields.identityMatch ?? null,
        balanceTon: fields.balanceTon ?? null,
        balanceNano: fields.balanceNano ?? null,
        seqno: fields.seqno ?? null,
        artifactHash: fields.artifactHash ?? null,
        expectedArtifactHash: fields.expectedArtifactHash ?? null,
        artifactMatch: fields.artifactMatch ?? null,
        oracleAddress: fields.oracleAddress ?? null,
        escrowMode: fields.escrowMode ?? null,
        endpoint: fields.endpoint ?? null,
        rollbackAvailable: fields.rollbackAvailable ?? null,
        reasons: Array.isArray(fields.reasons) ? [...fields.reasons] : [],
        timestamp: Date.now()
    };

    return getTonMainnetReadiness();

}

export function getTonMainnetReadiness() {

    if (!_tonMainnetReadiness) {

        return null;

    }

    return Object.freeze({
        ..._tonMainnetReadiness,
        reasons: Object.freeze([..._tonMainnetReadiness.reasons])
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
        walletAddress: snapshot.walletAddress,
        expectedAddress: snapshot.expectedAddress,
        identityMatch: snapshot.identityMatch,
        balanceTon: snapshot.balanceTon,
        balanceNano: snapshot.balanceNano,
        seqno: snapshot.seqno,
        artifactHash: snapshot.artifactHash,
        expectedArtifactHash: snapshot.expectedArtifactHash,
        artifactMatch: snapshot.artifactMatch,
        oracleAddress: snapshot.oracleAddress,
        escrowMode: snapshot.escrowMode,
        endpoint: snapshot.endpoint,
        rollbackAvailable: snapshot.rollbackAvailable,
        reasons: snapshot.reasons
    });

}

export function resetTonMainnetReadinessForTests() {

    _tonMainnetReadiness = null;

}

/**
 * Evaluate Mainnet readiness against the dedicated mainnet profile.
 * Does not enable Mainnet. Does not change Testnet runtime.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv|Record<string, string|undefined>,
 *   activeNetwork?: string|null,
 *   walletType?: string|null,
 *   walletAddress?: string|null,
 *   balanceTon?: number|null,
 *   balanceNano?: string|null,
 *   seqno?: number|null,
 *   requireLiveWallet?: boolean
 * }} [input]
 */
export function evaluateMainnetReadiness(input = {}) {

    const env = input.env ?? process.env;
    const profile = loadMainnetTonProfile(env);
    const reasons = [];

    let escrowModeOk = true;

    try {

        assertValidGameEscrowMode(profile.gameEscrowMode);

    } catch (error) {

        escrowModeOk = false;
        reasons.push(error?.message ?? "Invalid mainnet escrow mode");

    }

    // R7.68 — Mainnet must remain on v4 until an explicit launch stage enables game.
    if (escrowModeOk && profile.gameEscrowMode !== GAME_ESCROW_MODE_V4) {

        reasons.push(
            `Mainnet escrow mode is "${profile.gameEscrowMode}" — `
                + "R7.68 keeps mainnet on v4 (do not enable game yet)"
        );

    }

    if (!profile.oracleWallet) {

        reasons.push("TON_MAINNET_ORACLE_ADDRESS is not configured");

    }

    if (!profile.deployerExpectedAddress) {

        reasons.push("TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS is not configured");

    }

    if (!profile.endpoint) {

        reasons.push("TON_MAINNET_ENDPOINT is not configured");

    }

    const artifact = verifyGameEscrowArtifact({
        expectedSha256: profile.artifactSha256,
        requirePresent: true
    });

    for (const reason of artifact.reasons) {

        reasons.push(reason);

    }

    if (!artifact.expectedSha256) {

        reasons.push(
            "Expected GameEscrow artifact SHA256 missing "
                + "(set TON_GAME_ESCROW_ARTIFACT_SHA256 or artifact meta)"
        );

    }

    const walletAddress = input.walletAddress ?? null;
    const expectedAddress = profile.deployerExpectedAddress;
    let identityMatch = null;

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

    const rollbackAvailable = escrowModeOk === true;

    if (!rollbackAvailable) {

        reasons.push("Rollback mode (v4) is not available — escrow mode invalid");

    }

    const status = reasons.length === 0 ? "PASS" : "FAIL";

    return {
        status,
        network: profile.network,
        activeNetwork: input.activeNetwork ?? null,
        walletType: input.walletType ?? null,
        walletAddress,
        expectedAddress,
        identityMatch,
        balanceTon: input.balanceTon ?? null,
        balanceNano: input.balanceNano ?? null,
        seqno: input.seqno ?? null,
        artifactHash: artifact.actualSha256,
        expectedArtifactHash: artifact.expectedSha256,
        artifactMatch: artifact.match,
        oracleAddress: profile.oracleWallet,
        escrowMode: profile.gameEscrowMode,
        endpoint: profile.endpoint,
        rollbackAvailable,
        reasons,
        profile,
        artifact
    };

}

/**
 * Strict Mainnet active-network startup checks.
 * Call only when TON_NETWORK=mainnet.
 *
 * @param {{
 *   profile: object,
 *   walletAddress?: string|null,
 *   artifact: ReturnType<typeof verifyGameEscrowArtifact>
 * }} args
 */
export function assertMainnetStartupSafe({
    profile,
    walletAddress = null,
    artifact
}) {

    const failures = [];

    try {

        assertValidGameEscrowMode(profile.gameEscrowMode);

    } catch (error) {

        failures.push(error?.message ?? "Invalid escrow mode");

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

    if (profile.deployerExpectedAddress) {

        if (!walletAddress) {

            failures.push(
                "Deployer mnemonic required when TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS is set"
            );

        } else if (!tonAddressesEqual(walletAddress, profile.deployerExpectedAddress)) {

            failures.push(
                `TON deployer wallet identity mismatch | derived=${walletAddress} | `
                    + `expected=${profile.deployerExpectedAddress}`
            );

        }

    }

    if (failures.length > 0) {

        throw new Error(
            `Mainnet startup validation failed: ${failures.join("; ")}`
        );

    }

}
