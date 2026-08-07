/**
 * R7.68 — Mainnet readiness config + artifact integrity tests.
 */
import assert from "node:assert/strict";

import { loadTonConfig } from "../config/ton.js";
import {
    loadMainnetTonProfile,
    loadTestnetTonProfile,
    loadTonNetworkProfiles
} from "../config/tonNetworkProfiles.js";
import {
    GAME_ESCROW_MODE_GAME,
    GAME_ESCROW_MODE_V4
} from "../config/gameEscrowMode.js";
import {
    evaluateMainnetReadiness,
    resetTonMainnetReadinessForTests
} from "../diagnostics/TonMainnetReadiness.js";
import {
    hashGameEscrowArtifactBoc,
    loadGameEscrowArtifactExpectedMeta,
    verifyGameEscrowArtifact
} from "../payment/ton/verifyGameEscrowArtifact.js";

function main() {

    resetTonMainnetReadinessForTests();

    {
        const testnet = loadTestnetTonProfile({});
        assert.equal(testnet.network, "testnet");
        assert.equal(testnet.gameEscrowMode, GAME_ESCROW_MODE_GAME);
        assert.ok(testnet.endpoint.includes("testnet"));

        const mainnet = loadMainnetTonProfile({});
        assert.equal(mainnet.network, "mainnet");
        assert.equal(mainnet.gameEscrowMode, GAME_ESCROW_MODE_V4);
        assert.ok(mainnet.endpoint.includes("toncenter.com"));
        assert.equal(mainnet.oracleWallet, null);

        const profiles = loadTonNetworkProfiles({
            TON_MAINNET_ORACLE_ADDRESS: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
            TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS:
                "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j",
            TON_GAME_ESCROW_ARTIFACT_SHA256: "abc"
        });

        assert.equal(profiles.mainnet.oracleWallet.startsWith("EQ"), true);
        assert.equal(profiles.mainnet.artifactSha256, "abc");
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
            requirePresent: true
        });
        assert.equal(ok.ok, true);
        assert.equal(ok.match, true);

        const bad = verifyGameEscrowArtifact({
            expectedSha256: "0".repeat(64),
            requirePresent: true
        });
        assert.equal(bad.ok, false);
        assert.equal(bad.match, false);
        console.log("  artifact integrity: OK");
    }

    {
        const meta = loadGameEscrowArtifactExpectedMeta();
        const fail = evaluateMainnetReadiness({
            env: {
                TON_MAINNET_GAME_ESCROW_MODE: "v4"
            },
            activeNetwork: "testnet"
        });
        assert.equal(fail.status, "FAIL");
        assert.ok(fail.reasons.length >= 1);

        const pass = evaluateMainnetReadiness({
            env: {
                TON_MAINNET_ENDPOINT: "https://toncenter.com/api/v2/jsonRPC",
                TON_MAINNET_ORACLE_ADDRESS:
                    "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
                TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS:
                    "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
                TON_MAINNET_GAME_ESCROW_MODE: "v4",
                TON_GAME_ESCROW_ARTIFACT_SHA256: meta.sha256
            },
            activeNetwork: "testnet",
            walletType: "WalletContractV4R2",
            walletAddress: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
            balanceTon: 1,
            seqno: 1,
            requireLiveWallet: true
        });
        assert.equal(pass.status, "PASS", pass.reasons.join("; "));
        assert.equal(pass.rollbackAvailable, true);
        assert.equal(pass.escrowMode, GAME_ESCROW_MODE_V4);

        const gameBlocked = evaluateMainnetReadiness({
            env: {
                TON_MAINNET_ENDPOINT: "https://toncenter.com/api/v2/jsonRPC",
                TON_MAINNET_ORACLE_ADDRESS:
                    "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
                TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS:
                    "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
                TON_MAINNET_GAME_ESCROW_MODE: "game",
                TON_GAME_ESCROW_ARTIFACT_SHA256: meta.sha256
            },
            walletAddress: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c"
        });
        assert.equal(gameBlocked.status, "FAIL");
        assert.ok(
            gameBlocked.reasons.some((reason) => reason.includes("keeps mainnet on v4"))
        );
        console.log("  mainnet readiness evaluate: OK");
    }

    console.log("mainnetReadiness.test.js: all assertions passed");

}

main();
