import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

import {
    CorruptedRecordError,
    ImmutableRecordError,
    RecoveryDataError,
    RecoveryDataPersistence
} from "../persistence/RecoveryDataPersistence.js";
import { computeConfigurationHash } from "../recovery/configurationHash.js";

function makePayload({ id = "recovery-game-1", terminal = false } = {}) {
    const roomId = "recovery-room-1";
    const configuration = { traceSeed: 4, metadata: { roomId }, gameId: id };
    const payload = {
        recoveryContractVersion: 1,
        recoveryRecordId: id,
        roomId,
        gameId: id,
        configuration,
        configurationHash: computeConfigurationHash(configuration),
        configurationVersion: "1",
        traceSeed: 4,
        gameState: terminal ? "RESULT" : "READY",
        gameStatus: terminal ? "FINISHED" : "IN_PROGRESS",
        serverTimestampAtCheckpoint: Date.now(),
        players: [0, 1, 2].map((playerIndex) => ({
            playerId: `player-${playerIndex}`,
            playerIndex,
            nickname: `Player ${playerIndex}`,
            sectorCount: 6,
            color: "red",
            colorSector2: "blue",
            icon: "star",
            sectorArrangement: [0, 1, 2, 3, 4, 5],
            age: 20
        })),
        phaseStartedAt: Date.now(),
        clockStartedAt: Date.now(),
        clockPaused: false,
        clockTotalPausedMs: 0,
        awaitingResultActivation: false,
        resultPhaseStarted: terminal
    };
    if (terminal) {
        Object.assign(payload, {
            physicsFinalAngle: 1,
            physicsFinalTriangleAngle: 1,
            physicsSimulationState: "STOPPED"
        });
    }
    return payload;
}

test("recovery records survive persistence reconstruction and remain network isolated", () => {
    const testnetDir = mkdtempSync(join(tmpdir(), "wheelwin-testnet-recovery-"));
    const mainnetDir = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-recovery-"));
    const payload = makePayload();

    const writer = new RecoveryDataPersistence({ dataDir: testnetDir });
    writer.createRecoveryRecord(payload);

    const restarted = new RecoveryDataPersistence({ dataDir: testnetDir });
    assert.equal(restarted.loadRecoveryRecord(payload.gameId)?.payload.gameId, payload.gameId);
    assert.equal(restarted.listRecoveryRecords().length, 1);
    assert.equal(new RecoveryDataPersistence({ dataDir: mainnetDir }).listRecoveryRecords().length, 0);
    assert.throws(() => restarted.createRecoveryRecord(payload), RecoveryDataError);
});

test("recovery persistence rejects corrupted checksums and does not list them", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-corrupt-recovery-"));
    const payload = makePayload();
    new RecoveryDataPersistence({ dataDir }).createRecoveryRecord(payload);
    const path = join(dataDir, `${createHash("sha256").update(payload.gameId).digest("hex")}.json`);
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.payload.gameStatus = "FINISHED";
    writeFileSync(path, JSON.stringify(record), "utf8");

    const restarted = new RecoveryDataPersistence({ dataDir });
    assert.throws(() => restarted.loadRecoveryRecord(payload.gameId), CorruptedRecordError);
    assert.equal(restarted.listRecoveryRecords().length, 0);
});

test("terminal recovery records remain immutable and financial fields are rejected", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-terminal-recovery-"));
    const store = new RecoveryDataPersistence({ dataDir });
    const payload = makePayload({ terminal: true });
    store.createRecoveryRecord(payload, { status: "TERMINAL" });
    const reopened = new RecoveryDataPersistence({ dataDir });
    const record = reopened.listRecoveryRecords()[0];
    assert.equal(record.status, "TERMINAL");
    assert.throws(() => reopened.updateRecoveryRecord(payload.gameId, payload), ImmutableRecordError);
    assert.throws(() => store.createRecoveryRecord({ ...makePayload({ id: "financial-game" }), walletAddress: "x" }), RecoveryDataError);
});

test("unsupported recovery record versions fail closed", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-old-recovery-"));
    const payload = makePayload();
    new RecoveryDataPersistence({ dataDir }).createRecoveryRecord(payload);
    const path = join(dataDir, `${createHash("sha256").update(payload.gameId).digest("hex")}.json`);
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.version = 0;
    writeFileSync(path, JSON.stringify(record), "utf8");

    const restarted = new RecoveryDataPersistence({ dataDir });
    assert.throws(() => restarted.loadRecoveryRecord(payload.gameId), CorruptedRecordError);
    assert.equal(restarted.listRecoveryRecords().length, 0);
});

test("configuration hashes use canonical key ordering", () => {
    assert.equal(
        computeConfigurationHash({ a: 1, nested: { z: 2, b: 3 } }),
        computeConfigurationHash({ nested: { b: 3, z: 2 }, a: 1 })
    );
});
