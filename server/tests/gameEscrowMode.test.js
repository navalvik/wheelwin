/**
 * R7.67A — GameEscrow mode defaults + ambiguous-mode refusal.
 */
import assert from "node:assert/strict";

import { loadTonConfig } from "../config/ton.js";
import {
    GAME_ESCROW_MODE_GAME,
    GAME_ESCROW_MODE_V4,
    defaultGameEscrowModeForNetwork,
    resolveGameEscrowMode
} from "../config/gameEscrowMode.js";

function main() {

    {
        assert.equal(defaultGameEscrowModeForNetwork("testnet"), GAME_ESCROW_MODE_GAME);
        assert.equal(defaultGameEscrowModeForNetwork("TESTNET"), GAME_ESCROW_MODE_GAME);
        assert.equal(defaultGameEscrowModeForNetwork("mainnet"), GAME_ESCROW_MODE_V4);
        assert.equal(defaultGameEscrowModeForNetwork(undefined), GAME_ESCROW_MODE_V4);
        console.log("  network defaults: OK");
    }

    {
        assert.equal(
            resolveGameEscrowMode(undefined, { TON_NETWORK: "testnet" }),
            GAME_ESCROW_MODE_GAME
        );
        assert.equal(
            resolveGameEscrowMode(undefined, { TON_NETWORK: "mainnet" }),
            GAME_ESCROW_MODE_V4
        );
        assert.equal(
            resolveGameEscrowMode(undefined, {}),
            GAME_ESCROW_MODE_V4
        );
        assert.equal(
            resolveGameEscrowMode("v4", { TON_NETWORK: "testnet", GAME_ESCROW_MODE: "game" }),
            GAME_ESCROW_MODE_V4
        );
        assert.equal(
            resolveGameEscrowMode(undefined, {
                TON_NETWORK: "testnet",
                GAME_ESCROW_MODE: "v4"
            }),
            GAME_ESCROW_MODE_V4
        );
        assert.equal(
            resolveGameEscrowMode(undefined, {
                TON_NETWORK: "mainnet",
                GAME_ESCROW_MODE: "game"
            }),
            GAME_ESCROW_MODE_GAME
        );
        console.log("  resolve overrides: OK");
    }

    {
        assert.throws(
            () => resolveGameEscrowMode(undefined, { GAME_ESCROW_MODE: "" }),
            /Ambiguous GAME_ESCROW_MODE/
        );
        assert.throws(
            () => resolveGameEscrowMode(undefined, { GAME_ESCROW_MODE: "legacy" }),
            /Ambiguous GAME_ESCROW_MODE/
        );
        assert.throws(
            () => resolveGameEscrowMode("wallet-v4", {}),
            /Ambiguous GAME_ESCROW_MODE/
        );
        console.log("  ambiguous refused: OK");
    }

    {
        const testnet = loadTonConfig({ TON_NETWORK: "testnet" });
        assert.equal(testnet.gameEscrowMode, GAME_ESCROW_MODE_GAME);

        const mainnet = loadTonConfig({ TON_NETWORK: "mainnet" });
        assert.equal(mainnet.gameEscrowMode, GAME_ESCROW_MODE_V4);

        const rollback = loadTonConfig({
            TON_NETWORK: "testnet",
            GAME_ESCROW_MODE: "v4"
        });
        assert.equal(rollback.gameEscrowMode, GAME_ESCROW_MODE_V4);

        assert.throws(
            () => loadTonConfig({ TON_NETWORK: "testnet", GAME_ESCROW_MODE: "nope" }),
            /Ambiguous GAME_ESCROW_MODE/
        );
        console.log("  loadTonConfig: OK");
    }

    console.log("gameEscrowMode.test.js: all assertions passed");

}

main();
