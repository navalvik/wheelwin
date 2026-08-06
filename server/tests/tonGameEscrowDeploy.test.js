/**
 * R7.66E — GameEscrow deployment integration via TonGameContractAdapter.
 */
import assert from "node:assert/strict";

import {
    getGameEscrowDeployDebug,
    getTonDeployDebug,
    resetTonDeployDebugForTests
} from "../diagnostics/DeployPipelineForensics.js";
import { TonGameContractAdapter } from "../payment/TonGameContractAdapter.js";
import {
    GAME_ESCROW_MODE_GAME,
    GAME_ESCROW_MODE_V4,
    buildGameEscrowWallet,
    loadGameEscrowCodeCell
} from "../payment/ton/buildGameEscrowStateInit.js";
import { MockTonTransport } from "../payment/ton/MockTonTransport.js";

const OWNER = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const ORACLE = "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j";

const baseSnapshot = Object.freeze({
    gameId: "game_r766e",
    roomId: "room_r766e",
    totalPot: 30,
    organizerFee: 1.5,
    ownerWallet: OWNER,
    oracleWallet: ORACLE,
    players: [
        { playerId: "p1", wallet: "EQ1", requiredGram: 10 }
    ]
});

function createNoMnemonicService(transport = new MockTonTransport()) {

    return {
        getActiveNetwork: () => "testnet",
        isConnected: () => true,
        getTransport: () => transport,
        async broadcastTransaction(boc) {

            return transport.sendBoc(boc);

        },
        async getAccount() {

            return { state: "uninitialized", balance: "0" };

        },
        async getSeqno() {

            return 0;

        },
        async runGetMethod() {

            return { stack: [] };

        }
    };

}

function createAdapter(gameEscrowMode) {

    return new TonGameContractAdapter({
        tonConfig: {
            endpoint: "https://testnet.toncenter.com/api/v2/jsonRPC",
            apiKey: null,
            deployerMnemonic: null,
            network: "testnet",
            gameEscrowMode,
            oracleAddress: ORACLE,
            ownerWallet: OWNER
        },
        tonService: createNoMnemonicService()
    });

}

async function main() {

    resetTonDeployDebugForTests();

    // --- v4 mode unchanged ---

    {
        const expected = buildGameEscrowWallet({
            contractId: "contract_v4_1",
            snapshot: baseSnapshot,
            mode: GAME_ESCROW_MODE_V4
        });

        const adapter = createAdapter(GAME_ESCROW_MODE_V4);
        const result = await adapter.deployContract({
            contractId: "contract_v4_1",
            snapshot: baseSnapshot
        });

        assert.equal(result.ok, true);
        assert.equal(result.contractAddress, expected.addressFriendly);
        assert.ok(result.deploymentTxId);
        assert.equal(result.snapshotHash, expected.snapshotHash);

        const debug = getGameEscrowDeployDebug();
        assert.equal(debug?.mode, GAME_ESCROW_MODE_V4);
        assert.equal(debug?.contractAddress, result.contractAddress);
        assert.equal(debug?.transactionHash, result.deploymentTxId);

        const tonDebug = getTonDeployDebug();
        assert.equal(tonDebug?.escrowAddress, result.contractAddress);
        assert.equal(
            tonDebug?.gameEscrowDeploy?.contractAddress,
            result.contractAddress
        );

        console.log("  v4 mode unchanged: OK");
    }

    resetTonDeployDebugForTests();

    // --- game mode produces GameEscrow address ---

    {
        const expected = buildGameEscrowWallet({
            contractId: "contract_game_1",
            snapshot: baseSnapshot,
            mode: GAME_ESCROW_MODE_GAME,
            oracle: ORACLE,
            owner: OWNER
        });

        const v4 = buildGameEscrowWallet({
            contractId: "contract_game_1",
            snapshot: baseSnapshot,
            mode: GAME_ESCROW_MODE_V4
        });

        const adapter = createAdapter(GAME_ESCROW_MODE_GAME);
        const result = await adapter.deployContract({
            contractId: "contract_game_1",
            snapshot: baseSnapshot
        });

        assert.equal(result.ok, true);
        assert.equal(result.contractAddress, expected.addressFriendly);
        assert.notEqual(result.contractAddress, v4.addressFriendly);
        assert.ok(result.deploymentTxId);

        const code = loadGameEscrowCodeCell();
        const debug = getGameEscrowDeployDebug();
        assert.equal(debug?.mode, GAME_ESCROW_MODE_GAME);
        assert.equal(debug?.contractAddress, result.contractAddress);
        assert.equal(debug?.codeHash, code.hash().toString("hex"));
        assert.ok(debug?.dataHash);
        assert.equal(debug?.oracle, ORACLE);
        assert.equal(debug?.owner, OWNER);
        assert.equal(debug?.transactionHash, result.deploymentTxId);
        assert.equal(debug?.valueTon, "0.05");

        const tonDebug = getTonDeployDebug();
        assert.equal(tonDebug?.escrowAddress, result.contractAddress);
        assert.equal(tonDebug?.gameEscrowDeploy?.mode, GAME_ESCROW_MODE_GAME);

        console.log("  game mode produces GameEscrow address: OK");
    }

    resetTonDeployDebugForTests();

    // --- deterministic redeploy address ---

    {
        const adapter = createAdapter(GAME_ESCROW_MODE_GAME);

        const first = await adapter.deployContract({
            contractId: "contract_det_redeploy",
            snapshot: baseSnapshot
        });

        const second = await adapter.deployContract({
            contractId: "contract_det_redeploy",
            snapshot: baseSnapshot
        });

        assert.equal(first.ok, true);
        assert.equal(second.ok, true);
        assert.equal(first.contractAddress, second.contractAddress);
        assert.equal(first.snapshotHash, second.snapshotHash);

        const expected = buildGameEscrowWallet({
            contractId: "contract_det_redeploy",
            snapshot: baseSnapshot,
            mode: GAME_ESCROW_MODE_GAME,
            oracle: ORACLE,
            owner: OWNER
        });
        assert.equal(first.contractAddress, expected.addressFriendly);

        console.log("  deterministic redeploy address: OK");
    }

    resetTonDeployDebugForTests();

    console.log("tonGameEscrowDeploy.test.js: all assertions passed");

}

main().catch((error) => {

    console.error(error);
    process.exitCode = 1;

});
