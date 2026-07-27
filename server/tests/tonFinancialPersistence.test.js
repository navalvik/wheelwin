/**
 * T2.1 — TonFinancialPersistence tests.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    TonFinancialPersistence,
    TON_FINANCIAL_RECORD_TYPES
} from "../persistence/TonFinancialPersistence.js";
import {
    CorruptedRecordError,
    DuplicateRecordError,
    ImmutableRecordError,
    RecordNotFoundError,
    VersionMismatchError
} from "../persistence/TonFinancialPersistenceErrors.js";
import { computePayloadChecksum } from "../persistence/tonFinancialRecordUtils.js";
import { GAME_CONTRACT_STATUS } from "../models/GameContract.js";
import { PAYMENT_SESSION_STATUS } from "../models/PaymentSession.js";

function createMetadata(overrides = {}) {

    return {
        correlationId: "corr-1",
        roomId: "room-1",
        gameId: "game-1",
        contractId: "contract-1",
        tonNetwork: "testnet",
        status: "ACTIVE",
        ...overrides
    };

}

function createPersistence(dataDir, { autoCheckpoint = false } = {}) {

    const persistence = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint
    });

    persistence.initialize();

    return persistence;

}

function sampleGameContractPayload() {

    return {
        contractId: "contract-1",
        gameId: "game-1",
        roomId: "room-1",
        status: GAME_CONTRACT_STATUS.DEPLOYED,
        contractAddress: "EQcontract",
        snapshot: {
            gameId: "game-1",
            totalPot: 30,
            organizerFee: 1.5,
            payoutAmount: 28.5
        }
    };

}

function samplePaymentSessionPayload() {

    return {
        paymentSessionId: "pay-1",
        roomId: "room-1",
        gameId: "game-1",
        status: PAYMENT_SESSION_STATUS.ACTIVE,
        participants: [
            {
                playerId: "p1",
                requiredGram: 10,
                status: "WAITING"
            }
        ]
    };

}

async function main() {

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-ton-financial-"));

    // --- create record ---

    {
        const persistence = createPersistence(dataDir);

        const created = persistence.createGameContract(
            sampleGameContractPayload(),
            createMetadata({ status: GAME_CONTRACT_STATUS.DEPLOYED })
        );

        assert.equal(created.recordId, "contract-1");

        assert.equal(created.recordType, TON_FINANCIAL_RECORD_TYPES.GAME_CONTRACT);

        assert.equal(created.roomId, "room-1");

        assert.equal(created.tonNetwork, "testnet");

        assert.equal(created.immutable, false);

        assert.ok(created.checksum);

        persistence.shutdown({ checkpoint: true });

        console.log("  create record: OK");
    }

    // --- update record ---

    {
        const persistence = createPersistence(dataDir);

        const updated = persistence.updateGameContract(
            "contract-1",
            {
                ...sampleGameContractPayload(),
                status: GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS
            },
            createMetadata({ status: GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS })
        );

        assert.equal(
            updated.payload.status,
            GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS
        );

        assert.ok(updated.updatedAt >= updated.createdAt);

        persistence.shutdown();

        console.log("  update record: OK");
    }

    // --- load record ---

    {
        const persistence = createPersistence(dataDir);

        const loaded = persistence.loadGameContract("contract-1");

        assert.equal(loaded.recordId, "contract-1");

        assert.equal(
            loaded.payload.status,
            GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS
        );

        persistence.shutdown();

        console.log("  load record: OK");
    }

    // --- restore after restart ---

    {
        const persistence = createPersistence(dataDir);

        const summary = persistence.restore();

        assert.ok(summary.recordCount >= 1);

        const restored = persistence.loadGameContract("contract-1");

        assert.equal(restored.gameId, "game-1");

        persistence.shutdown();

        console.log("  restore after restart: OK");
    }

    // --- payment session + wallet session ---

    {
        const persistence = createPersistence(dataDir);

        persistence.createPaymentSession(
            samplePaymentSessionPayload(),
            createMetadata({
                status: PAYMENT_SESSION_STATUS.ACTIVE,
                paymentSessionId: "pay-1"
            })
        );

        persistence.createWalletSession(
            {
                roomId: "room-1",
                paymentConnectionReady: true,
                players: [
                    {
                        playerId: "p1",
                        connectedWallet: "EQwallet1",
                        status: "CONNECTED"
                    }
                ]
            },
            createMetadata({ status: "CONNECTED" })
        );

        const byRoom = persistence.findByRoom("room-1");

        assert.ok(byRoom.length >= 3);

        const byGame = persistence.findByGame("game-1");

        assert.ok(byGame.length >= 2);

        persistence.shutdown();

        console.log("  payment + wallet session: OK");
    }

    // --- recovery checkpoint ---

    {
        const persistence = createPersistence(dataDir);

        const checkpoint = persistence.createRecoveryCheckpoint(
            {
                checkpointId: "chk-1",
                phase: "payments",
                roomId: "room-1",
                gameId: "game-1"
            },
            createMetadata({
                checkpointId: "chk-1",
                status: "OPEN"
            })
        );

        assert.equal(checkpoint.recordId, "chk-1");

        persistence.deleteRecoveryCheckpoint("chk-1");

        assert.throws(
            () => persistence.loadRecoveryCheckpoint("chk-1"),
            RecordNotFoundError
        );

        persistence.shutdown();

        console.log("  recovery checkpoint: OK");
    }

    // --- immutable snapshot + audit ---

    {
        const persistence = createPersistence(dataDir);

        const snapshot = persistence.createSnapshotRecord(
            {
                snapshotHash: "abc123",
                gameId: "game-1",
                roomId: "room-1",
                totalPot: 30
            },
            createMetadata({
                snapshotId: "abc123",
                status: "FROZEN"
            })
        );

        assert.equal(snapshot.immutable, true);

        assert.throws(
            () => persistence.update(
                TON_FINANCIAL_RECORD_TYPES.SNAPSHOT,
                "abc123",
                { totalPot: 99 },
                createMetadata()
            ),
            ImmutableRecordError
        );

        const audit = persistence.createAuditRecord(
            {
                auditId: "audit-1",
                action: "SETTLEMENT_COMPLETED",
                contractId: "contract-1"
            },
            createMetadata({
                auditId: "audit-1",
                status: "RECORDED"
            })
        );

        assert.equal(audit.immutable, true);

        persistence.shutdown();

        console.log("  immutable snapshot + audit: OK");
    }

    // --- settlement becomes immutable when completed ---

    {
        const persistence = createPersistence(dataDir);

        persistence.createSettlementRecord(
            {
                gameId: "game-1",
                contractId: "contract-1",
                status: GAME_CONTRACT_STATUS.SETTLEMENT_PENDING,
                winnerId: "p1",
                winnerAmount: 28.5
            },
            createMetadata({ status: GAME_CONTRACT_STATUS.SETTLEMENT_PENDING })
        );

        const completed = persistence.updateSettlementRecord(
            "game-1",
            {
                gameId: "game-1",
                contractId: "contract-1",
                status: GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED,
                winnerId: "p1",
                winnerAmount: 28.5,
                settlementTxHash: "tx-settle-1"
            },
            createMetadata({ status: GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED })
        );

        assert.equal(completed.immutable, true);

        assert.throws(
            () => persistence.updateSettlementRecord(
                "game-1",
                { status: GAME_CONTRACT_STATUS.SETTLEMENT_FAILED },
                createMetadata()
            ),
            ImmutableRecordError
        );

        persistence.shutdown();

        console.log("  settlement immutability: OK");
    }

    // --- archive record ---

    {
        const persistence = createPersistence(dataDir);

        const archived = persistence.archive("contract-1", {
            archiveReason: "game_complete",
            correlationId: "corr-archive"
        });

        assert.equal(archived.recordType, TON_FINANCIAL_RECORD_TYPES.ARCHIVED_CONTRACT);

        assert.equal(archived.immutable, true);

        assert.throws(
            () => persistence.loadGameContract("contract-1"),
            RecordNotFoundError
        );

        const archivedLookup = persistence.loadArchivedContract("contract-1");

        assert.equal(archivedLookup.payload.archiveReason, "game_complete");

        const archivedList = persistence.listArchived();

        assert.ok(archivedList.some((entry) => entry.recordId === "contract-1"));

        persistence.shutdown();

        console.log("  archive record: OK");
    }

    // --- integrity validation ---

    {
        const persistence = createPersistence(dataDir);

        const report = persistence.integrityCheck();

        assert.equal(report.ok, true);

        assert.equal(report.errors.length, 0);

        persistence.shutdown();

        console.log("  integrity validation: OK");
    }

    // --- corrupted data detection ---

    {
        const persistence = createPersistence(dataDir);

        persistence.createPaymentSession(
            {
                paymentSessionId: "pay-corrupt",
                roomId: "room-2",
                gameId: "game-2",
                status: PAYMENT_SESSION_STATUS.ACTIVE,
                participants: []
            },
            createMetadata({
                roomId: "room-2",
                gameId: "game-2",
                contractId: "contract-2",
                paymentSessionId: "pay-corrupt"
            })
        );

        const corruptPath = join(
            dataDir,
            "active",
            TON_FINANCIAL_RECORD_TYPES.PAYMENT_SESSION,
            "pay-corrupt.json"
        );

        const envelope = JSON.parse(readFileSync(corruptPath, "utf8"));

        envelope.checksum = "invalid";

        writeFileSync(corruptPath, JSON.stringify(envelope, null, 2));

        assert.throws(
            () => createPersistence(dataDir),
            CorruptedRecordError
        );

        envelope.checksum = computePayloadChecksum(envelope.payload);

        writeFileSync(corruptPath, `${JSON.stringify(envelope, null, 2)}\n`);

        console.log("  corrupted data detection: OK");
    }

    // --- duplicate detection ---

    {
        const persistence = createPersistence(dataDir);

        assert.throws(
            () => persistence.createPaymentSession(
                samplePaymentSessionPayload(),
                createMetadata({ paymentSessionId: "pay-1" })
            ),
            DuplicateRecordError
        );

        persistence.shutdown();

        console.log("  duplicate detection: OK");
    }

    // --- version mismatch ---

    {
        const persistence = createPersistence(dataDir);

        assert.throws(
            () => persistence.updatePaymentSession(
                "pay-1",
                samplePaymentSessionPayload(),
                {
                    ...createMetadata(),
                    expectedVersion: 99
                }
            ),
            VersionMismatchError
        );

        persistence.shutdown();

        console.log("  version mismatch: OK");
    }

    // --- checkpoint ---

    {
        const persistence = new TonFinancialPersistence({
            dataDir,
            autoCheckpoint: false
        });

        persistence.initialize();

        const manifest = persistence.checkpoint({ reason: "test" });

        assert.equal(manifest.reason, "test");

        assert.ok(manifest.recordCount >= 1);

        persistence.shutdown({ checkpoint: false });

        console.log("  checkpoint: OK");
    }

    // --- list active ---

    {
        const persistence = createPersistence(dataDir);

        const activeContracts = persistence.listActive(
            TON_FINANCIAL_RECORD_TYPES.PAYMENT_SESSION
        );

        assert.ok(activeContracts.some((entry) => entry.recordId === "pay-1"));

        const byContract = persistence.findByContract("contract-1");

        assert.ok(byContract.some(
            (entry) => entry.recordType === TON_FINANCIAL_RECORD_TYPES.ARCHIVED_CONTRACT
        ));

        persistence.shutdown();

        console.log("  list active + find by contract: OK");
    }

    // --- integrity failure report ---

    {
        const persistence = createPersistence(dataDir);

        const key = "payment_session:pay-1";

        const internal = persistence._records.get(key);

        internal.checksum = "broken";

        persistence._records.set(key, internal);

        const report = persistence.integrityCheck();

        assert.equal(report.ok, false);

        assert.ok(report.errors.length > 0);

        persistence.shutdown();

        console.log("  integrity failure report: OK");
    }

    TonFinancialPersistence.destroyStorage(dataDir);

    console.log("tonFinancialPersistence tests passed");
}

main().catch((error) => {

    console.error(error);

    process.exit(1);

});
