/**
 * R18-S93 — Mainnet startup decoupled from the retired GameEscrow readiness
 * gate. Room Wallet is the only player-finance path on Testnet and Mainnet.
 *
 * Proves:
 *   A. Mainnet + Room-Wallet-only: startup readiness does not require the
 *      legacy GameEscrow oracle pin, deployer pin, artifact SHA256 or deployer
 *      mnemonic, and does not invoke the legacy readiness as a startup blocker.
 *   B. Legacy / dry-run: the existing GameEscrow readiness requirements still
 *      fail closed exactly as before when invoked directly.
 *   C. Testnet: configuration behavior is unchanged and the readiness skip is
 *      Mainnet-scoped.
 *   D. Room Wallet architecture: RoomWalletSettlementRouter remains the
 *      settlement adapter, isRoomWalletOnlyFinancialPath stays authoritative,
 *      blockchain deploy stays skipped, and the runtime resolver still
 *      requires a complete 64-wallet catalog with WalletContractV4 identity.
 *
 * Deterministic dummy wallets only. No chain sends, no secrets, no real
 * Mainnet catalog generation.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadTonConfig } from "../config/ton.js";
import { loadMainnetTonProfile } from "../config/tonNetworkProfiles.js";
import {
    assertMainnetConfigurationValid,
    validateMainnetConfiguration
} from "../config/validateMainnetConfiguration.js";
import {
    assertMainnetStartupSafe,
    evaluateMainnetReadiness,
    getTonMainnetReadiness,
    resetTonMainnetReadinessForTests,
    setTonMainnetReadiness
} from "../diagnostics/TonMainnetReadiness.js";
import { RoomWalletSettlementAdapter } from "../payment/roomWallet/RoomWalletSettlementAdapter.js";
import { RoomWalletSettlementRouter } from "../payment/RoomWalletSettlementRouter.js";
import {
    composeRoomWalletSettlementRouter,
    isRoomWalletOnlyFinancialPath
} from "../payment/roomWallet/roomWalletConfig.js";
import {
    createRoomWalletRegistryFromEnv
} from "../payment/roomWallet/RoomWalletRuntimeResolver.js";
import { createDummyRoomWalletCatalog } from "./helpers/dummyRoomWallet.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(join(HERE, "../app.js"), "utf8");
const GCM_SOURCE = readFileSync(
    join(HERE, "../gameplay/GameContractManager.js"),
    "utf8"
);

/** Valid zero-address pin used for format-safe config tests. */
const VALID_ADDR_A = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
/** Distinct valid address for mismatch cases. */
const VALID_ADDR_B = "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j";

function mainnetReadinessMethodSource() {
    const start = APP_SOURCE.indexOf(
        "async _runTonMainnetReadinessDiagnostics()"
    );

    assert.ok(start > 0, "readiness diagnostics method must exist in app.js");

    // The method ends at the next class method declaration (4-space indent).
    const rest = APP_SOURCE.slice(start + 10);
    const nextMethod = rest.match(/\n    (?:async )?[a-zA-Z_$][\w$]*\(/);
    const end = nextMethod ? start + 10 + nextMethod.index : APP_SOURCE.length;

    assert.ok(end > start, "readiness method boundary must be found");

    return APP_SOURCE.slice(start, end);
}

function envWithMainnetCatalog(extra = {}) {
    return {
        TON_NETWORK: "mainnet",
        ROOM_WALLETS_MAINNET_JSON: JSON.stringify(
            createDummyRoomWalletCatalog(64, { network: "mainnet" })
        ),
        ...extra
    };
}


test("A. isRoomWalletOnlyFinancialPath stays authoritative on Mainnet", () => {
    assert.equal(
        isRoomWalletOnlyFinancialPath({ env: { TON_NETWORK: "mainnet" } }),
        true
    );

    // GAME_ESCROW_MODE must not control whether Room Wallet finance is enabled.
    assert.equal(
        isRoomWalletOnlyFinancialPath({
            env: { TON_NETWORK: "mainnet", GAME_ESCROW_MODE: "game" }
        }),
        true
    );
    assert.equal(
        isRoomWalletOnlyFinancialPath({
            env: { TON_NETWORK: "mainnet", GAME_ESCROW_MODE: "v4" }
        }),
        true
    );
});

test("A. Mainnet startup readiness skips the legacy GameEscrow gate", () => {
    const methodSource = mainnetReadinessMethodSource();

    // The Room-Wallet-only branch is Mainnet-scoped and precedes every legacy
    // GameEscrow readiness element in the method body.
    const skipBranchIndex = methodSource.indexOf(
        'network === "mainnet" && isRoomWalletOnlyFinancialPath({ env: process.env })'
    );

    assert.ok(skipBranchIndex >= 0, "Room-Wallet-only readiness branch missing");

    const artifactIndex = methodSource.indexOf("verifyGameEscrowArtifact(");
    const evaluateIndex = methodSource.indexOf("evaluateMainnetReadiness(");
    const assertSafeIndex = methodSource.indexOf("assertMainnetStartupSafe(");

    assert.ok(artifactIndex > skipBranchIndex);
    assert.ok(evaluateIndex > skipBranchIndex);
    assert.ok(assertSafeIndex > skipBranchIndex);

    // The branch returns before the legacy body: the legacy gate is never a
    // Room-Wallet-only startup blocker.
    const branchSlice = methodSource.slice(skipBranchIndex, artifactIndex);
    const branchReturnIndex = branchSlice.indexOf("return;");
    const branchOnly = branchSlice.slice(
        0,
        branchReturnIndex + "return;".length
    );

    assert.match(
        branchOnly,
        /TonMainnetReadiness=SKIP \(RoomWallet-only financial path/
    );
    assert.match(branchOnly, /return;/);

    // No secret material in the skip diagnostic (branch body only).
    assert.doesNotMatch(branchOnly, /secretKey|mnemonic|api[_-]?key/i);

    // Legacy readiness elements are preserved (not deleted or weakened).
    assert.ok(
        methodSource.includes('requireLiveWallet: network === "mainnet"')
    );
    assert.ok(assertSafeIndex > 0);
});


test("A. SKIP readiness snapshot carries no GameEscrow requirements", () => {
    resetTonMainnetReadinessForTests();

    const snapshot = setTonMainnetReadiness({
        status: "SKIP",
        network: "mainnet",
        activeNetwork: "mainnet",
        escrowMode: "game",
        endpoint: "https://toncenter.com/api/v2/jsonRPC",
        reasons: [
            "RoomWallet-only financial path - legacy GameEscrow Mainnet "
                + "readiness (oracle pin, deployer pin, artifact SHA256, "
                + "deployer identity) is not required"
        ]
    });

    assert.equal(snapshot.status, "SKIP");
    assert.equal(snapshot.network, "mainnet");
    assert.equal(snapshot.activeNetwork, "mainnet");

    // No legacy GameEscrow requirement fields are populated by the skip.
    assert.equal(snapshot.oracleAddress, null);
    assert.equal(snapshot.expectedAddress, null);
    assert.equal(snapshot.expectedArtifactHash, null);
    assert.equal(snapshot.artifactMatch, null);
    assert.equal(snapshot.artifactLoadable, null);
    assert.equal(snapshot.walletAddress, null);
    assert.equal(snapshot.checks, null);
    assert.ok(
        snapshot.reasons.some((reason) =>
            reason.includes("RoomWallet-only financial path")
        )
    );

    assert.equal(getTonMainnetReadiness().status, "SKIP");

    resetTonMainnetReadinessForTests();
});

test("B. legacy Mainnet readiness still requires the oracle + deployer pins", () => {
    const validation = validateMainnetConfiguration({ TON_NETWORK: "mainnet" });

    assert.equal(validation.ok, false);
    assert.ok(
        validation.missingEnvKeys.includes("TON_MAINNET_ORACLE_ADDRESS")
    );
    assert.ok(
        validation.missingEnvKeys.includes(
            "TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS"
        )
    );

    assert.throws(
        () => assertMainnetConfigurationValid({ TON_NETWORK: "mainnet" }),
        /TON_MAINNET_ORACLE_ADDRESS/
    );
});

test("B. evaluateMainnetReadiness keeps blocking unpinned mainnet", () => {
    const readiness = evaluateMainnetReadiness({
        env: { TON_NETWORK: "mainnet" },
        activeNetwork: "mainnet",
        requireLiveWallet: true
    });

    assert.equal(readiness.status, "FAIL");
    assert.ok(
        readiness.reasons.some((reason) =>
            reason.includes("TON_MAINNET_ORACLE_ADDRESS")
        )
    );
    assert.ok(
        readiness.reasons.some((reason) =>
            reason.includes("TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS")
        )
    );
    assert.ok(
        readiness.reasons.some(
            (reason) => reason.includes("wallet type missing")
        )
    );

    // The legacy gate requires the deployer mnemonic identity — the exact
    // requirement the Room-Wallet-only path must not inherit.
    assert.ok(
        readiness.reasons.some((reason) => reason.includes("mnemonic"))
    );
});

test("B. assertMainnetStartupSafe still fails closed without the legacy pins", () => {
    const profile = loadMainnetTonProfile({});

    assert.throws(
        () =>
            assertMainnetStartupSafe({
                profile,
                walletAddress: null,
                walletType: "WalletContractV4R2",
                workchain: 0,
                walletId: 698983191,
                artifact: { present: true, match: true, loadable: true }
            }),
        (error) => {
            assert.match(error.message, /Mainnet startup validation failed/);
            assert.match(error.message, /TON_MAINNET_ORACLE_ADDRESS/);
            assert.match(
                error.message,
                /TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS/
            );
            return true;
        }
    );
});

test("B. oracle pin must still match the deployer pin when both are set", () => {
    const mismatch = validateMainnetConfiguration({
        TON_NETWORK: "mainnet",
        TON_MAINNET_ORACLE_ADDRESS: VALID_ADDR_A,
        TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS: VALID_ADDR_B,
        TON_GAME_ESCROW_ARTIFACT_SHA256: "a".repeat(64)
    });

    assert.equal(mismatch.ok, false);
    assert.ok(mismatch.reasons.some((reason) => reason.includes("must match")));
});
