import assert from "node:assert/strict";

import {
    GAME_CONTRACT_STATUS,
    GameContract
} from "../models/GameContract.js";

import { buildGameContractSnapshot } from "../payment/buildGameContractSnapshot.js";

{
    const contract = new GameContract({
        contractId: "contract_1",
        gameId: "game_1",
        roomId: "room_1"
    });

    assert.equal(contract.status, GAME_CONTRACT_STATUS.NOT_CREATED);

    assert.equal(contract.transitionTo(GAME_CONTRACT_STATUS.CREATING), true);

    assert.equal(contract.transitionTo(GAME_CONTRACT_STATUS.CREATED), true);

    assert.ok(contract.createdAt);

    assert.equal(
        contract.transitionTo(GAME_CONTRACT_STATUS.AWAITING_PAYMENTS),
        true
    );

    assert.equal(
        contract.transitionTo(GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN),
        true
    );

    assert.equal(
        contract.transitionTo(GAME_CONTRACT_STATUS.CREATING),
        false,
        "terminal / invalid transitions rejected"
    );

    const client = contract.toClientSnapshot();

    assert.equal(client.contractId, "contract_1");

    assert.equal(client.status, GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN);

    assert.equal(client.snapshot, undefined);

    assert.equal(Object.isFrozen(client), true);

}

{
    const identities = new Map([
        ["p1", {
            nickname: "A",
            baseStake: 10,
            sectorCount: 1,
            color: "Red",
            icon: "dice"
        }],
        ["p2", {
            nickname: "B",
            baseStake: 10,
            sectorCount: 2,
            color: "Blue",
            colorSector2: "Green",
            icon: "dog"
        }],
        ["p3", {
            nickname: "C",
            baseStake: 10,
            sectorCount: 1,
            color: "Orange",
            icon: "cat"
        }]
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
        configuration: {
            stake: 10,
            players: [],
            sectors: [
                { sectorId: "s0", ownerId: "p1", color: "#f00" }
            ]
        }
    });

    assert.ok(snapshot);

    assert.equal(Object.isFrozen(snapshot), true);

    assert.equal(snapshot.players.length, 3);

    assert.equal(snapshot.players[0].requiredGram, 10);

    assert.equal(snapshot.players[1].requiredGram, 25);

    assert.equal(snapshot.totalPot, 45);

    assert.equal(snapshot.organizerFee, 2.25);

    assert.equal(snapshot.payoutAmount, 42.75);

    assert.equal(snapshot.winnerPercentage, 0.95);

    assert.equal(snapshot.currency, "GRM");

    assert.equal(snapshot.sectors.length, 1);

    // Mutating frozen snapshot must throw in strict mode.
    assert.throws(() => {

        snapshot.totalPot = 0;

    });

}

console.log("gameContract.model.test.js: all assertions passed");
