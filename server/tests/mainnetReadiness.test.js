/**
 * R7.68 / R8.1A / R8.1B — Mainnet dry-run readiness + wallet verification tests.
 */
import assert from "node:assert/strict";

import { loadTonConfig } from "../config/ton.js";
import {
    assertTonNetworkProfileComplete,
    loadMainnetTonProfile,
    loadTestnetTonProfile,
    loadTonNetworkProfiles
} from "../config/tonNetworkProfiles.js";
import {
    GAME_ESCROW_MODE_GAME,
    GAME_ESCROW_MODE_V4
} from "../config/gameEscrowMode.js";
import {
    assertMainnetConfigurationValid,
    isMainnetRollbackSafe,
    validateMainnetConfiguration
} from "../config/validateMainnetConfiguration.js";
import {
    evaluateMainnetReadiness,
    isTonMainnetDryRunDebugEnabled,
    resetTonMainnetReadinessForTests
} from "../diagnostics/TonMainnetReadiness.js";
import {
    isTonMainnetWalletIdentityDebugEnabled,
    resetTonMainnetWalletIdentityDebugForTests,
    setTonMainnetWalletIdentityDebug,
    getTonMainnetWalletIdentityDebug
} from "../diagnostics/TonMainnetWalletIdentityDebug.js";
import {
    assertDeployerWalletMatchesExpected,
    isValidTonAddress
} from "../diagnostics/TonWalletIdentityDebug.js";
import {
    DEPLOYER_WALLET_CONTRACT_TYPE,
    DEPLOYER_WALLET_WORKCHAIN
} from "../payment/ton/deriveDeployerWalletIdentity.js";
import {
    hashGameEscrowArtifactBoc,
    loadGameEscrowArtifactExpectedMeta,
    verifyGameEscrowArtifact
} from "../payment/ton/verifyGameEscrowArtifact.js";

/** Valid zero-address pin used for format-safe config tests. */
const VALID_ADDR_A = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
/** Distinct valid address for mismatch cases. */
const VALID_ADDR_B = "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j";

function main() {

    resetTonMainnetReadinessForTests();
    resetTonMainnetWalletIdentityDebugForTests();

    {
        const testnet = loadTestnetTonProfile({});
        assert.equal(testnet.network, "testnet");
        assert.equal(testnet.gameEscrowMode, GAME_ESCROW_MODE_GAME);
        assert.equal(testnet.escrowMode, GAME_ESCROW_MODE_GAME);
        assert.ok(testnet.endpoint.includes("testnet"));
        assert.equal(testnet.deployWallet.type, DEPLOYER_WALLET_CONTRACT_TYPE);
        assert.equal(testnet.deployWallet.workchain, DEPLOYER_WALLET_WORKCHAIN);
        assert.ok(testnet.artifact.bocPath.includes("GameEscrow.code.boc"));

        const mainnet = loadMainnetTonProfile({});
        assert.equal(mainnet.network, "mainnet");
        assert.equal(mainnet.gameEscrowMode, GAME_ESCROW_MODE_V4);
        assert.equal(mainnet.escrowMode, GAME_ESCROW_MODE_V4);
        assert.ok(mainnet.endpoint.includes("toncenter.com"));
        assert.equal(mainnet.oracleWallet, null);
        assert.equal(mainnet.deployWallet.type, "WalletContractV4R2");
        assert.equal(mainnet.expectedWalletAddress, null);
        assert.ok(mainnet.artifact.bocPath);

        assert.doesNotThrow(() => assertTonNetworkProfileComplete(testnet));
        assert.throws(
            () => assertTonNetworkProfileComplete(mainnet, {
                requireOracle: true,
                requireExpectedAddress: true,
                requireArtifactSha: true
            }),
            /profile incomplete/
        );

        const profiles = loadTonNetworkProfiles({
            TON_MAINNET_ORACLE_ADDRESS: VALID_ADDR_A,
            TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS: VALID_ADDR_A,
            TON_GAME_ESCROW_ARTIFACT_SHA256: "abc"
        });

        assert.equal(profiles.mainnet.oracleWallet.startsWith("EQ"), true);
        assert.equal(profiles.mainnet.artifactSha256, "abc");
        assert.equal(profiles.mainnet.artifact.sha256Expected, "abc");
        assert.equal(profiles.testnet.gameEscrowMode, GAME_ESCROW_MODE_GAME);
        console.log("  network profiles: OK");
    }

    {
        const ton = loadTonConfig({ TON_NETWORK: "testnet" });
        assert.equal(ton.network, "testnet");
        assert.equal(ton.gameEscrowMode, GAME_ESCROW_MODE_GAME);
        assert.ok(ton.profiles?.mainnet);
        assert.equal(ton.profiles.mainnet.gameEscrowMode, GAME_ESCROW_MODE_V4);

        const main = loadTonConfig({ TON_NETWORK: "mainnet" });
        assert.equal(main.network, "mainnet");
        assert.equal(main.gameEscrowMode, GAME_ESCROW_MODE_V4);
        console.log("  loadTonConfig profiles: OK");
    }

    {
        const hashed = hashGameEscrowArtifactBoc();
        assert.equal(hashed.present, true);
        assert.equal(hashed.sha256.length, 64);

        const meta = loadGameEscrowArtifactExpectedMeta();
        assert.ok(meta?.sha256);

        const ok = verifyGameEscrowArtifact({
            expectedSha256: meta.sha256,
            requirePresent: true,
            requireLoadable: true
        });
        assert.equal(ok.ok, true);
        assert.equal(ok.match, true);
        assert.equal(ok.loadable, true);

        const bad = verifyGameEscrowArtifact({
            expectedSha256: "0".repeat(64),
            requirePresent: true,
            requireLoadable: true
        });
        assert.equal(bad.ok, false);
        assert.equal(bad.match, false);
        console.log("  artifact integrity: OK");
    }

    {
        assert.equal(isValidTonAddress(VALID_ADDR_A), true);
        assert.equal(isValidTonAddress("not-an-address"), false);
        assert.equal(isValidTonAddress(""), false);
        console.log("  ton address format: OK");
    }

    {
        const meta = loadGameEscrowArtifactExpectedMeta();
        const oracle = VALID_ADDR_A;
        const expected = VALID_ADDR_A;

        // Missing oracle address → FAIL
        const missingOracle = validateMainnetConfiguration({
            TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS: expected,
            TON_MAINNET_GAME_ESCROW_MODE: "v4",
            TON_GAME_ESCROW_ARTIFACT_SHA256: meta.sha256
        });
        assert.equal(missingOracle.ok, false);
        assert.ok(
            missingOracle.reasons.some((reason) => reason.includes(
                "TON_MAINNET_ORACLE_ADDRESS"
            ))
        );

        // Missing expected wallet address → FAIL
        const missingExpected = validateMainnetConfiguration({
            TON_MAINNET_ORACLE_ADDRESS: oracle,
            TON_MAINNET_GAME_ESCROW_MODE: "v4",
            TON_GAME_ESCROW_ARTIFACT_SHA256: meta.sha256
        });
        assert.equal(missingExpected.ok, false);
        assert.ok(
            missingExpected.reasons.some((reason) => reason.includes(
                "TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS"
            ))
        );

        const missingEnv = validateMainnetConfiguration({
            TON_MAINNET_GAME_ESCROW_MODE: "v4"
        });
        assert.equal(missingEnv.ok, false);
        assert.ok(missingEnv.missingEnvKeys.length >= 1);
        assert.throws(
            () => assertMainnetConfigurationValid({
                TON_MAINNET_GAME_ESCROW_MODE: "v4"
            }),
            /Mainnet configuration validation failed/
        );

        const fail = evaluateMainnetReadiness({
            env: {
                TON_MAINNET_GAME_ESCROW_MODE: "v4"
            },
            activeNetwork: "testnet"
        });
        assert.equal(fail.status, "FAIL");
        assert.ok(fail.reasons.length >= 1);
        assert.equal(fail.checks.configuration, "FAIL");
        assert.equal(fail.checks.oracleConfiguration, "FAIL");

        const passEnv = {
            TON_MAINNET_ENDPOINT: "https://toncenter.com/api/v2/jsonRPC",
            TON_MAINNET_ORACLE_ADDRESS: oracle,
            TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS: expected,
            TON_MAINNET_GAME_ESCROW_MODE: "v4",
            TON_GAME_ESCROW_ARTIFACT_SHA256: meta.sha256
        };

        // Valid configuration → PASS
        const configOk = validateMainnetConfiguration(passEnv);
        assert.equal(configOk.ok, true, configOk.reasons.join("; "));
        assert.equal(isMainnetRollbackSafe(configOk.escrowMode), true);

        // Correct derived wallet → PASS
        const pass = evaluateMainnetReadiness({
            env: passEnv,
            activeNetwork: "testnet",
            walletType: "WalletContractV4R2",
            workchain: 0,
            walletId: 698983191,
            walletAddress: expected,
            balanceTon: 1,
            seqno: 1,
            requireLiveWallet: true
        });
        assert.equal(pass.status, "PASS", pass.reasons.join("; "));
        assert.equal(pass.rollbackAvailable, true);
        assert.equal(pass.escrowMode, GAME_ESCROW_MODE_V4);
        assert.equal(pass.checks.configuration, "PASS");
        assert.equal(pass.checks.networkProfile, "PASS");
        assert.equal(pass.checks.walletDerivation, "PASS");
        assert.equal(pass.checks.expectedAddressMatch, "PASS");
        assert.equal(pass.checks.oracleConfiguration, "PASS");
        assert.equal(pass.checks.walletIdentity, "PASS");
        assert.equal(pass.checks.artifact, "PASS");
        assert.equal(pass.checks.rollbackSafety, "PASS");
        assert.equal(typeof pass.validationTimestamp, "number");
        assert.equal(pass.artifactLoadable, true);

        const invalidEscrow = evaluateMainnetReadiness({
            env: {
                ...passEnv,
                TON_MAINNET_GAME_ESCROW_MODE: "legacy"
            }
        });
        assert.equal(invalidEscrow.status, "FAIL");
        assert.ok(
            invalidEscrow.reasons.some((reason) => /Ambiguous GAME_ESCROW_MODE/i.test(reason)
                || /Invalid/i.test(reason)
                || /Allowed values/i.test(reason))
        );

        // Wrong expected address → FAIL
        const walletMismatch = evaluateMainnetReadiness({
            env: passEnv,
            walletType: "WalletContractV4R2",
            workchain: 0,
            walletId: 698983191,
            walletAddress: VALID_ADDR_B,
            requireLiveWallet: true
        });
        assert.equal(walletMismatch.status, "FAIL");
        assert.ok(
            walletMismatch.reasons.some((reason) => reason.includes("identity mismatch")
                && reason.includes("network=mainnet"))
        );
        assert.equal(walletMismatch.checks.expectedAddressMatch, "FAIL");
        assert.equal(walletMismatch.checks.walletIdentity, "FAIL");

        assert.throws(
            () => assertDeployerWalletMatchesExpected(
                VALID_ADDR_B,
                expected,
                { network: "mainnet" }
            ),
            /network=mainnet/
        );

        // Oracle ≠ expected deployer → FAIL
        const oracleMismatch = validateMainnetConfiguration({
            ...passEnv,
            TON_MAINNET_ORACLE_ADDRESS: VALID_ADDR_B
        });
        assert.equal(oracleMismatch.ok, false);
        assert.ok(
            oracleMismatch.reasons.some((reason) => reason.includes(
                "must match"
            ))
        );

        const invalidOracleFormat = validateMainnetConfiguration({
            ...passEnv,
            TON_MAINNET_ORACLE_ADDRESS: "not-a-ton-address"
        });
        assert.equal(invalidOracleFormat.ok, false);
        assert.ok(
            invalidOracleFormat.reasons.some((reason) => reason.includes(
                "not a valid TON address"
            ))
        );

        const artifactMismatch = evaluateMainnetReadiness({
            env: {
                ...passEnv,
                TON_GAME_ESCROW_ARTIFACT_SHA256: "0".repeat(64)
            },
            walletType: "WalletContractV4R2",
            workchain: 0,
            walletId: 698983191,
            walletAddress: expected,
            requireLiveWallet: true
        });
        assert.equal(artifactMismatch.status, "FAIL");
        assert.ok(
            artifactMismatch.reasons.some((reason) => reason.includes("SHA256 mismatch"))
        );
        assert.equal(artifactMismatch.checks.artifact, "FAIL");

        const gameBlocked = evaluateMainnetReadiness({
            env: {
                ...passEnv,
                TON_MAINNET_GAME_ESCROW_MODE: "game"
            },
            walletType: "WalletContractV4R2",
            workchain: 0,
            walletId: 698983191,
            walletAddress: expected
        });
        assert.equal(gameBlocked.status, "FAIL");
        assert.equal(gameBlocked.checks.rollbackSafety, "FAIL");
        assert.ok(
            gameBlocked.reasons.some((reason) => reason.includes("keeps mainnet on v4")
                || reason.includes("GameEscrow not production"))
        );
        console.log("  mainnet readiness evaluate: OK");
    }

    {
        // Testnet regression — wallet flow / GameEscrow mode unchanged.
        const testnet = loadTestnetTonProfile({
            GAME_ESCROW_MODE: "game"
        });
        assert.equal(testnet.gameEscrowMode, GAME_ESCROW_MODE_GAME);

        const ton = loadTonConfig({
            TON_NETWORK: "testnet",
            GAME_ESCROW_MODE: "game"
        });
        assert.equal(ton.gameEscrowMode, GAME_ESCROW_MODE_GAME);
        assert.equal(ton.profiles.mainnet.gameEscrowMode, GAME_ESCROW_MODE_V4);

        assert.equal(isTonMainnetDryRunDebugEnabled("true"), true);
        assert.equal(isTonMainnetDryRunDebugEnabled("0"), false);
        assert.equal(isTonMainnetWalletIdentityDebugEnabled("true"), true);
        assert.equal(isTonMainnetWalletIdentityDebugEnabled("0"), false);

        setTonMainnetWalletIdentityDebug({
            network: "mainnet",
            walletType: DEPLOYER_WALLET_CONTRACT_TYPE,
            workchain: 0,
            walletId: 698983191,
            derivedAddress: VALID_ADDR_A,
            expectedAddress: VALID_ADDR_A,
            oracleAddress: VALID_ADDR_A,
            identityMatch: true,
            balanceTon: 1,
            seqno: 2,
            timestamp: 123
        });
        const snap = getTonMainnetWalletIdentityDebug();
        assert.equal(snap.derivedAddress, VALID_ADDR_A);
        assert.equal(snap.oracleAddress, VALID_ADDR_A);
        assert.equal(snap.walletType, "WalletContractV4R2");
        console.log("  testnet unchanged + wallet identity debug: OK");
    }

    console.log("mainnetReadiness.test.js: all assertions passed");

}

main();
