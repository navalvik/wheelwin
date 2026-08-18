/**
 * R17.9L.12 — Deposit artifact verification + deterministic StateInit builder tests.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    copyFileSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Address, Cell, contractAddress } from "@ton/core";

import {
    DOMAIN_DEPOSIT_ID,
    DOMAIN_GAME,
    DOMAIN_ROOM,
    bufferToUint256,
    hashDepositId,
    hashGameId,
    hashRoomId
} from "../payment/ton/depositContractHashes.js";
import {
    DEPOSIT_CONTRACT_VERSION,
    DEPOSIT_NETWORK_TAG_MAINNET,
    DEPOSIT_NETWORK_TAG_TESTNET,
    DEPOSIT_STATUS_UNINITIALIZED,
    DepositStateInitError,
    buildDepositDataCell,
    buildDepositStateInit,
    loadDepositCodeCell,
    loadDepositDataCell,
    resetDepositCodeCellCacheForTests
} from "../payment/ton/buildDepositStateInit.js";
import {
    DEPOSIT_CONTRACT_ARTIFACT_BOC_PATH,
    DEPOSIT_CONTRACT_ARTIFACT_META_PATH,
    DepositArtifactVerificationError,
    assertDepositArtifactLoadable,
    assertVerifiedDepositArtifact,
    hashDepositArtifactBoc,
    loadDepositArtifactExpectedMeta,
    resolveExpectedDepositArtifactSha256,
    verifyDepositArtifact
} from "../payment/ton/verifyDepositArtifact.js";
import { loadGameEscrowCodeCell } from "../payment/ton/buildGameEscrowStateInit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const CONTRACTS_DIR = join(REPO_ROOT, "contracts");

const EXPECTED_SHA256 =
    "2f624c71743a3c49dee47d98ebb19ea7b9a53d358ab14e3c696b8369d3e36fde";

const ORACLE_A = "EQAREREREREREREREREREREREREREREREREREREREREREeYT";
const ORACLE_B = "EQAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBMWg";

const WALLET_0 = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const WALLET_1 = "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j";
const WALLET_2 = "EQACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAsoi";
const WALLET_ALT = "EQADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA8id";

const STAKE_NANO = 1_000_000_000n;
const FEE_NANO = 100_000_000n;
const EXPIRES_AT = 1_800_000_000n;

function testEnv(overrides = {}) {

    return {
        TON_TESTNET_ORACLE_ADDRESS: ORACLE_A,
        ...overrides
    };

}

function baseBuildParams(overrides = {}) {

    return {
        depositId: "dep_550e8400-e29b-41d4-a716-446655440000",
        roomId: "room-alpha",
        gameId: "game-beta",
        players: [
            {
                playerId: "seat0",
                wallet: WALLET_0,
                expectedStake: STAKE_NANO
            },
            {
                playerId: "seat1",
                wallet: WALLET_1,
                expectedStake: STAKE_NANO
            },
            {
                playerId: "seat2",
                wallet: WALLET_2,
                expectedStake: STAKE_NANO
            }
        ],
        creationFeePerSeat: FEE_NANO,
        expiresAt: EXPIRES_AT,
        network: "testnet",
        releaseAuthority: ORACLE_A,
        env: testEnv(),
        ...overrides
    };

}

function buildFixture(overrides = {}) {

    resetDepositCodeCellCacheForTests();

    return buildDepositStateInit(baseBuildParams(overrides));

}

function assertThrows(fn, namePattern) {

    assert.throws(fn, (error) => {

        assert.match(error?.name ?? error?.constructor?.name ?? "", namePattern);

        return true;

    });

}

function main() {

    // --- Test 1: correct artifact passes ---

    {
        const result = verifyDepositArtifact({
            expectedSha256: EXPECTED_SHA256,
            requirePresent: true,
            requireLoadable: true
        });

        assert.equal(result.ok, true);
        assert.equal(result.actualSha256, EXPECTED_SHA256);
        assert.equal(result.match, true);
        assert.equal(result.loadable, true);

        console.log("  Test 1 correct artifact passes: OK");
    }

    // --- Test 2: missing artifact fails ---

    {
        const missingPath = join(tmpdir(), "missing-deposit-artifact.boc");
        const result = verifyDepositArtifact({
            bocPath: missingPath,
            expectedSha256: EXPECTED_SHA256,
            requirePresent: true,
            requireLoadable: true
        });

        assert.equal(result.ok, false);
        assert.equal(result.present, false);

        assertThrows(
            () => assertVerifiedDepositArtifact({
                bocPath: missingPath,
                expectedSha256: EXPECTED_SHA256
            }),
            /DepositArtifactVerificationError/
        );

        console.log("  Test 2 missing artifact fails: OK");
    }

    // --- Test 3: corrupted BOC fails ---

    {
        const tempDir = mkdtempSync(join(tmpdir(), "deposit-artifact-corrupt-"));
        const corruptPath = join(tempDir, "DepositContract.code.boc");
        writeFileSync(corruptPath, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]));

        const loadable = assertDepositArtifactLoadable(corruptPath);
        assert.equal(loadable.loadable, false);

        assertThrows(
            () => assertVerifiedDepositArtifact({
                bocPath: corruptPath,
                expectedSha256: EXPECTED_SHA256
            }),
            /DepositArtifactVerificationError/
        );

        console.log("  Test 3 corrupted BOC fails: OK");
    }

    // --- Test 4: hash mismatch fails ---

    {
        const result = verifyDepositArtifact({
            expectedSha256: "0".repeat(64),
            requirePresent: true,
            requireLoadable: true
        });

        assert.equal(result.ok, false);
        assert.equal(result.match, false);
        assert.ok(result.reasons.some((reason) => reason.includes("SHA256 mismatch")));

        console.log("  Test 4 hash mismatch fails: OK");
    }

    // --- Test 5: missing expected hash fails ---

    {
        const tempDir = mkdtempSync(join(tmpdir(), "deposit-artifact-no-meta-"));
        const bocPath = join(tempDir, "DepositContract.code.boc");
        const metaPath = join(tempDir, "DepositContract.code.json");
        copyFileSync(DEPOSIT_CONTRACT_ARTIFACT_BOC_PATH, bocPath);

        const result = verifyDepositArtifact({
            bocPath,
            metaPath,
            expectedSha256: null,
            requirePresent: true,
            requireLoadable: true
        });

        assert.equal(result.ok, false);
        assert.equal(result.expectedSha256, null);
        assert.ok(
            result.reasons.some((reason) => reason.includes("expected artifact SHA256 missing"))
        );

        console.log("  Test 5 missing expected hash fails: OK");
    }

    // --- Test 6: verifier does not derive expected hash from current artifact ---

    {
        const tempDir = mkdtempSync(join(tmpdir(), "deposit-artifact-trust-"));
        const bocPath = join(tempDir, "DepositContract.code.boc");
        copyFileSync(DEPOSIT_CONTRACT_ARTIFACT_BOC_PATH, bocPath);

        const actual = hashDepositArtifactBoc(bocPath).sha256;
        assert.equal(actual, EXPECTED_SHA256);

        const resolved = resolveExpectedDepositArtifactSha256(undefined);
        assert.equal(resolved, EXPECTED_SHA256);

        const wrongConfigured = "a".repeat(64);
        const mismatch = verifyDepositArtifact({
            bocPath,
            expectedSha256: wrongConfigured,
            requirePresent: true,
            requireLoadable: true
        });

        assert.notEqual(mismatch.expectedSha256, actual);
        assert.equal(mismatch.ok, false);

        console.log("  Test 6 expected hash not derived from artifact: OK");
    }

    // --- Test 7: verified code cell is loadable ---

    {
        resetDepositCodeCellCacheForTests();

        const code = loadDepositCodeCell({ forceReload: true });
        assert.ok(code instanceof Cell);
        assert.ok(code.hash().length > 0);

        const meta = loadDepositArtifactExpectedMeta();
        assert.equal(meta.contract, "DepositContract");
        assert.equal(code.hash().toString("hex"), meta.codeHash);

        console.log("  Test 7 verified code cell loadable: OK");
    }

    // --- Tests 8–14: hashing ---

    {
        const depositA = "dep_550e8400-e29b-41d4-a716-446655440000";
        const depositB = "dep_6ba7b810-9dad-11d1-80b4-00c04fd430c8";

        const hashA1 = hashDepositId(depositA);
        const hashA2 = hashDepositId(depositA);
        assert.equal(hashA1.toString("hex"), hashA2.toString("hex"));
        assert.notEqual(hashDepositId(depositA).toString("hex"), hashDepositId(depositB).toString("hex"));

        const roomA = "room-alpha";
        const roomB = "room-beta";
        assert.equal(hashRoomId(roomA).toString("hex"), hashRoomId(roomA).toString("hex"));
        assert.notEqual(hashRoomId(roomA).toString("hex"), hashRoomId(roomB).toString("hex"));

        const gameA = "game-beta";
        const gameB = "game-gamma";
        assert.equal(hashGameId(gameA).toString("hex"), hashGameId(gameA).toString("hex"));
        assert.notEqual(hashGameId(gameA).toString("hex"), hashGameId(gameB).toString("hex"));

        const sharedRaw = "shared-identifier";
        const depositHash = hashDepositId(sharedRaw);
        const roomHash = hashRoomId(sharedRaw);
        const gameHash = hashGameId(sharedRaw);

        assert.notEqual(depositHash.toString("hex"), roomHash.toString("hex"));
        assert.notEqual(roomHash.toString("hex"), gameHash.toString("hex"));
        assert.notEqual(depositHash.toString("hex"), gameHash.toString("hex"));

        const manualDeposit = createHash("sha256")
            .update(Buffer.from(DOMAIN_DEPOSIT_ID, "utf8"))
            .update(Buffer.from([0x00]))
            .update(Buffer.from(sharedRaw, "utf8"))
            .digest("hex");

        assert.equal(depositHash.toString("hex"), manualDeposit);

        console.log("  Tests 8–14 hashing: OK");
    }

    // --- Test 15: same inputs => same address ---

    {
        const a = buildFixture();
        const b = buildFixture();

        assert.equal(a.addressFriendly, b.addressFriendly);
        assert.ok(a.address.equals(b.address));
        assert.equal(a.stateInit.code.hash().toString("hex"), b.stateInit.code.hash().toString("hex"));
        assert.equal(a.stateInit.data.hash().toString("hex"), b.stateInit.data.hash().toString("hex"));

        const recomputed = contractAddress(0, { code: a.code, data: a.data });
        assert.ok(recomputed.equals(a.address));

        console.log("  Test 15 same inputs same address: OK");
    }

    // --- Tests 16–27: field sensitivity ---

    {
        const base = buildFixture();

        const changeCases = [
            ["depositId", { depositId: "dep_6ba7b810-9dad-11d1-80b4-00c04fd430c8" }],
            ["roomId", { roomId: "room-other" }],
            ["gameId", { gameId: "game-other" }],
            ["player0", {
                players: [
                    { playerId: "seat0", wallet: WALLET_ALT, expectedStake: STAKE_NANO },
                    { playerId: "seat1", wallet: WALLET_1, expectedStake: STAKE_NANO },
                    { playerId: "seat2", wallet: WALLET_2, expectedStake: STAKE_NANO }
                ]
            }],
            ["player1", {
                players: [
                    { playerId: "seat0", wallet: WALLET_0, expectedStake: STAKE_NANO },
                    { playerId: "seat1", wallet: WALLET_ALT, expectedStake: STAKE_NANO },
                    { playerId: "seat2", wallet: WALLET_2, expectedStake: STAKE_NANO }
                ]
            }],
            ["player2", {
                players: [
                    { playerId: "seat0", wallet: WALLET_0, expectedStake: STAKE_NANO },
                    { playerId: "seat1", wallet: WALLET_1, expectedStake: STAKE_NANO },
                    { playerId: "seat2", wallet: WALLET_ALT, expectedStake: STAKE_NANO }
                ]
            }],
            ["expectedStake", {
                players: [
                    { playerId: "seat0", wallet: WALLET_0, expectedStake: STAKE_NANO + 1n },
                    { playerId: "seat1", wallet: WALLET_1, expectedStake: STAKE_NANO },
                    { playerId: "seat2", wallet: WALLET_2, expectedStake: STAKE_NANO }
                ]
            }],
            ["creationFeePerSeat", { creationFeePerSeat: FEE_NANO + 1n }],
            ["expiresAt", { expiresAt: EXPIRES_AT + 1n }],
            ["releaseAuthority", { releaseAuthority: ORACLE_B }],
            ["contractVersion", { contractVersion: 2 }],
            ["networkTag", { network: "mainnet", releaseAuthority: ORACLE_A }]
        ];

        for (const [label, overrides] of changeCases) {

            if (label === "contractVersion") {

                assertThrows(
                    () => buildFixture(overrides),
                    /DepositStateInitError/
                );

                continue;

            }

            const changed = buildFixture(overrides);
            assert.notEqual(
                changed.addressFriendly,
                base.addressFriendly,
                `expected address change for ${label}`
            );

        }

        console.log("  Tests 16–27 field sensitivity: OK");
    }

    // --- Test 28: invalid inputs ---

    {
        assertThrows(
            () => buildFixture({
                players: [
                    { playerId: "seat0", wallet: WALLET_0, expectedStake: STAKE_NANO },
                    { playerId: "seat1", wallet: WALLET_0, expectedStake: STAKE_NANO },
                    { playerId: "seat2", wallet: WALLET_2, expectedStake: STAKE_NANO }
                ]
            }),
            /InvalidDepositBindingError|DepositStateInitError/
        );

        assertThrows(
            () => buildFixture({
                players: [
                    { playerId: "seat0", wallet: "not-a-wallet", expectedStake: STAKE_NANO },
                    { playerId: "seat1", wallet: WALLET_1, expectedStake: STAKE_NANO },
                    { playerId: "seat2", wallet: WALLET_2, expectedStake: STAKE_NANO }
                ]
            }),
            /DepositStateInitError/
        );

        assertThrows(
            () => buildFixture({
                players: [
                    { playerId: "seat0", wallet: WALLET_0, expectedStake: STAKE_NANO },
                    { playerId: "seat1", wallet: WALLET_1, expectedStake: STAKE_NANO }
                ]
            }),
            /DepositStateInitError|InvalidDepositBindingError/
        );

        assertThrows(
            () => buildFixture({ creationFeePerSeat: -1n }),
            /DepositStateInitError/
        );

        assertThrows(
            () => buildFixture({ expiresAt: 0 }),
            /DepositStateInitError/
        );

        assertThrows(
            () => buildFixture({ network: "invalid-net" }),
            /DepositStateInitError/
        );

        assertThrows(
            () => buildFixture({
                releaseAuthority: null,
                env: {}
            }),
            /DepositStateInitError/
        );

        assertThrows(
            () => buildFixture({ depositId: "   " }),
            /DepositStateInitError/
        );

        assertThrows(
            () => buildFixture({
                players: [
                    { playerId: "seat0", wallet: WALLET_0, expectedStake: -1n },
                    { playerId: "seat1", wallet: WALLET_1, expectedStake: STAKE_NANO },
                    { playerId: "seat2", wallet: WALLET_2, expectedStake: STAKE_NANO }
                ]
            }),
            /DepositStateInitError/
        );

        console.log("  Test 28 invalid inputs: OK");
    }

    // --- Test 29: Tact-compatible data layout ---

    {
        const built = buildFixture();
        const decoded = loadDepositDataCell(built.data);

        assert.equal(decoded.contractVersion, DEPOSIT_CONTRACT_VERSION);
        assert.equal(
            decoded.depositIdHash.toString(16).padStart(64, "0"),
            built.depositIdHash
        );
        assert.equal(
            decoded.roomIdHash.toString(16).padStart(64, "0"),
            built.roomIdHash
        );
        assert.equal(
            decoded.gameIdHash.toString(16).padStart(64, "0"),
            built.gameIdHash
        );

        assert.equal(decoded.expectedStake0, STAKE_NANO);
        assert.equal(decoded.expectedStake1, STAKE_NANO);
        assert.equal(decoded.expectedStake2, STAKE_NANO);
        assert.equal(decoded.creationFeePerSeat, FEE_NANO);
        assert.equal(decoded.expiresAt, EXPIRES_AT);
        assert.equal(decoded.networkTag, BigInt(DEPOSIT_NETWORK_TAG_TESTNET));
        assert.equal(decoded.status, BigInt(DEPOSIT_STATUS_UNINITIALIZED));
        assert.equal(decoded.paidMask, 0n);
        assert.equal(decoded.creditedAmount0, 0n);
        assert.equal(decoded.creditedAmount1, 0n);
        assert.equal(decoded.creditedAmount2, 0n);
        assert.equal(decoded.surplusNano, 0n);
        assert.equal(decoded.refundMask, 0n);
        assert.equal(decoded.totalCredited, 0n);

        assert.equal(
            decoded.player0.toString({ bounceable: true, urlSafe: true }),
            WALLET_0
        );
        assert.equal(
            decoded.releaseAuthority.toString({ bounceable: true, urlSafe: true }),
            ORACLE_A
        );

        const roundtrip = buildDepositDataCell({
            contractVersion: decoded.contractVersion,
            depositIdHash: Buffer.from(decoded.depositIdHash.toString(16).padStart(64, "0"), "hex"),
            roomIdHash: Buffer.from(decoded.roomIdHash.toString(16).padStart(64, "0"), "hex"),
            gameIdHash: Buffer.from(decoded.gameIdHash.toString(16).padStart(64, "0"), "hex"),
            player0: decoded.player0,
            player1: decoded.player1,
            player2: decoded.player2,
            expectedStake0: decoded.expectedStake0,
            expectedStake1: decoded.expectedStake1,
            expectedStake2: decoded.expectedStake2,
            creationFeePerSeat: decoded.creationFeePerSeat,
            expiresAt: decoded.expiresAt,
            releaseAuthority: decoded.releaseAuthority,
            networkTag: Number(decoded.networkTag),
            status: Number(decoded.status),
            paidMask: Number(decoded.paidMask),
            creditedAmount0: decoded.creditedAmount0,
            creditedAmount1: decoded.creditedAmount1,
            creditedAmount2: decoded.creditedAmount2,
            surplusNano: decoded.surplusNano,
            refundMask: Number(decoded.refundMask),
            releasedTo: decoded.releasedTo,
            totalCredited: decoded.totalCredited
        });

        assert.equal(roundtrip.hash().toString("hex"), built.data.hash().toString("hex"));

        if (existsSync(join(CONTRACTS_DIR, "node_modules", "jest", "bin", "jest.js"))) {

            const jestBin = join(CONTRACTS_DIR, "node_modules", "jest", "bin", "jest.js");
            const jest = spawnSync(
                process.execPath,
                [
                    jestBin,
                    "--config",
                    "jest.config.cjs",
                    "-t",
                    "matches contractAddress",
                    "tests/DepositContract.spec.ts"
                ],
                {
                    cwd: CONTRACTS_DIR,
                    stdio: "pipe",
                    encoding: "utf8"
                }
            );

            assert.equal(
                jest.status,
                0,
                `DepositContract Tact address test failed:\n${jest.stdout}\n${jest.stderr}`
            );

        }

        console.log("  Test 29 Tact-compatible data layout: OK");
    }

    // --- Test 30: no randomness ---

    {
        const runs = Array.from({ length: 5 }, () => buildFixture());

        for (let index = 1; index < runs.length; index += 1) {

            assert.equal(runs[0].addressFriendly, runs[index].addressFriendly);
            assert.equal(
                runs[0].stateInit.code.hash().toString("hex"),
                runs[index].stateInit.code.hash().toString("hex")
            );
            assert.equal(
                runs[0].stateInit.data.hash().toString("hex"),
                runs[index].stateInit.data.hash().toString("hex")
            );

        }

        console.log("  Test 30 no randomness: OK");
    }

    // --- Test 31: different verified code => different address ---

    {
        const built = buildFixture();
        const alternateCode = loadGameEscrowCodeCell({ forceReload: true });

        assert.notEqual(
            alternateCode.hash().toString("hex"),
            built.code.hash().toString("hex")
        );

        const alternateAddress = contractAddress(0, {
            code: alternateCode,
            data: built.data
        });

        assert.notEqual(alternateAddress.toString(), built.address.toString());

        console.log("  Test 31 different code different address: OK");
    }

    // --- Cross-network mismatch rejection ---

    {
        const testnet = buildFixture({ network: "testnet" });
        const mainnet = buildFixture({
            network: "mainnet",
            releaseAuthority: ORACLE_A
        });

        assert.equal(testnet.networkTag, DEPOSIT_NETWORK_TAG_TESTNET);
        assert.equal(mainnet.networkTag, DEPOSIT_NETWORK_TAG_MAINNET);
        assert.notEqual(testnet.addressFriendly, mainnet.addressFriendly);

        console.log("  cross-network address separation: OK");
    }

    // --- Artifact metadata matches frozen hash ---

    {
        const hashed = hashDepositArtifactBoc();
        assert.equal(hashed.sha256, EXPECTED_SHA256);

        const meta = loadDepositArtifactExpectedMeta();
        assert.equal(meta.sha256, EXPECTED_SHA256);

        console.log("  artifact metadata frozen hash: OK");
    }

    console.log("depositStateInit.r179l12.test.js: all assertions passed");

}

main();
