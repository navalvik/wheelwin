/**
 * R7.66D — GameEscrow StateInit builder tests.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Address, Cell, contractAddress } from "@ton/core";

import {
    GAME_ESCROW_MODE_GAME,
    GAME_ESCROW_MODE_V4,
    buildGameEscrowDataCell,
    buildGameEscrowStateInit,
    buildGameEscrowWallet,
    hashGameContractSnapshot,
    loadGameEscrowArtifactMeta,
    loadGameEscrowCodeCell,
    resolveGameEscrowMode
} from "../payment/ton/buildGameEscrowStateInit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_BOC = join(
    __dirname,
    "../payment/ton/artifacts/GameEscrow.code.boc"
);

const snapshotA = Object.freeze({
    gameId: "game_a",
    roomId: "room_a",
    totalPot: 30,
    organizerFee: 1.5,
    ownerWallet: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
    players: [
        { playerId: "p1", wallet: "EQ1", requiredGram: 10 }
    ]
});

const oracleA = "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j";
const oracleB = "EQACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAsoi";

function main() {

    // --- mode flag ---

    {
        // R7.67A — unset without network stays v4 (mainnet-safe); testnet defaults to game.
        assert.equal(resolveGameEscrowMode(undefined, {}), GAME_ESCROW_MODE_V4);
        assert.equal(
            resolveGameEscrowMode(undefined, { TON_NETWORK: "testnet" }),
            GAME_ESCROW_MODE_GAME
        );
        assert.equal(
            resolveGameEscrowMode(undefined, { GAME_ESCROW_MODE: "game" }),
            GAME_ESCROW_MODE_GAME
        );
        assert.equal(
            resolveGameEscrowMode("v4", { GAME_ESCROW_MODE: "game" }),
            GAME_ESCROW_MODE_V4
        );
        assert.throws(
            () => resolveGameEscrowMode(undefined, { GAME_ESCROW_MODE: "ambiguous" }),
            /Ambiguous GAME_ESCROW_MODE/
        );
        console.log("  mode flag: OK");
    }

    // --- artifact loads correctly ---

    {
        const code = loadGameEscrowCodeCell({ forceReload: true });
        assert.ok(code instanceof Cell);

        const boc = readFileSync(ARTIFACT_BOC);
        const fromDisk = Cell.fromBoc(boc)[0];
        assert.equal(
            code.hash().toString("hex"),
            fromDisk.hash().toString("hex")
        );

        const meta = loadGameEscrowArtifactMeta();
        assert.equal(meta.contract, "GameEscrow");
        assert.equal(
            code.hash().toString("hex"),
            String(meta.codeHash).toLowerCase()
        );

        const sha256 = createHash("sha256").update(boc).digest("hex");
        assert.equal(sha256, String(meta.sha256).toLowerCase());

        console.log("  artifact loads correctly: OK");
    }

    // --- deterministic address / same code+data ---

    {
        const a = buildGameEscrowStateInit({
            contractId: "contract_det_1",
            snapshot: snapshotA,
            oracle: oracleA,
            owner: snapshotA.ownerWallet
        });

        const b = buildGameEscrowStateInit({
            contractId: "contract_det_1",
            snapshot: snapshotA,
            oracle: oracleA,
            owner: snapshotA.ownerWallet
        });

        assert.equal(a.mode, GAME_ESCROW_MODE_GAME);
        assert.equal(a.addressFriendly, b.addressFriendly);
        assert.ok(a.address.equals(b.address));
        assert.equal(
            a.stateInit.code.hash().toString("hex"),
            b.stateInit.code.hash().toString("hex")
        );
        assert.equal(
            a.stateInit.data.hash().toString("hex"),
            b.stateInit.data.hash().toString("hex")
        );

        const recomputed = contractAddress(0, {
            code: a.code,
            data: a.data
        });
        assert.ok(recomputed.equals(a.address));

        console.log("  deterministic address: OK");
    }

    // --- different oracle => different address ---

    {
        const withA = buildGameEscrowStateInit({
            contractId: "contract_oracle",
            snapshot: snapshotA,
            oracle: oracleA,
            owner: snapshotA.ownerWallet
        });

        const withB = buildGameEscrowStateInit({
            contractId: "contract_oracle",
            snapshot: snapshotA,
            oracle: oracleB,
            owner: snapshotA.ownerWallet
        });

        assert.notEqual(withA.addressFriendly, withB.addressFriendly);
        assert.equal(
            withA.stateInit.code.hash().toString("hex"),
            withB.stateInit.code.hash().toString("hex")
        );
        assert.notEqual(
            withA.stateInit.data.hash().toString("hex"),
            withB.stateInit.data.hash().toString("hex")
        );

        console.log("  different oracle => different address: OK");
    }

    // --- buildGameEscrowWallet mode switch ---

    {
        const v4 = buildGameEscrowWallet({
            contractId: "contract_mode",
            snapshot: snapshotA,
            mode: GAME_ESCROW_MODE_V4
        });

        const game = buildGameEscrowWallet({
            contractId: "contract_mode",
            snapshot: snapshotA,
            oracle: oracleA,
            mode: GAME_ESCROW_MODE_GAME
        });

        assert.equal(v4.mode, GAME_ESCROW_MODE_V4);
        assert.ok(v4.wallet);
        assert.ok(v4.keyPair);
        assert.ok(v4.stateInit);

        assert.equal(game.mode, GAME_ESCROW_MODE_GAME);
        assert.equal(game.wallet, null);
        assert.ok(game.stateInit.code);
        assert.ok(game.stateInit.data);
        assert.notEqual(v4.addressFriendly, game.addressFriendly);

        console.log("  buildGameEscrowWallet mode switch: OK");
    }

    // --- data cell contains required fields (hash stability) ---

    {
        const snapshotHash = hashGameContractSnapshot(snapshotA);
        const data = buildGameEscrowDataCell({
            oracle: Address.parse(oracleA),
            owner: Address.parse(snapshotA.ownerWallet),
            contractIdHash: createHash("sha256").update("cid").digest(),
            snapshotHash
        });

        assert.ok(data instanceof Cell);
        assert.ok(data.bits.length > 0);
        assert.equal(data.refs.length, 1);

        console.log("  data cell layout: OK");
    }

    // --- R7.70C2.4 — snapshot.oracleWallet propagates into StateInit ---

    {
        const ZERO = new Address(0, Buffer.alloc(32));
        const saved = {
            TON_TESTNET_ORACLE_ADDRESS: process.env.TON_TESTNET_ORACLE_ADDRESS,
            GAME_ESCROW_ORACLE: process.env.GAME_ESCROW_ORACLE,
            TON_ORACLE_ADDRESS: process.env.TON_ORACLE_ADDRESS
        };

        delete process.env.TON_TESTNET_ORACLE_ADDRESS;
        delete process.env.GAME_ESCROW_ORACLE;
        delete process.env.TON_ORACLE_ADDRESS;

        try {

            const withOracle = Object.freeze({
                ...snapshotA,
                oracleWallet: oracleA
            });

            const fromSnapshot = buildGameEscrowStateInit({
                contractId: "contract_oracle_snap",
                snapshot: withOracle
                // no oracle/owner args — must read snapshot.oracleWallet
            });

            assert.ok(
                fromSnapshot.oracle.equals(Address.parse(oracleA)),
                "StateInit oracle must match snapshot.oracleWallet"
            );
            assert.equal(
                fromSnapshot.oracle.equals(ZERO),
                false,
                "StateInit oracle must not be ZERO when snapshot.oracleWallet set"
            );

            const missingOracle = buildGameEscrowStateInit({
                contractId: "contract_oracle_missing",
                snapshot: snapshotA
            });

            assert.equal(
                missingOracle.oracle.equals(ZERO),
                true,
                "missing oracleWallet must resolve to ZERO (failure mode)"
            );

            // Regression: ZERO oracle is an invalid GameEscrow deploy input.
            assert.notEqual(
                fromSnapshot.oracle.equals(ZERO),
                true,
                "propagated oracle path must reject ZERO"
            );

        } finally {

            if (saved.TON_TESTNET_ORACLE_ADDRESS === undefined) {
                delete process.env.TON_TESTNET_ORACLE_ADDRESS;
            } else {
                process.env.TON_TESTNET_ORACLE_ADDRESS = saved.TON_TESTNET_ORACLE_ADDRESS;
            }

            if (saved.GAME_ESCROW_ORACLE === undefined) {
                delete process.env.GAME_ESCROW_ORACLE;
            } else {
                process.env.GAME_ESCROW_ORACLE = saved.GAME_ESCROW_ORACLE;
            }

            if (saved.TON_ORACLE_ADDRESS === undefined) {
                delete process.env.TON_ORACLE_ADDRESS;
            } else {
                process.env.TON_ORACLE_ADDRESS = saved.TON_ORACLE_ADDRESS;
            }

        }

        console.log("  snapshot.oracleWallet → StateInit: OK");
    }

    console.log("buildGameEscrowStateInit.test.js: all assertions passed");

}

main();
