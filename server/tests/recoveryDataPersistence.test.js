/**
 * R17.9T.6-C — Recovery Data Persistence tests.
 *
 * Focused tests for the Recovery Data Contract persistence layer.
 * Tests verify:
 *   1. create + load round-trip;
 *   2. checksum validation;
 *   3. checksum corruption rejection;
 *   4. immutable terminal record cannot be modified;
 *   5. mutable recovery record can be updated;
 *   6. incompatible version fails closed;
 *   7. unknown compatible fields are preserved;
 *   8. atomic write path is used;
 *   9. original IDs survive persistence;
 *  10. financial fields are stored only as references, not duplicated as financial authority.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    TonFinancialPersistence,
    TON_FINANCIAL_RECORD_TYPES
} from "../persistence/TonFinancialPersistence.js";
import {
    CorruptedRecordError,
    ImmutableRecordError,
    TonFinancialPersistenceError
} from "../persistence/TonFinancialPersistenceErrors.js";
import {
    RecoveryDataPersistence,
    RECOVERY_CONTRACT_VERSION
} from "../persistence/RecoveryDataPersistence.js";
import {
    computePayloadChecksum
} from "../persistence/tonFinancialRecordUtils.js";

// -------------------------------------------------------------------------
// Test helpers
// -------------------------------------------------------------------------

function createPersistence(dataDir) {

    const financialPersistence = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint: false
    });

    financialPersistence.initialize();

    return new RecoveryDataPersistence({ financialPersistence });

}

function sampleConfiguration() {

    return Object.freeze({
        configurationVersion: "1.0",
        stake: 1,
        wheel: {
            startAngle: 42,
            sectors: [
                { sectorId: "s0", ownerId: "p0", color: "red", colorId: 0, icon: "star", angleStart: 0, angleEnd: 120 },
                { sectorId: "s1", ownerId: "p1", color: "blue", colorId: 1, icon: "circle", angleStart: 120, angleEnd: 240 },
                { sectorId: "s2", ownerId: "p2", color: "green", colorId: 2, icon: "square", angleStart: 240, angleEnd: 360 }
            ]
        },
        triangle: {
            startAngle: 17
        },
        polarAxis: "north",
        traceSeed: "trace-abc-123"
    });

}

function samplePlayers() {

    return [
        {
            playerId: "player_001",
            playerIndex: 0,
            wallet: "EQwallet001",
            nickname: "Alice",
            baseStake: 1,
            sectorCount: 1,
            color: "red",
            colorSector2: null,
            icon: "star",
            sectorArrangement: "single",
            age: 25
        },
        {
            playerId: "player_002",
            playerIndex: 1,
            wallet: "EQwallet002",
            nickname: "Bob",
            baseStake: 1,
            sectorCount: 1,
            color: "blue",
            colorSector2: null,
            icon: "circle",
            sectorArrangement: "single",
            age: 30
        },
        {
            playerId: "player_003",
            playerIndex: 2,
            wallet: "EQwallet003",
            nickname: "Carol",
            baseStake: 1,
            sectorCount: 1,
            color: "green",
            colorSector2: null,
            icon: "square",
            sectorArrangement: "single",
            age: 28
        }
    ];

}

function sampleActiveRecoveryData(overrides = {}) {

    const configuration = sampleConfiguration();

    const configurationHash = computePayloadChecksum(configuration);

    return {
        recoveryRecordId: "game-recovery-001",
        roomId: "room-001",
        gameId: "game-001",
        contractId: "contract_001",
        paymentSessionId: "pay-001",
        tonNetwork: "testnet",
        correlationId: "corr-001",
        recoveryContractVersion: RECOVERY_CONTRACT_VERSION,
        schemaVersion: 1,
        configuration,
        configurationHash,
        configurationVersion: "1.0",
        traceSeed: "trace-abc-123",
        snapshotHash: "snapshot-hash-001",
        players: samplePlayers(),
        gameState: "PRE_GAME_READY",
        gameStatus: "INITIALIZED",
        phaseStartedAt: Date.now(),
        clockStartedAt: Date.now(),
        clockPaused: false,
        clockTotalPausedMs: 0,
        awaitingResultActivation: false,
        resultPhaseStarted: false,
        serverTimestampAtCheckpoint: Date.now(),
        contractAddress: "EQcontract001",
        winnerId: null,
        ...overrides
    };

}

function sampleTerminalRecoveryData(overrides = {}) {

    const configuration = sampleConfiguration();

    const configurationHash = computePayloadChecksum(configuration);

    return {
        recoveryRecordId: "game-recovery-002",
        roomId: "room-002",
        gameId: "game-002",
        contractId: "contract_002",
        paymentSessionId: "pay-002",
        tonNetwork: "testnet",
        correlationId: "corr-002",
        recoveryContractVersion: RECOVERY_CONTRACT_VERSION,
        schemaVersion: 1,
        configuration,
        configurationHash,
        configurationVersion: "1.0",
        traceSeed: "trace-xyz-789",
        snapshotHash: "snapshot-hash-002",
        players: samplePlayers(),
        gameState: "RESULT",
        gameStatus: "FINISHED",
        serverTimestampAtCheckpoint: Date.now(),
        contractAddress: "EQcontract002",
        winnerId: "player_001",
        physicsFinalAngle: 3.14159,
        physicsFinalTriangleAngle: 1.5708,
        physicsSimulationState: "STOPPED",
        ...overrides
    };

}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

async function main() {

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-recovery-data-"));

    // --- 1. create + load round-trip ---

    {
        const recovery = createPersistence(dataDir);

        const data = sampleActiveRecoveryData();

        const created = recovery.createRecoveryRecord(data);

        assert.equal(created.recordId, "game-recovery-001");

        assert.equal(created.recordType, TON_FINANCIAL_RECORD_TYPES.RECOVERY_DATA);

        assert.equal(created.immutable, false);

        const loaded = recovery.loadRecoveryRecord("game-recovery-001");

        assert.ok(loaded !== null);

        assert.equal(loaded.payload.gameId, "game-001");

        assert.equal(loaded.payload.roomId, "room-001");

        assert.equal(loaded.payload.gameState, "PRE_GAME_READY");

        assert.equal(loaded.payload.players.length, 3);

        console.log("  1. create + load round-trip: OK");
    }

    // --- 2. checksum validation ---

    {
        const recovery = createPersistence(dataDir);

        const loaded = recovery.loadRecoveryRecord("game-recovery-001");

        assert.ok(loaded !== null);

        // Verify checksum matches payload
        const expectedChecksum = computePayloadChecksum(loaded.payload);

        assert.equal(loaded.checksum, expectedChecksum);

        // Validate via the validation API
        const result = recovery.validateRecoveryRecord(loaded);

        assert.equal(result.valid, true);

        assert.equal(result.errors.length, 0);

        console.log("  2. checksum validation: OK");
    }

    // --- 3. checksum corruption rejection ---

    {
        const recovery = createPersistence(dataDir);

        // Corrupt the record on disk
        const filePath = join(
            dataDir,
            "active",
            TON_FINANCIAL_RECORD_TYPES.RECOVERY_DATA,
            "game-recovery-001.json"
        );

        const envelope = JSON.parse(readFileSync(filePath, "utf8"));

        envelope.checksum = "corrupted_checksum_value";

        writeFileSync(filePath, JSON.stringify(envelope, null, 2));

        // Re-initialize persistence to reload from disk
        const financialPersistence = new TonFinancialPersistence({
            dataDir,
            autoCheckpoint: false
        });

        // restore() should throw CorruptedRecordError on corrupted checksum
        assert.throws(
            () => financialPersistence.initialize(),
            CorruptedRecordError
        );

        // Restore the file to valid state
        envelope.checksum = computePayloadChecksum(envelope.payload);

        writeFileSync(filePath, `${JSON.stringify(envelope, null, 2)}\n`);

        console.log("  3. checksum corruption rejection: OK");
    }

    // --- 4. immutable terminal record cannot be modified ---

    {
        const recovery = createPersistence(dataDir);

        const terminalData = sampleTerminalRecoveryData();

        const created = recovery.createRecoveryRecord(terminalData, { status: "TERMINAL" });

        assert.equal(created.immutable, true);

        // Attempt to update should throw ImmutableRecordError
        assert.throws(
            () => recovery.updateRecoveryRecord(
                "game-recovery-002",
                { ...terminalData, gameState: "SPEED" }
            ),
            ImmutableRecordError
        );

        console.log("  4. immutable terminal record cannot be modified: OK");
    }

    // --- 5. mutable recovery record can be updated ---

    {
        const recovery = createPersistence(dataDir);

        const loaded = recovery.loadRecoveryRecord("game-recovery-001");

        assert.ok(loaded !== null);

        assert.equal(loaded.immutable, false);

        const updatedData = {
            ...loaded.payload,
            gameState: "READY",
            phaseStartedAt: Date.now(),
            clockPaused: true,
            clockTotalPausedMs: 5000
        };

        const updated = recovery.updateRecoveryRecord("game-recovery-001", updatedData);

        assert.equal(updated.payload.gameState, "READY");

        assert.equal(updated.payload.clockPaused, true);

        assert.equal(updated.payload.clockTotalPausedMs, 5000);

        assert.ok(updated.updatedAt >= loaded.updatedAt);

        // Verify the update persisted
        const reloaded = recovery.loadRecoveryRecord("game-recovery-001");

        assert.equal(reloaded.payload.gameState, "READY");

        console.log("  5. mutable recovery record can be updated: OK");
    }

    // --- 6. incompatible version fails closed ---

    {
        const recovery = createPersistence(dataDir);

        const incompatibleData = sampleActiveRecoveryData({
            recoveryRecordId: "game-recovery-003",
            gameId: "game-003",
            roomId: "room-003",
            contractId: "contract_003",
            paymentSessionId: "pay-003",
            recoveryContractVersion: 99 // Future incompatible version
        });

        assert.throws(
            () => recovery.createRecoveryRecord(incompatibleData),
            TonFinancialPersistenceError
        );

        // Also test schema version mismatch
        const schemaMismatchData = sampleActiveRecoveryData({
            recoveryRecordId: "game-recovery-004",
            gameId: "game-004",
            roomId: "room-004",
            contractId: "contract_004",
            paymentSessionId: "pay-004",
            schemaVersion: 99
        });

        assert.throws(
            () => recovery.createRecoveryRecord(schemaMismatchData),
            TonFinancialPersistenceError
        );

        console.log("  6. incompatible version fails closed: OK");
    }

    // --- 7. unknown compatible fields are preserved ---

    {
        const recovery = createPersistence(dataDir);

        const dataWithExtra = sampleActiveRecoveryData({
            recoveryRecordId: "game-recovery-005",
            gameId: "game-005",
            roomId: "room-005",
            contractId: "contract_005",
            paymentSessionId: "pay-005",
            futureFieldA: "some future value",
            futureFieldB: { nested: "object" }
        });

        const created = recovery.createRecoveryRecord(dataWithExtra);

        // Unknown fields must be preserved (not silently discarded)
        assert.equal(created.payload.futureFieldA, "some future value");

        assert.deepEqual(created.payload.futureFieldB, { nested: "object" });

        const loaded = recovery.loadRecoveryRecord("game-recovery-005");

        assert.equal(loaded.payload.futureFieldA, "some future value");

        assert.deepEqual(loaded.payload.futureFieldB, { nested: "object" });

        console.log("  7. unknown compatible fields are preserved: OK");
    }

    // --- 8. atomic write path is used ---

    {
        const recovery = createPersistence(dataDir);

        const data = sampleActiveRecoveryData({
            recoveryRecordId: "game-recovery-006",
            gameId: "game-006",
            roomId: "room-006",
            contractId: "contract_006",
            paymentSessionId: "pay-006"
        });

        recovery.createRecoveryRecord(data);

        // Verify the record file exists (atomic write completed)
        const filePath = join(
            dataDir,
            "active",
            TON_FINANCIAL_RECORD_TYPES.RECOVERY_DATA,
            "game-recovery-006.json"
        );

        assert.ok(existsSync(filePath), "Recovery record file should exist after atomic write");

        // Verify no temp files remain
        const dir = join(dataDir, "active", TON_FINANCIAL_RECORD_TYPES.RECOVERY_DATA);

        const files = readdirSync(dir);

        const tempFiles = files.filter((f) => f.endsWith(".tmp"));

        assert.equal(tempFiles.length, 0, "No temp files should remain after atomic write");

        console.log("  8. atomic write path is used: OK");
    }

    // --- 9. original IDs survive persistence ---

    {
        const recovery = createPersistence(dataDir);

        const data = sampleActiveRecoveryData({
            recoveryRecordId: "game-recovery-007",
            roomId: "room-original-007",
            gameId: "game-original-007",
            contractId: "contract_original_007",
            paymentSessionId: "pay-original-007"
        });

        recovery.createRecoveryRecord(data);

        const loaded = recovery.loadRecoveryRecord("game-recovery-007");

        assert.ok(loaded !== null);

        // All original IDs must survive persistence
        assert.equal(loaded.payload.roomId, "room-original-007");

        assert.equal(loaded.payload.gameId, "game-original-007");

        assert.equal(loaded.payload.contractId, "contract_original_007");

        assert.equal(loaded.payload.paymentSessionId, "pay-original-007");

        assert.equal(loaded.payload.recoveryRecordId, "game-recovery-007");

        // Player IDs must also survive
        assert.equal(loaded.payload.players[0].playerId, "player_001");

        assert.equal(loaded.payload.players[1].playerId, "player_002");

        assert.equal(loaded.payload.players[2].playerId, "player_003");

        // Player indices must survive
        assert.equal(loaded.payload.players[0].playerIndex, 0);

        assert.equal(loaded.payload.players[1].playerIndex, 1);

        assert.equal(loaded.payload.players[2].playerIndex, 2);

        console.log("  9. original IDs survive persistence: OK");
    }

    // --- 10. financial fields are stored only as references, not duplicated ---

    {
        const recovery = createPersistence(dataDir);

        // Attempt to create a record with forbidden financial authority fields
        const dataWithFinancialDuplication = sampleActiveRecoveryData({
            recoveryRecordId: "game-recovery-008",
            gameId: "game-008",
            roomId: "room-008",
            contractId: "contract_008",
            paymentSessionId: "pay-008",
            paymentStatus: "COMPLETED", // FORBIDDEN - financial authority
            paidAmount: 10, // FORBIDDEN - financial authority
            confirmationStatus: "CONFIRMED" // FORBIDDEN - financial authority
        });

        assert.throws(
            () => recovery.createRecoveryRecord(dataWithFinancialDuplication),
            TonFinancialPersistenceError
        );

        // Verify that financial reference fields ARE allowed (contractId, paymentSessionId, snapshotHash, etc.)
        const validData = sampleActiveRecoveryData({
            recoveryRecordId: "game-recovery-009",
            gameId: "game-009",
            roomId: "room-009",
            contractId: "contract_009",
            paymentSessionId: "pay-009"
        });

        const created = recovery.createRecoveryRecord(validData);

        // Financial references are stored (not duplicated as authority)
        assert.equal(created.payload.contractId, "contract_009");

        assert.equal(created.payload.paymentSessionId, "pay-009");

        assert.equal(created.payload.snapshotHash, "snapshot-hash-001");

        assert.equal(created.payload.contractAddress, "EQcontract001");

        // No financial authority fields present
        assert.equal("paymentStatus" in created.payload, false);

        assert.equal("paidAmount" in created.payload, false);

        assert.equal("confirmationStatus" in created.payload, false);

        assert.equal("refundTxHash" in created.payload, false);

        assert.equal("settlementTransactionHash" in created.payload, false);

        console.log("  10. financial fields stored as references only: OK");
    }

    // --- Additional: list recovery records ---

    {
        const recovery = createPersistence(dataDir);

        const records = recovery.listRecoveryRecords();

        assert.ok(records.length >= 5, "Should list multiple recovery records");

        // All listed records should be valid
        for (const record of records) {

            const result = recovery.validateRecoveryRecord(record);

            assert.equal(result.valid, true, `Record ${record.recordId} should be valid`);

        }

        console.log("  list recovery records: OK");
    }

    // --- Additional: load non-existent record returns null ---

    {
        const recovery = createPersistence(dataDir);

        const loaded = recovery.loadRecoveryRecord("non-existent-record");

        assert.equal(loaded, null);

        console.log("  load non-existent record returns null: OK");
    }

    // --- Additional: missing required identity field fails closed ---

    {
        const recovery = createPersistence(dataDir);

        const missingIdentity = sampleActiveRecoveryData({
            recoveryRecordId: "game-recovery-010",
            gameId: "game-010",
            roomId: null, // Missing required identity field
            contractId: "contract_010",
            paymentSessionId: "pay-010"
        });

        assert.throws(
            () => recovery.createRecoveryRecord(missingIdentity),
            TonFinancialPersistenceError
        );

        console.log("  missing required identity fails closed: OK");
    }

    // --- Additional: missing required configuration fails closed ---

    {
        const recovery = createPersistence(dataDir);

        const missingConfig = sampleActiveRecoveryData({
            recoveryRecordId: "game-recovery-011",
            gameId: "game-011",
            roomId: "room-011",
            contractId: "contract_011",
            paymentSessionId: "pay-011",
            configuration: null // Missing required configuration
        });

        assert.throws(
            () => recovery.createRecoveryRecord(missingConfig),
            TonFinancialPersistenceError
        );

        console.log("  missing required configuration fails closed: OK");
    }

    // --- Additional: invalid configurationHash fails closed ---

    {
        const recovery = createPersistence(dataDir);

        const invalidHash = sampleActiveRecoveryData({
            recoveryRecordId: "game-recovery-012",
            gameId: "game-012",
            roomId: "room-012",
            contractId: "contract_012",
            paymentSessionId: "pay-012",
            configurationHash: "invalid_hash_value" // Does not match configuration
        });

        assert.throws(
            () => recovery.createRecoveryRecord(invalidHash),
            TonFinancialPersistenceError
        );

        console.log("  invalid configurationHash fails closed: OK");
    }

    // --- Cleanup ---

    TonFinancialPersistence.destroyStorage(dataDir);

    console.log("recoveryDataPersistence tests passed");
}

main().catch((error) => {

    console.error(error);

    process.exit(1);

});