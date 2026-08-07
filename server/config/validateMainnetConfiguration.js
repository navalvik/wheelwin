/**
 * R8.1A / R8.1B — Mainnet configuration validation for dry-run preparation.
 * Does not enable Mainnet GameEscrow. Invalid config fails hard (no silent fallback).
 */

import {
    GAME_ESCROW_MODE_V4,
    assertValidGameEscrowMode
} from "./gameEscrowMode.js";
import {
    assertTonNetworkProfileComplete,
    loadMainnetTonProfile
} from "./tonNetworkProfiles.js";
import {
    isValidTonAddress,
    tonAddressesEqual
} from "../diagnostics/TonWalletIdentityDebug.js";
import { loadGameEscrowArtifactExpectedMeta } from "../payment/ton/verifyGameEscrowArtifact.js";

const MAINNET_REQUIRED_ENV_KEYS = Object.freeze([
    "TON_MAINNET_ORACLE_ADDRESS",
    "TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS"
]);

function trimOrNull(value) {

    if (typeof value !== "string") {

        return null;

    }

    const trimmed = value.trim();

    return trimmed ? trimmed : null;

}

/**
 * Validate Mainnet profile + required env for dry-run readiness.
 *
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @returns {{
 *   ok: boolean,
 *   reasons: string[],
 *   profile: object,
 *   networkValid: boolean,
 *   walletConfigPresent: boolean,
 *   artifactConfigPresent: boolean,
 *   escrowModeValid: boolean,
 *   escrowMode: "v4"|"game"|null,
 *   missingEnvKeys: string[]
 * }}
 */
export function validateMainnetConfiguration(env = process.env) {

    const reasons = [];
    const missingEnvKeys = [];

    let profile = null;

    try {

        profile = loadMainnetTonProfile(env);

    } catch (error) {

        reasons.push(error?.message ?? "Failed to load Mainnet profile");

        return {
            ok: false,
            reasons,
            profile: null,
            networkValid: false,
            walletConfigPresent: false,
            artifactConfigPresent: false,
            escrowModeValid: false,
            escrowMode: null,
            missingEnvKeys: [...MAINNET_REQUIRED_ENV_KEYS]
        };

    }

    const networkValid = profile.network === "mainnet";

    if (!networkValid) {

        reasons.push(`Invalid Mainnet network value: ${profile.network}`);

    }

    if (!trimOrNull(env.TON_MAINNET_ENDPOINT) && !profile.endpoint) {

        reasons.push("TON_MAINNET_ENDPOINT is not configured");
        missingEnvKeys.push("TON_MAINNET_ENDPOINT");

    }

    for (const key of MAINNET_REQUIRED_ENV_KEYS) {

        if (!trimOrNull(env[key])) {

            missingEnvKeys.push(key);
            reasons.push(`${key} is not configured`);

        }

    }

    // R8.1B — Explicit address pins must be valid TON addresses (no guessing).
    const oracleRaw = trimOrNull(env.TON_MAINNET_ORACLE_ADDRESS);
    const expectedRaw = trimOrNull(env.TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS);

    if (oracleRaw && !isValidTonAddress(oracleRaw)) {

        reasons.push(
            "TON_MAINNET_ORACLE_ADDRESS is not a valid TON address"
        );

    }

    if (expectedRaw && !isValidTonAddress(expectedRaw)) {

        reasons.push(
            "TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS is not a valid TON address"
        );

    }

    // R8.1B — Oracle must pin the same verified Railway wallet identity as deployer.
    if (
        oracleRaw
        && expectedRaw
        && isValidTonAddress(oracleRaw)
        && isValidTonAddress(expectedRaw)
        && !tonAddressesEqual(oracleRaw, expectedRaw)
    ) {

        reasons.push(
            "TON_MAINNET_ORACLE_ADDRESS must match "
                + "TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS "
                + `(oracle=${oracleRaw} | expected=${expectedRaw} | network=mainnet)`
        );

    }

    const metaSha = loadGameEscrowArtifactExpectedMeta()?.sha256 ?? null;
    const artifactShaConfigured = Boolean(
        trimOrNull(env.TON_GAME_ESCROW_ARTIFACT_SHA256)
        || profile.artifactSha256
        || metaSha
    );

    if (!artifactShaConfigured) {

        missingEnvKeys.push("TON_GAME_ESCROW_ARTIFACT_SHA256");
        reasons.push(
            "TON_GAME_ESCROW_ARTIFACT_SHA256 is not configured "
                + "(and artifact meta SHA256 is missing)"
        );

    }

    let escrowModeValid = false;
    let escrowMode = null;

    try {

        escrowMode = assertValidGameEscrowMode(profile.gameEscrowMode);
        escrowModeValid = true;

    } catch (error) {

        reasons.push(error?.message ?? "Invalid Mainnet escrow mode");

    }

    const walletConfigPresent = Boolean(
        profile.deployWallet?.type
        && profile.deployWallet?.workchain != null
        && (profile.deployerExpectedAddress || profile.expectedWalletAddress)
    );

    if (!profile.deployWallet?.type || profile.deployWallet?.workchain == null) {

        reasons.push("Mainnet deploy wallet configuration is incomplete");

    }

    const artifactConfigPresent = Boolean(
        profile.artifact?.bocPath
        && artifactShaConfigured
    );

    if (!profile.artifact?.bocPath) {

        reasons.push("Mainnet artifact reference is incomplete");

    }

    try {

        assertTonNetworkProfileComplete(profile, {
            requireOracle: true,
            requireExpectedAddress: true,
            requireArtifactSha: !artifactShaConfigured
        });

    } catch (error) {

        const message = error?.message ?? "Mainnet profile incomplete";
        const parts = message
            .replace(/^TON mainnet profile incomplete:\s*/i, "")
            .split("; ");

        for (const part of parts) {

            const trimmed = part.trim();

            if (
                trimmed
                && !reasons.some((reason) => reason.includes(trimmed)
                    || trimmed.includes(reason.replace(/^TON_MAINNET_\w+ is not configured$/, "").trim()))
            ) {

                // Skip profile asserts already covered by dedicated env-key reasons.
                if (
                    trimmed === "Oracle wallet is not configured"
                    && reasons.some((reason) => reason.includes("TON_MAINNET_ORACLE_ADDRESS"))
                ) {

                    continue;

                }

                if (
                    trimmed === "Expected deployer wallet address is not configured"
                    && reasons.some((reason) => reason.includes("TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS"))
                ) {

                    continue;

                }

                if (
                    trimmed === "Artifact SHA256 reference is not configured"
                    && artifactShaConfigured
                ) {

                    continue;

                }

                if (
                    trimmed === "Artifact SHA256 reference is not configured"
                    && reasons.some((reason) => reason.includes("TON_GAME_ESCROW_ARTIFACT_SHA256"))
                ) {

                    continue;

                }

                reasons.push(trimmed);

            }

        }

    }

    // Deduplicate reasons while preserving order.
    const uniqueReasons = [];

    for (const reason of reasons) {

        if (!uniqueReasons.includes(reason)) {

            uniqueReasons.push(reason);

        }

    }

    return {
        ok: uniqueReasons.length === 0,
        reasons: uniqueReasons,
        profile,
        networkValid,
        walletConfigPresent,
        artifactConfigPresent,
        escrowModeValid,
        escrowMode,
        missingEnvKeys
    };

}

/**
 * Fail-hard Mainnet configuration gate. No silent fallback.
 *
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 */
export function assertMainnetConfigurationValid(env = process.env) {

    const result = validateMainnetConfiguration(env);

    if (!result.ok) {

        throw new Error(
            `Mainnet configuration validation failed: ${result.reasons.join("; ")}`
        );

    }

    return result;

}

/**
 * Rollback-safety for R8.1A dry-run: Mainnet escrow must remain v4
 * (GameEscrow not production-enabled).
 *
 * @param {"v4"|"game"|string|null|undefined} escrowMode
 */
export function isMainnetRollbackSafe(escrowMode) {

    try {

        return assertValidGameEscrowMode(escrowMode) === GAME_ESCROW_MODE_V4;

    } catch {

        return false;

    }

}
