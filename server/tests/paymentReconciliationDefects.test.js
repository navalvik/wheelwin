import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

import { WalletPoolRegistry } from "../payment/WalletPoolRegistry.js";
import { ForensicArchiveService } from "../forensic/ForensicArchiveService.js";
import { MockForensicArchiveUploader, R2ForensicArchiveUploader } from "../forensic/R2ForensicArchiveUploader.js";
import { buildFinancialRecovery, buildFinalFinancialReport, buildPaymentDecisions } from "../forensic/ForensicArchiveCollector.js";

const address = (n) => `0:${n.toString(16).padStart(64, "0")}`;

function tempDirectory(prefix) { return mkdtempSync(join(tmpdir(), prefix)); }

function extractZipEntry(buffer, wantedName) {
    let eocd = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    assert.notEqual(eocd, -1, "ZIP end-of-central-directory exists");
    const count = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i++) {
        assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "central directory entry is valid");
        const method = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString();
        if (name === wantedName) {
            const localNameLength = buffer.readUInt16LE(localOffset + 26);
            const localExtraLength = buffer.readUInt16LE(localOffset + 28);
            const start = localOffset + 30 + localNameLength + localExtraLength;
            const bytes = buffer.subarray(start, start + compressedSize);
            return method === 8 ? inflateRawSync(bytes).toString() : bytes.toString();
        }
        offset += 46 + nameLength + extraLength + commentLength;
    }
    throw new Error(`ZIP entry not found: ${wantedName}`);
}

test("wallet reservation history keeps ownership intervals across release, reassignment, and restart", () => {
    const dir = tempDirectory("ww-wallet-history-");
    try {
        const catalogPath = join(dir, "wallets.json");
        const wallets = Array.from({ length: 64 }, (_, i) => ({
            walletId: `room-wallet-${i + 1}`, roomNumber: i + 1, address: address(i + 1), network: "testnet"
        }));
        writeFileSync(catalogPath, JSON.stringify(wallets));
        const registry = new WalletPoolRegistry({ catalogPath, network: "testnet" });
        registry.initialize({ snapshotDir: dir });
        registry.reserve({ roomId: "Room-A", walletId: "room-wallet-4", network: "testnet", now: 1000 });
        registry.persistSnapshot(dir);
        registry.release({ roomId: "Room-A", now: 2000 });
        registry.persistSnapshot(dir);
        registry.reserve({ roomId: "Room-B", walletId: "room-wallet-4", network: "testnet", now: 3000 });
        registry.persistSnapshot(dir);

        const restarted = new WalletPoolRegistry({ catalogPath, network: "testnet" });
        restarted.initialize({ snapshotDir: dir });
        assert.deepEqual(restarted.resolveReservationOwnerAt({ walletId: "room-wallet-4", transactionTime: 1500 }),
            { status: "OWNED", roomId: "Room-A", candidates: ["Room-A"] });
        assert.equal(restarted.resolveReservationOwnerAt({ walletId: "room-wallet-4", transactionTime: 2500 }).status, "UNKNOWN");
        assert.deepEqual(restarted.resolveReservationOwnerAt({ walletId: "room-wallet-4", transactionTime: 3500 }),
            { status: "OWNED", roomId: "Room-B", candidates: ["Room-B"] });
        assert.equal(restarted.listReservationHistoryForWallet("room-wallet-4").length, 2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("forensic decisions use evidence-based categories and final report matches the decision journal", () => {
    const sender = address(100), wrongSender = address(101), destination = address(4), wrongDestination = address(5);
    const intent = { roomId:"Room-A", playerId:"player-a", paymentReference:"ref-a",
        expectedSender:sender, destinationWalletAddress:destination, amountAtomic:100,
        createdAt:1000, expiresAt:2000, state:"PENDING" };
    const unpaidIntent = { ...intent, playerId:"player-b", paymentReference:"ref-b", expectedSender:address(103) };
    const receipt = (transactionId, overrides = {}) => ({ transactionId, playerId:"player-a",
        paymentIntentId:"ref-a", paymentReference:"ref-a", amountAtomic:100, senderAddress:sender,
        destinationWalletAddress:destination, transactionTime:1500, ...overrides });
    const receipts = [
        receipt("missing-ref", { paymentReference:null }),
        receipt("wrong-amount", { amountAtomic:50 }),
        receipt("wrong-sender", { senderAddress:wrongSender }),
        receipt("wrong-destination", { destinationWalletAddress:wrongDestination }),
        receipt("late", { transactionTime:2500 }),
        receipt("duplicate"), receipt("duplicate"),
        { ...receipt("unresolved"), roomId:null, playerId:null, paymentIntentId:null,
            ownershipStatus:"UNRESOLVED", candidateRoomIds:["Room-A","Room-B"], unresolvedReason:"OVERLAP" },
        receipt("unattributed", { playerId:null, paymentIntentId:null, paymentReference:null,
            senderAddress:address(102), amountAtomic:999 })
    ];
    const finance = { roomId:"Room-A", gameId:"game-a", network:"testnet", intents:[intent,unpaidIntent], receipts,
        paymentObservations:[{ completedAt:3000, resultWindowComplete:false, providerError:"INCOMPLETE_RESULT_WINDOW" }],
        unresolvedReceipts:[], refunds:[], ledger:[], outstandingObligations:1 };
    const decisions = buildPaymentDecisions(finance);
    const byId = new Map(decisions.filter(row => row.transactionId).map(row => [row.transactionId,row]));
    assert.equal(byId.get("missing-ref").decision, "MISSING_REFERENCE", "missing memo is not by itself late");
    assert.equal(byId.get("wrong-amount").decision, "AMOUNT_MISMATCH");
    assert.equal(byId.get("wrong-sender").decision, "SENDER_MISMATCH");
    assert.equal(byId.get("wrong-destination").decision, "DESTINATION_MISMATCH");
    assert.equal(byId.get("late").decision, "LATE_PAYMENT");
    assert.equal(byId.get("duplicate").decision, "DUPLICATE");
    assert.equal(byId.get("unresolved").decision, "AMBIGUOUS");
    assert.equal(byId.get("unattributed").decision, "UNATTRIBUTED_TRANSFER");
    assert.equal(decisions.find(row => row.playerId === "player-b" && !row.transactionId).decision, "UNVERIFIED");
    const recovery = buildFinancialRecovery(finance);
    const report = buildFinalFinancialReport(finance, decisions, recovery);
    assert.deepEqual(report.closeEvidence.decisions.map(row => [row.transactionId, row.decision]),
        decisions.map(row => [row.transactionId, row.decision]));
});

test("routine polls do not upload copies; financial updates replace a single R2 key", async () => {
    const dir = tempDirectory("ww-archive-revisions-");
    try {
        const history = join(dir, "history"), logs = join(dir, "logs"), staging = join(dir, "staging");
        mkdirSync(history); mkdirSync(logs);
        writeFileSync(join(history, "2026-10-29_00-00-00_ROOM_Room-A_GAME_game-a_COMPLETED.json"),
            JSON.stringify({ roomId:"Room-A", gameId:"game-a", lifecycleResult:"GAME_COMPLETED" }));
        writeFileSync(join(logs, "2026-10-29_00-00-00_ROOM_Room-A.log"), "game-a");
        const config = { enabled:true, required:false, stagingDir:staging, sessionHistoryDir:history,
            diagnosticLogsDir:logs, maxUploadAttempts:2, bucket:"mock", prefix:"forensic-archives" };
        let snapshot = { schemaVersion:1, roomId:"Room-A", network:"testnet", closedRoom:{roomId:"Room-A"},
            intents:[], receipts:[], refunds:[], ledger:[], paymentObservations:[], paymentDecisions:[], outstandingObligations:0 };
        const uploader = new MockForensicArchiveUploader();
        const request = { roomId:"Room-A", gameId:"game-a", reason:"game_completed" };
        const service = new ForensicArchiveService({ config, uploader, financialSnapshotProvider:() => snapshot });
        await service.ensureArchivedAndUploaded(request);
        const originalBytes = readFileSync(uploader.uploads[0].localPath);
        for (let i = 0; i < 10; i++) {
            snapshot = { ...snapshot, paymentObservations:[...(snapshot.paymentObservations), {
                startedAt:100+i, completedAt:200+i, rowsReturned:0, resultWindowComplete:true
            }] };
            await service.ensureArchivedAndUploaded(request);
        }
        assert.equal(uploader.uploads.length, 1, "ten no-change polls create no new writes");
        assert.deepEqual(readFileSync(uploader.uploads[0].localPath), originalBytes, "original ZIP is preserved");

        snapshot = { ...snapshot, receipts:[{ transactionId:"verified-tx", amountAtomic:100,
            playerId:"player-a", paymentIntentId:"ref-a", paymentReference:"ref-a",
            senderAddress:address(100), destinationWalletAddress:address(4), transactionTime:150 }] };
        const updated = await service.ensureArchivedAndUploaded(request);
        assert.equal(uploader.uploads.length, 2, "a material receipt triggers one update, not a supplement");
        assert.equal(uploader.objects.size, 1, "only one R2 object is visible for this room");
        assert.equal(uploader.uploads[1].objectName, uploader.uploads[0].objectName);
        assert.equal(updated.archiveFilename, uploader.uploads[0].objectName);
        assert.notEqual(uploader.uploads[1].localPath, uploader.uploads[0].localPath);
        const newerFinance = JSON.parse(extractZipEntry(
            readFileSync(uploader.uploads[1].localPath), "financial/room-wallet.json"));
        assert.equal(newerFinance.receipts.length,1,"latest R2 object carries the newly verified receipt");

        await service.ensureArchivedAndUploaded(request);
        const restarted = new ForensicArchiveService({ config, uploader, financialSnapshotProvider:() => snapshot });
        await restarted.ensureArchivedAndUploaded(request);
        assert.equal(uploader.uploads.length, 2, "repeat and restart are idempotent");
        assert.equal(uploader.objects.size, 1, "restart does not create a second key");
        assert.deepEqual(readFileSync(uploader.uploads[0].localPath), originalBytes,
            "original forensic evidence stays on the durable volume");
    } finally { rmSync(dir, { recursive:true, force:true }); }
});

test("R2 uploader uses atomic create-once writes and preserves an existing ZIP object", async () => {
    const dir = tempDirectory("ww-r2-create-once-");
    try {
        const localPath = join(dir, "room.zip");
        writeFileSync(localPath, "synthetic forensic zip bytes");
        const uploader = new R2ForensicArchiveUploader({
            bucket:"test-bucket", endpoint:"https://example.invalid", accessKeyId:"test", secretAccessKey:"test"
        });
        let exists = false;
        let putCalls = 0;
        uploader._client = { async send(command) {
            if (command.constructor.name === "HeadObjectCommand") {
                if (!exists) {
                    const error = new Error("missing"); error.name = "NotFound";
                    error.$metadata = { httpStatusCode:404 };
                    throw error;
                }
                return { ETag:"\"original-etag\"", VersionId:"original-version" };
            }
            if (command.constructor.name === "PutObjectCommand") {
                putCalls += 1;
                assert.equal(command.input.IfNoneMatch, "*", "the write is conditional on key absence");
                await new Promise((resolve, reject) => {
                    command.input.Body.once("end", resolve);
                    command.input.Body.once("error", reject);
                    command.input.Body.resume();
                });
                exists = true;
                return { ETag:"\"created-etag\"" };
            }
            throw new Error(`Unexpected R2 command: ${command.constructor.name}`);
        } };

        const first = await uploader.uploadFile(localPath, "room-revision.zip");
        assert.equal(first.objectName, "forensic-archives/room-revision.zip");
        assert.equal(putCalls, 1, "first upload creates one object");
        const retry = await uploader.uploadFile(localPath, "room-revision.zip");
        assert.equal(retry.alreadyPresent, true, "retry observes the already stored archive");
        assert.equal(retry.generation, "original-version");
        assert.equal(putCalls, 1, "retry does not replace the stored object");
    } finally { rmSync(dir, { recursive:true, force:true }); }
});
