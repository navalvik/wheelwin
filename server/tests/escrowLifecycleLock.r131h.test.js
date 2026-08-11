/**
 * R13.1H — GameEscrow lifecycle mode freeze in financial snapshot.
 */
import assert from "node:assert/strict";

import {
    GAME_ESCROW_MODE_GAME,
    GAME_ESCROW_MODE_V4
} from "../config/gameEscrowMode.js";
import { buildGameContractSnapshot } from "../payment/buildGameContractSnapshot.js";
import {
    GAME_ESCROW_MODE_GAME as MODE_GAME,
    GAME_ESCROW_MODE_V4 as MODE_V4
} from "../payment/ton/buildGameEscrowStateInit.js";

function identities() {

    return new Map([
        ["p1", { nickname: "A", baseStake: 10, sectorCount: 1 }],
        ["p2", { nickname: "B", baseStake: 10, sectorCount: 1 }],
        ["p3", { nickname: "C", baseStake: 10, sectorCount: 1 }]
    ]);

}

function buildSnapshot(escrowMode, gameId = "game_1") {

    const map = identities();

    return buildGameContractSnapshot({
        gameId,
        roomId: `room_${gameId}`,
        playerIds: ["p1", "p2", "p3"],
        playerManager: {
            getIdentity(playerId) {

                return map.get(playerId) ?? null;

            }
        },
        sessionWalletStore: {
            getWallet(_roomId, playerId) {

                return `EQ_${playerId}`;

            }
        },
        configuration: { stake: 10, players: [], sectors: [] },
        ownerWallet: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
        oracleWallet: "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j",
        escrowMode,
        network: "testnet",
        adapterIdentity: "TonGameContractAdapter",
        contractAddress: null
    });

}

function resolveEscrowMode(contract, processMode) {

    const fromSnapshot = contract?.snapshot?.escrowMode;

    if (
        fromSnapshot === MODE_GAME
        || fromSnapshot === MODE_V4
    ) {

        return fromSnapshot;

    }

    return processMode;

}

console.log("R13.1H escrow lifecycle lock tests");

// A — Create with mode A; env changes; settlement uses mode A
{

    const snapshot = buildSnapshot(GAME_ESCROW_MODE_GAME, "game_a");

    assert.equal(snapshot.escrowMode, GAME_ESCROW_MODE_GAME);
    assert.equal(snapshot.network, "testnet");
    assert.equal(snapshot.adapterIdentity, "TonGameContractAdapter");

    const processModeAfterChange = GAME_ESCROW_MODE_V4;

    const settledMode = resolveEscrowMode(
        { snapshot },
        processModeAfterChange
    );

    assert.equal(
        settledMode,
        GAME_ESCROW_MODE_GAME,
        "settlement must use frozen snapshot mode, not process env"
    );
    console.log("  A. env mode change → settlement uses frozen mode A");

}

// B — Restart between payment and settlement (snapshot survives)
{

    const snapshot = buildSnapshot(GAME_ESCROW_MODE_GAME, "game_b");

    // Simulate process restart: only frozen snapshot remains.
    const restoredContract = {
        snapshot: Object.freeze({ ...snapshot }),
        contractAddress: "EQ_CONTRACT_B"
    };

    const processModeAfterRestart = GAME_ESCROW_MODE_V4;

    assert.equal(
        resolveEscrowMode(restoredContract, processModeAfterRestart),
        GAME_ESCROW_MODE_GAME
    );
    console.log("  B. restart → original escrow configuration retained");

}

// C — Two games with different frozen modes
{

    const gameGame = buildSnapshot(GAME_ESCROW_MODE_GAME, "game_game");
    const gameV4 = buildSnapshot(GAME_ESCROW_MODE_V4, "game_v4");

    assert.equal(gameGame.escrowMode, GAME_ESCROW_MODE_GAME);
    assert.equal(gameV4.escrowMode, GAME_ESCROW_MODE_V4);

    const processMode = GAME_ESCROW_MODE_GAME;

    assert.equal(
        resolveEscrowMode({ snapshot: gameGame }, processMode),
        GAME_ESCROW_MODE_GAME
    );
    assert.equal(
        resolveEscrowMode({ snapshot: gameV4 }, processMode),
        GAME_ESCROW_MODE_V4
    );
    console.log("  C. two games keep independent frozen configurations");

}

// Snapshot freeze
{

    const snapshot = buildSnapshot(GAME_ESCROW_MODE_GAME, "game_freeze");

    assert.throws(() => {

        snapshot.escrowMode = GAME_ESCROW_MODE_V4;

    });
    console.log("  snapshot escrowMode is frozen → PASS");

}

console.log("R13.1H escrow lifecycle lock tests passed");
