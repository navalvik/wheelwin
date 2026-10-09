import assert from "node:assert/strict";
import {
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    CorruptedRecordError,
    TonFinancialPersistence,
    TON_FINANCIAL_RECORD_TYPES
} from "../persistence/TonFinancialPersistence.js";
import {
    computePayloadChecksum,
    validateRecordEnvelope
} from "../persistence/tonFinancialRecordUtils.js";

const GAME_ID = "game_legacy_escrowmode_migration_test";

function createLogger() {
    return {
        info() {},
        warn() {},
        error() {},
        debug() {}
    };
}

function createPersistence(dataDir) {
    return new TonFinancialPersistence({
        dataDir,
        logger: createLogger(),
        autoCheckpoint: false
    });
}

test("restore repairs only the exact undefined gameEscrowMode checksum defect and backs up the original", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ww-legacy-escrow-repair-"));
    const logger = createLogger();
    const first = createPersistence(dataDir);
    let second = null;

    try {
        first.initialize();
        first.create(
            TON_FINANCIAL_RECORD_TYPES.SETTLEMENT,
            {
                gameId: GAME_ID,
                status: "SETTLEMENT_FAILED",
                payoutAmountNano: "2850000000",
                request: {
                    winnerId: "player_test",
                    payoutAmountNano: "2850000000",
                    gameEscrowMode: undefined
                }
            },
            {
                gameId: GAME_ID,
                status: "SETTLEMENT_FAILED"
            }
        );

        const filePath = join(dataDir, "active", "settlement", `${GAME_ID}.json`);
        const originalBytes = readFileSync(filePath);
        const originalText = originalBytes.toString("utf8");
        const originalEnvelope = JSON.parse(originalText);

        assert.equal(
            Object.prototype.hasOwnProperty.call(originalEnvelope.payload.request, "gameEscrowMode"),
            false
        );
        assert.deepEqual(validateRecordEnvelope(originalEnvelope), ["checksum_mismatch"]);

        first.shutdown({ checkpoint: false });
        second = createPersistence(dataDir);
        second.initialize();

        const repaired = second.loadSettlementRecord(GAME_ID);
        assert.equal(repaired.payload.request.gameEscrowMode, "game");
        assert.equal(repaired.payload.status, originalEnvelope.payload.status);
        assert.equal(repaired.payload.payoutAmountNano, originalEnvelope.payload.payoutAmountNano);
        assert.equal(
            repaired.payload.request.payoutAmountNano,
            originalEnvelope.payload.request.payoutAmountNano
        );

        const expectedPayload = {
            ...originalEnvelope.payload,
            request: {
                ...originalEnvelope.payload.request,
                gameEscrowMode: "game"
            }
        };
        assert.deepEqual(repaired.payload, expectedPayload);
        assert.deepEqual(validateRecordEnvelope(repaired), []);
        assert.equal(repaired.checksum, computePayloadChecksum(repaired.payload));
        assert.notEqual(repaired.checksum, originalEnvelope.checksum);

        const backupNames = readdirSync(join(dataDir, "active", "settlement"))
            .filter((name) => name.includes(".pre-room-wallet-escrow-repair-") && name.endsWith(".bak"));
        assert.equal(backupNames.length, 1);
        assert.deepEqual(
            readFileSync(join(dataDir, "active", "settlement", backupNames[0])),
            originalBytes
        );
    } finally {
        try { first.shutdown({ checkpoint: false }); } catch {}
        try { second?.shutdown({ checkpoint: false }); } catch {}
        rmSync(dataDir, { recursive: true, force: true });
    }
});

test("restore leaves other settlement checksum corruption untouched and fails closed", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ww-legacy-escrow-failclosed-"));
    const first = createPersistence(dataDir);
    let second = null;

    try {
        first.initialize();
        first.create(
            TON_FINANCIAL_RECORD_TYPES.SETTLEMENT,
            {
                gameId: GAME_ID,
                status: "SETTLEMENT_FAILED",
                request: {
                    winnerId: "player_test",
                    amountNano: "1000000000"
                }
            },
            {
                gameId: GAME_ID,
                status: "SETTLEMENT_FAILED"
            }
        );

        const filePath = join(dataDir, "active", "settlement", `${GAME_ID}.json`);
        const envelope = JSON.parse(readFileSync(filePath, "utf8"));
        envelope.payload.request.amountNano = "2000000000";
        const tamperedText = `${JSON.stringify(envelope, null, 2)}\n`;
        writeFileSync(filePath, tamperedText, "utf8");

        first.shutdown({ checkpoint: false });
        second = createPersistence(dataDir);

        assert.throws(
            () => second.initialize(),
            (error) => error instanceof CorruptedRecordError
                && /checksum_mismatch/.test(error.message)
        );

        assert.equal(readFileSync(filePath, "utf8"), tamperedText);
        const names = readdirSync(join(dataDir, "active", "settlement"));
        assert.equal(names.some((name) => name.endsWith(".bak")), false);
    } finally {
        try { first.shutdown({ checkpoint: false }); } catch {}
        try { second?.shutdown({ checkpoint: false }); } catch {}
        rmSync(dataDir, { recursive: true, force: true });
    }
});
