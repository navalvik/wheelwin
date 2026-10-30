import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("already finalized archives never produce supplemental R2 writes", async () => {
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
        const originalBytes = uploader.uploads[0].bytes;
        for (let i = 0; i < 10; i++) {
            snapshot = { ...snapshot, paymentObservations:[...(snapshot.paymentObservations), {
                startedAt:100+i, completedAt:200+i, rowsReturned:0, resultWindowComplete:true
            }] };
            await service.ensureArchivedAndUploaded(request);
        }
        assert.equal(uploader.uploads.length, 1, "ten no-change polls create no new writes");
        assert.deepEqual(uploader.uploads[0].bytes, originalBytes, "original ZIP is preserved");

        snapshot = { ...snapshot, receipts:[{ transactionId:"verified-tx", amountAtomic:100,
            playerId:"player-a", paymentIntentId:"ref-a", paymentReference:"ref-a",
            senderAddress:address(100), destinationWalletAddress:address(4), transactionTime:150 }] };
        const updated = await service.ensureArchivedAndUploaded(request);
        assert.equal(uploader.uploads.length, 1, "material changes cannot publish a second final archive");
        assert.equal(uploader.objects.size, 1, "only one R2 object is visible for this room");
        assert.equal(updated.archiveFilename, uploader.uploads[0].objectName);

        await service.ensureArchivedAndUploaded(request);
        const restarted = new ForensicArchiveService({ config, uploader, financialSnapshotProvider:() => snapshot });
        await restarted.ensureArchivedAndUploaded(request);
        assert.equal(uploader.uploads.length, 1, "repeat and restart are idempotent");
        assert.equal(uploader.objects.size, 1, "restart does not create a second key");
        assert.deepEqual(uploader.uploads[0].bytes, originalBytes,
            "first committed final archive remains byte-for-byte unchanged");
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

test("R2 revision updates replace one key with If-Match and refuse stale concurrent updates", async () => {
    const dir = tempDirectory("ww-r2-single-key-cas-");
    try {
        const path = join(dir,"one-room.zip");
        const uploader = new R2ForensicArchiveUploader({
            bucket:"test-bucket", endpoint:"https://example.invalid", accessKeyId:"test", secretAccessKey:"test"
        });
        const objects = new Map();
        const puts = [];
        let concurrentConflict = false;
        uploader._client = {async send(command) {
            const key = command.input.Key;
            if (command.constructor.name === "HeadObjectCommand") {
                const existing = objects.get(key);
                if (!existing) {
                    const e = new Error("not found"); e.name="NotFound";
                    e.$metadata={httpStatusCode:404}; throw e;
                }
                return {ETag:existing.etag, Metadata:{wheelwinrevision:existing.revision}};
            }
            if (command.constructor.name === "PutObjectCommand") {
                const existing = objects.get(key);
                puts.push({key,ifMatch:command.input.IfMatch,ifNoneMatch:command.input.IfNoneMatch});
                await new Promise((resolve,reject)=>{
                    command.input.Body.once("end",resolve);
                    command.input.Body.once("error",reject);
                    command.input.Body.resume();
                });
                if (concurrentConflict) {
                    objects.set(key,{etag:'"other-writer"',revision:'cccccccccccccccccccccccc'});
                    const e = new Error("precondition failed"); e.name="PreconditionFailed";
                    e.$metadata={httpStatusCode:412}; throw e;
                }
                if (existing && command.input.IfMatch !== existing.etag) throw Error("missing If-Match");
                if (!existing && command.input.IfNoneMatch !== "*") throw Error("missing If-None-Match");
                const etag='"revision-'+(puts.length)+'"';
                objects.set(key,{etag,revision:command.input.Metadata?.wheelwinrevision});
                return {ETag:etag};
            }
            throw Error("unexpected command");
        }};
        const first='aaaaaaaaaaaaaaaaaaaaaaaa',second='bbbbbbbbbbbbbbbbbbbbbbbb';
        writeFileSync(path,"original forensic evidence");
        const created = await uploader.uploadFile(path,"same-room.zip",{revision:first});
        assert.equal(created.objectName,"forensic-archives/same-room.zip");
        writeFileSync(path,"updated forensic evidence");
        const updated = await uploader.uploadFile(path,"same-room.zip",{revision:second});
        assert.equal(updated.objectName,created.objectName);
        assert.equal(puts[0].ifNoneMatch,"*");
        assert.equal(puts[1].ifMatch,'"revision-1"');
        assert.equal(objects.size,1);
        const retry = await uploader.uploadFile(path,"same-room.zip",{revision:second});
        assert.equal(retry.alreadyPresent,true);
        assert.equal(puts.length,2);
        concurrentConflict = true;
        await assert.rejects(
            uploader.uploadFile(path,"same-room.zip",{revision:"dddddddddddddddddddddddd"}),
            /R2_ARCHIVE_CONCURRENT_UPDATE/
        );
    } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("financial recovery without gameId reuses archived game's canonical ZIP key", async () => {
    const dir = tempDirectory("ww-r2-game-id-");
    try {
        const history = join(dir,"history"), logs = join(dir,"logs"), staging = join(dir,"staging");
        mkdirSync(history); mkdirSync(logs);
        const config = {enabled:true,required:false,stagingDir:staging,sessionHistoryDir:history,
            diagnosticLogsDir:logs,maxUploadAttempts:1,bucket:"mock",prefix:"forensic-archives"};
        let state="PENDING";
        const uploader=new MockForensicArchiveUploader();
        const service=new ForensicArchiveService({
            config,uploader,
            sessionHistoryArchive:{listRecords:()=>({records:[{
                roomId:"Room-A",gameId:"game-a",finishedAt:1793313757137,
                lifecycleResult:"ROOM_DESTROYED"
            }]})},
            financialSnapshotProvider:()=>({roomId:"Room-A",network:"testnet",refunds:[{state}]})
        });
        const first=await service.ensureArchivedAndUploaded({
            roomId:"Room-A",gameId:"game-a",reason:"room_destroyed"
        });
        assert.match(first.archiveFilename,/GAME_game-a/);
        state="COMPLETE";
        const newer=await service.ensureArchivedAndUploaded({
            roomId:"Room-A",gameId:null,reason:"setup_expired"
        });
        assert.equal(newer.archiveFilename,first.archiveFilename);
        assert.equal(uploader.objects.size,1);
        assert.equal(uploader.uploads.length,1,"closed-room replay does not re-upload the final ZIP");
    } finally { rmSync(dir,{recursive:true,force:true}); }
});

// The live QfDS case must not be reported unresolved after both payouts settle.
{
const payoutId = "payout-QfDS-regression";
const transfers = [
    { recipientId:"player-olga", recipientRole:"WINNER" },
    { recipientId:"owner", recipientRole:"OWNER" }
];
const plan = { entryId:"entry-not-payout-id", kind:"PAYOUT_PLAN",
    metadata:{ payoutId, plan:{ payoutId, transfers } } };
const obligations = transfers.map(transfer => ({
    kind:"NET_PAYOUT", metadata:{ payoutId, recipientId:transfer.recipientId, role:transfer.recipientRole }
}));
const settlements = transfers.map(transfer => ({
    kind:"PAYOUT_SETTLEMENT",
    metadata:{ payoutId, recipientId:transfer.recipientId, role:transfer.recipientRole,
        transactionId:`onchain-${transfer.recipientRole}` }
}));

function financeWith(ledger) {
    const players=["olga","bob","lena"];
    return { roomId:"QfDS-regression", gameId:"game-QfDS-regression", network:"testnet",
        intents:players.map(p=>({
            playerId:`player-${p}`, paymentReference:`ref-${p}`,
            transactionId:`tx-${p}`, state:"SETTLED", amountAtomic:1_000_000_000
        })),
        receipts:players.map(p=>({
            playerId:`player-${p}`, paymentIntentId:`ref-${p}`,
            paymentReference:`ref-${p}`, transactionId:`tx-${p}`,
            transactionTime:1000, amountAtomic:1_000_000_000
        })),
        unresolvedReceipts:[], refunds:[], ledger, outstandingObligations:0
    };
}

function reportFor(finance) {
    const recovery=buildFinancialRecovery(finance);
    const decisions=buildPaymentDecisions(finance);
    return { recovery, decisions, report:buildFinalFinancialReport(finance,decisions,recovery) };
}

test("final game: two settled payouts linked by payoutId are not an investigation", () => {
    const {recovery,decisions,report}=reportFor(financeWith([plan,...obligations,...settlements]));
    assert.deepEqual(decisions.map(d=>d.decision),["SETTLED","SETTLED","SETTLED"]);
    assert.equal(recovery.requiresReconciliation,false);
    assert.equal(report.requiresInvestigation,false);
    assert.equal(report.paymentCounts.settled,3);
});

test("winner settled while owner remains unpaid still requires reconciliation", () => {
    const {recovery,report}=reportFor(financeWith([plan,...obligations,settlements[0]]));
    assert.equal(recovery.requiresReconciliation,true);
    assert.equal(report.requiresInvestigation,true);
});

test("unrelated payout settlement cannot close a plan", () => {
    const wrong={...settlements[1],metadata:{...settlements[1].metadata,payoutId:"other-payout"}};
    const {recovery,report}=reportFor(financeWith([plan,...obligations,settlements[0],wrong]));
    assert.equal(recovery.requiresReconciliation,true);
    assert.equal(report.requiresInvestigation,true);
});

test("payout plan with incomplete recipient list remains under investigation", () => {
    const broken={...plan,metadata:{...plan.metadata,plan:{payoutId,transfers:[transfers[0]]}}};
    const {recovery}=reportFor(financeWith([broken,...obligations,...settlements]));
    assert.equal(recovery.requiresReconciliation,true);
});

test("unresolved incoming transfer still requires investigation after both payouts settle", () => {
    const finance=financeWith([plan,...obligations,...settlements]);
    finance.unresolvedReceipts.push({ transactionId:"unresolved", ownershipStatus:"UNRESOLVED",
        playerId:null, paymentIntentId:null });
    const {recovery,report}=reportFor(finance);
    assert.equal(recovery.requiresReconciliation,true);
    assert.equal(report.requiresInvestigation,true);
});
}
