import assert from "node:assert/strict";

import { Address } from "@ton/core";

import {
    GAME_CONTRACT_STATUS,
    GameContract
} from "../models/GameContract.js";

import { buildGameContractSnapshot } from "../payment/buildGameContractSnapshot.js";
import {
    buildStubContractAddress,
    GameContractDeployAdapter
} from "../payment/GameContractDeployAdapter.js";

{
    const contract = new GameContract({
        contractId: "contract_1",
        gameId: "game_1",
        roomId: "room_1"
    });

    assert.equal(contract.transitionTo(GAME_CONTRACT_STATUS.CREATING), true);

    assert.equal(contract.transitionTo(GAME_CONTRACT_STATUS.CREATED), true);

    assert.equal(
        contract.transitionTo(GAME_CONTRACT_STATUS.AWAITING_PAYMENTS),
        true
    );

    assert.equal(
        contract.transitionTo(GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN),
        true
    );

    assert.equal(contract.transitionTo(GAME_CONTRACT_STATUS.DEPLOYING), true);

    contract.applyDeploymentSuccess({
        contractAddress: "EQtestaddress",
        deploymentTxId: "tx1"
    });

    assert.equal(contract.transitionTo(GAME_CONTRACT_STATUS.DEPLOYED), true);

    assert.equal(
        contract.transitionTo(GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS),
        true
    );

    assert.equal(
        contract.transitionTo(GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE),
        true
    );

    const client = contract.toClientSnapshot();

    assert.equal(client.contractAddress, "EQtestaddress");

    assert.equal(client.deploymentStatus, "DEPLOYED");

    assert.equal(client.snapshot, undefined);

    assert.equal(
        client.ownerWallet,
        undefined,
        "P6.8A — owner wallet must never reach client snapshot"
    );

}

{
    const failing = new GameContract({
        contractId: "c2",
        gameId: "g2",
        roomId: "r2",
        status: GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN
    });

    assert.equal(failing.transitionTo(GAME_CONTRACT_STATUS.DEPLOYING), true);

    failing.applyDeploymentFailure("boom");

    assert.equal(
        failing.transitionTo(GAME_CONTRACT_STATUS.DEPLOY_FAILED),
        true
    );

    assert.equal(failing.deployError, "boom");

}

{
    const adapter = new GameContractDeployAdapter({ deployDelayMs: 0 });

    const result = await adapter.deploy({
        contractId: "contract_abc123",
        snapshot: { gameId: "g1", totalPot: 10 }
    });

    assert.equal(result.ok, true);

    const parsed = Address.parseFriendly(result.contractAddress);

    assert.equal(parsed.isBounceable, true);

    assert.equal(parsed.isTestOnly, false);

    assert.ok(result.contractAddress.startsWith("EQ"));

    assert.equal(
        result.contractAddress,
        buildStubContractAddress("contract_abc123", { testOnly: false })
    );

    assert.throws(
        () => Address.parseFriendly(`EQ${"a".repeat(46)}`),
        "legacy fake EQ+suffix must fail CRC validation"
    );

    const testnetAdapter = new GameContractDeployAdapter({
        deployDelayMs: 0,
        network: "testnet"
    });

    const testnetResult = await testnetAdapter.deploy({
        contractId: "contract_abc123",
        snapshot: { gameId: "g1", totalPot: 10 }
    });

    assert.equal(testnetResult.ok, true);

    const testnetParsed = Address.parseFriendly(testnetResult.contractAddress);

    assert.equal(testnetParsed.isTestOnly, true);

    assert.ok(testnetResult.contractAddress.startsWith("kQ"));

    const failAdapter = new GameContractDeployAdapter({ shouldFail: true });

    const failed = await failAdapter.deploy({
        contractId: "contract_x",
        snapshot: { gameId: "g1" }
    });

    assert.equal(failed.ok, false);

}

{
    const identities = new Map([
        ["p1", { nickname: "A", baseStake: 10, sectorCount: 1 }],
        ["p2", { nickname: "B", baseStake: 10, sectorCount: 2 }],
        ["p3", { nickname: "C", baseStake: 10, sectorCount: 1 }]
    ]);

    const snapshot = buildGameContractSnapshot({
        gameId: "game_1",
        roomId: "room_1",
        playerIds: ["p1", "p2", "p3"],
        playerManager: {
            getIdentity(playerId) {

                return identities.get(playerId) ?? null;

            }
        },
        sessionWalletStore: {
            getWallet(_roomId, playerId) {

                return `EQ_${playerId}`;

            }
        },
        configuration: { stake: 10, players: [], sectors: [] },
        ownerWallet: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c"
    });

    assert.equal(snapshot.totalPot, 45);

    assert.equal(
        snapshot.ownerWallet,
        "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c"
    );

    assert.equal(
        Object.isFrozen(snapshot),
        true,
        "snapshot must be frozen"
    );

}

console.log("gameContract.model.test.js: all assertions passed");
