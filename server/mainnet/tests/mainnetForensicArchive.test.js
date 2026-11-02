import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MainnetFinancialLedger } from "../payment/MainnetFinancialLedger.js";
import {
    createMainnetForensicFinancialSnapshot,
    resolveFinancialArchiveRuntimeBinding
} from "../payment/MainnetForensicFinancialSnapshot.js";
import { evaluateFinalForensicArchive } from "../../forensic/FinalForensicArchiveGate.js";
import { MockForensicArchiveUploader, R2ForensicArchiveUploader }
    from "../../forensic/R2ForensicArchiveUploader.js";
import { ForensicArchiveService } from "../../forensic/ForensicArchiveService.js";
import { ForensicArchiveCollector } from "../../forensic/ForensicArchiveCollector.js";

const ROOM = "synthetic-mainnet-room";
const TESTNET_PREFIX = "forensic-archives";

function mainnetSnapshotFixture() {
    const intents = ["p1", "p2", "p3"].map((playerId, index) => ({ roomId: ROOM, playerId,
        paymentReference: `pay${index + 1}`, network: "mainnet", globalId: -239,
        amountAtomic: "1000000000", asset: "TON", expectedSender: `sender-${index + 1}`,
        destinationWalletAddress: "wallet", createdAt: 10, expiresAt: 20,
        state: "SETTLED", confirmedTransactionId: `in-tx-${index + 1}` }));
    const receipts = intents.map((intent, index) => ({ roomId: ROOM, playerId: intent.playerId,
        paymentReference: intent.paymentReference, transactionId: intent.confirmedTransactionId,
        network: "mainnet", globalId: -239, amountAtomic: intent.amountAtomic, asset: "TON",
        sourceAddress: intent.expectedSender, destinationAddress: "wallet", transactionTime: 15,
        status: "CONFIRMED" }));
    const incomingLedger = {
        network: "mainnet", globalId: -239,
        listRoomIntents: roomId => roomId === ROOM ? intents : [],
        listReceipts: roomId => roomId === ROOM ? receipts : [],
        listObservations: roomId => roomId === ROOM ? receipts.map(receipt => ({ roomId,
            transactionId: receipt.transactionId, network: "mainnet", globalId: -239,
            sourceAddress: receipt.sourceAddress, destinationAddress: "wallet",
            amountAtomic: receipt.amountAtomic, transactionTime: 15 })) : []
    };
    const payout = { roomId: ROOM, payoutId: "payout_synthetic", principalAtomic: 2_000_000_000,
        allocation: { winnerAtomic: 1_900_000_000, ownerAtomic: 98_000_000, reserveAtomic: 2_000_000 },
        winner: { recipientId: "p1", address: "winner-address", amountAtomic: 1_900_000_000,
            state: "CONFIRMED", transactionId: "out-winner" },
        owner: { recipientId: "owner", address: "owner-address", amountAtomic: 98_000_000,
            state: "CONFIRMED", transactionId: "out-owner" } };
    const financialLedger = {
        network: "mainnet", globalId: -239,
        getOutcome: () => ({ roomId: ROOM, kind: "PAYOUT", createdAtMs: 30 }),
        listRefunds: () => [], listPayouts: () => [payout], countOpenObligations: () => 0
    };
    return createMainnetForensicFinancialSnapshot({ roomId: ROOM, incomingLedger, financialLedger });
}

test("network binding preserves the Testnet prefix and selects Mainnet-only snapshot source", () => {
    const testnet = { financialSnapshot: roomId => ({ network: "testnet", roomId }) };
    const mainnet = { financialSnapshot: roomId => ({ network: "mainnet", roomId }) };
    const archiveConfig = { prefix: TESTNET_PREFIX, bucket: "wheelwin-forensic-archives" };
    const testnetBinding = resolveFinancialArchiveRuntimeBinding({
        paymentMode: "testnet", archiveConfig, testnetRuntime: testnet, mainnetRuntime: mainnet
    });
    const mainnetBinding = resolveFinancialArchiveRuntimeBinding({
        paymentMode: "mainnet", archiveConfig, testnetRuntime: testnet, mainnetRuntime: mainnet
    });
    assert.equal(testnetBinding.config, archiveConfig);
    assert.equal(testnetBinding.config.prefix, TESTNET_PREFIX);
    assert.deepEqual(testnetBinding.financialSnapshotProvider(ROOM), { network: "testnet", roomId: ROOM });
    assert.equal(mainnetBinding.config.bucket, "wheelwin-forensic-archives");
    assert.equal(mainnetBinding.config.prefix, "mainnet");
    assert.deepEqual(mainnetBinding.financialSnapshotProvider(ROOM), { network: "mainnet", roomId: ROOM });
    assert.throws(() => resolveFinancialArchiveRuntimeBinding({ paymentMode: "unknown", archiveConfig }),
        /FORENSIC_ARCHIVE_NETWORK_BINDING_INVALID/);
});

test("Mainnet snapshot matches the shared financial archive and payout finality contract", () => {
    const snapshot = mainnetSnapshotFixture();
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.network, "mainnet");
    assert.equal(snapshot.globalId, -239);
    assert.equal(snapshot.intents[0].transactionId, "in-tx-1");
    assert.equal(snapshot.receipts[0].senderAddress, "sender-1");
    assert.equal(snapshot.receipts[0].destinationWalletAddress, "wallet");
    assert.deepEqual(snapshot.ledger.map(entry => entry.kind), [
        "INCOMING_PRINCIPAL", "INCOMING_PRINCIPAL", "INCOMING_PRINCIPAL",
        "PAYOUT_PLAN", "PAYOUT_SETTLEMENT", "PAYOUT_SETTLEMENT"
    ]);
    const plan = snapshot.ledger.find(entry => entry.kind === "PAYOUT_PLAN");
    assert.equal(plan.amountAtomic, 2_000_000_000);
    assert.equal(plan.metadata.plan.transfers[0].grossAtomic, 1_900_000_000);
    assert.equal(plan.metadata.plan.transfers[1].address, "owner-address");
    assert.equal(evaluateFinalForensicArchive({ snapshot, sessionRecord: {
        finishedAt: 40, lifecycleResult: "GAME_COMPLETED"
    } }).ready, true);
    assert.throws(() => createMainnetForensicFinancialSnapshot({ roomId: ROOM,
        incomingLedger: { network: "testnet", globalId: -3 }, financialLedger: {} }),
    /MAINNET_FORENSIC_SNAPSHOT_SOURCE_INVALID/);
});

test("EXTRA_PAYMENT stays in the final report but is unresolved only when its status is genuinely uncertain", async t => {
    const root = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-extra-archive-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    let includeUnresolved = true;
    const receiptRows = [
        ...["p1", "p2", "p3"].map((playerId, index) => ({ roomId: ROOM, playerId,
            paymentReference: `pay${index + 1}`, transactionId: `in-tx-${index + 1}`,
            network: "mainnet", globalId: -239, amountAtomic: "1000000000", asset: "TON",
            sourceAddress: `sender-${index + 1}`, destinationAddress: "wallet", transactionTime: 15,
            status: "CONFIRMED", reason: null })),
        { roomId: ROOM, playerId: "p1", paymentReference: "pay1", transactionId: "in-extra",
            network: "mainnet", globalId: -239, amountAtomic: "1000000000", asset: "TON",
            sourceAddress: "sender-1", destinationAddress: "wallet", transactionTime: 16,
            status: "EXTRA_PAYMENT", reason: "PAYMENT_ALREADY_SETTLED" },
        ...["UNRESOLVED", "AMBIGUOUS", "PENDING_FINALITY"].map((status, index) => ({
            roomId: ROOM, playerId: null, paymentReference: null, transactionId: `in-${status}`,
            network: "mainnet", globalId: -239, amountAtomic: "1000000000", asset: "TON",
            sourceAddress: `unknown-${index}`, destinationAddress: "wallet", transactionTime: 17 + index,
            status, reason: status
        }))
    ];
    const incomingLedger = {
        network: "mainnet", globalId: -239,
        listRoomIntents: () => ["p1", "p2", "p3"].map((playerId, index) => ({
            roomId: ROOM, playerId, paymentReference: `pay${index + 1}`, network: "mainnet",
            globalId: -239, amountAtomic: "1000000000", asset: "TON",
            expectedSender: `sender-${index + 1}`, destinationWalletAddress: "wallet",
            createdAt: 10, expiresAt: 20, state: "SETTLED", confirmedTransactionId: `in-tx-${index + 1}`
        })),
        listReceipts: () => receiptRows.filter(receipt => includeUnresolved
            || !["UNRESOLVED", "AMBIGUOUS", "PENDING_FINALITY"].includes(receipt.status)),
        listObservations: () => []
    };
    const coverage = { source: "FINAL_FORENSIC_HISTORY_COVERAGE", completedAt: 100_000,
        resultWindowComplete: true, providerError: null, candidateCount: 4, checkedCount: 4,
        pendingCount: 0, verifiedTransactionIds: ["in-tx-1", "in-tx-2", "in-tx-3", "in-extra"] };
    const extraRefund = { obligationId: "refund-extra", state: "PENDING" };
    const financialLedger = {
        network: "mainnet", globalId: -239,
        getOutcome: () => ({ roomId: ROOM, kind: "REFUND", roomNumber: 1,
            closureReason: "setup_expired", closedAtMs: 1_000 }),
        listRefunds: () => [extraRefund], listPayouts: () => [],
        countOpenObligations: () => extraRefund.state === "COMPLETE" ? 0 : 1,
        getHistoryCoverage: () => coverage
    };
    let snapshot = createMainnetForensicFinancialSnapshot({ roomId: ROOM, incomingLedger, financialLedger });
    assert.deepEqual(snapshot.receipts.filter(x => x.status === "EXTRA_PAYMENT").map(x => x.transactionId), ["in-extra"]);
    assert.deepEqual(snapshot.unresolvedReceipts.map(x => x.status), ["UNRESOLVED", "AMBIGUOUS", "PENDING_FINALITY"]);
    assert.equal(evaluateFinalForensicArchive({ snapshot, nowMs: 100_000 }).reason,
        "FINANCIAL_OBLIGATIONS_OPEN_OR_UNKNOWN");
    assert.equal(evaluateFinalForensicArchive({ snapshot: { ...snapshot, refunds: [], outstandingObligations: 0 },
        nowMs: 100_000 }).reason, "UNRESOLVED_INCOMING_RECEIPTS");

    extraRefund.state = "COMPLETE";
    extraRefund.finalizedEvidence = { network: "mainnet", globalId: -239, transactionId: "refund-extra-tx",
        amountAtomic: 1_000_000_000, destination: "sender-1", finalized: true };
    includeUnresolved = false;
    snapshot = createMainnetForensicFinancialSnapshot({ roomId: ROOM, incomingLedger, financialLedger });
    assert.equal(snapshot.unresolvedReceipts.length, 0);
    assert.deepEqual(evaluateFinalForensicArchive({ snapshot, nowMs: 100_000 }), {
        ready: true, reason: "FINAL_REFUNDS_AND_HISTORY"
    });

    const stagingDir = join(root, "staging");
    const sessionHistoryDir = join(root, "history");
    const diagnosticLogsDir = join(root, "logs");
    const sessionRecord = { roomId: ROOM, gameId: "extra-game", finishedAt: 100_000,
        lifecycleResult: "ROOM_CLOSED" };
    const sessionHistoryArchive = { listRecords: () => ({ records: [sessionRecord] }),
        listRecordFilePathsForRoom: () => [] };
    const uploader = new MockForensicArchiveUploader();
    const collector = new ForensicArchiveCollector({ sessionHistoryDir, diagnosticLogsDir, sessionHistoryArchive });
    const reportEntry = collector._discoverArtifactEntries({ roomId: ROOM, gameId: "extra-game",
        financialSnapshot: snapshot }).find(entry => entry.zipPath === "financial/final-report.json");
    const recoveryEntry = collector._discoverArtifactEntries({ roomId: ROOM, gameId: "extra-game",
        financialSnapshot: snapshot }).find(entry => entry.zipPath === "forensics/financial-recovery.json");
    const archivedReport = JSON.parse(reportEntry.inlineContent);
    const archivedRecovery = JSON.parse(recoveryEntry.inlineContent);
    assert.equal(archivedReport.paymentCounts.receipts, 4);
    assert.equal(archivedRecovery.receipts.find(x => x.transactionId === "in-extra")?.status, "EXTRA_PAYMENT");
    assert.equal(archivedReport.unresolvedReceiptCount, 0);
    const service = new ForensicArchiveService({
        config: { enabled: true, required: true, bucket: "mock", prefix: "mainnet",
            stagingDir, sessionHistoryDir, diagnosticLogsDir,
            maxUploadAttempts: 1 },
        uploader,
        sessionHistoryArchive,
        financialSnapshotProvider: () => snapshot,
        finalityChecker: (financial, context) => evaluateFinalForensicArchive({
            snapshot: financial, sessionRecord: context.sessionRecord, nowMs: 100_000
        })
    });
    const candidate = { roomId: ROOM, gameId: "extra-game", reason: "room_destroyed" };
    const uploaded = await service.ensureArchivedAndUploaded(candidate);
    assert.equal(uploaded.uploaded, true);
    assert.equal(uploader.uploads.length, 1);
    assert.equal((await service.ensureArchivedAndUploaded(candidate)).uploaded, true);
    assert.equal(uploader.uploads.length, 1, "one game retains one immutable final ZIP");

    const mainnetReady = evaluateFinalForensicArchive({ snapshot, nowMs: 100_000 });
    for (const invalidCoverage of [
        { ...coverage, resultWindowComplete: false },
        { ...coverage, providerError: "HTTP_429" },
        { ...coverage, checkedCount: 3 }
    ]) {
        const blocked = { ...snapshot, paymentObservations: [invalidCoverage] };
        assert.equal(evaluateFinalForensicArchive({ snapshot: blocked, nowMs: 100_000 }).ready, false);
        const equivalentTestnet = { ...blocked, network: "testnet", globalId: -3 };
        assert.deepEqual(evaluateFinalForensicArchive({ snapshot: blocked, nowMs: 100_000 }),
            evaluateFinalForensicArchive({ snapshot: equivalentTestnet, nowMs: 100_000 }));
    }
    assert.equal(mainnetReady.ready, true);
});

test("R2 uploader applies separate exact object prefixes without contacting Cloudflare", async t => {
    const root = mkdtempSync(join(tmpdir(), "wheelwin-r2-prefix-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const localZip = join(root, "synthetic-room.zip");
    writeFileSync(localZip, Buffer.from("synthetic ZIP bytes"));
    const keys = new Set();

    async function upload(prefix) {
        const uploader = new R2ForensicArchiveUploader({ bucket: "wheelwin-forensic-archives", prefix,
            endpoint: "https://mock.invalid", accessKeyId: "synthetic", secretAccessKey: "synthetic" });
        uploader._client = { async send(command) {
            const { Bucket, Key } = command.input;
            assert.equal(Bucket, "wheelwin-forensic-archives");
            if (command.constructor.name === "HeadObjectCommand") {
                if (!keys.has(Key)) throw Object.assign(new Error("not found"), { name: "NotFound" });
                return { ETag: '"synthetic-etag"' };
            }
            if (command.constructor.name === "PutObjectCommand") {
                assert.equal(Key, prefix ? `${prefix}/synthetic-room.zip` : "synthetic-room.zip");
                for await (const _chunk of command.input.Body) { /* consume the mocked stream */ }
                keys.add(Key);
                return { ETag: '"synthetic-etag"' };
            }
            throw new Error("unexpected mock R2 command");
        } };
        const result = await uploader.uploadFile(localZip, "synthetic-room.zip", {
            revision: "0123456789abcdef01234567", final: true
        });
        return result.objectName;
    }

    assert.equal(await upload(TESTNET_PREFIX), "forensic-archives/synthetic-room.zip");
    assert.equal(await upload("mainnet"), "mainnet/synthetic-room.zip");
    assert.deepEqual([...keys].sort(), [
        "forensic-archives/synthetic-room.zip", "mainnet/synthetic-room.zip"
    ]);
});

test("Mainnet ledger-backed snapshots remain read-only", t => {
    const root = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-archive-ledger-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const config = { network: "mainnet", globalId: -239, dataDir: root };
    const ledger = new MainnetFinancialLedger({ config, nowProvider: () => 100 }).initialize();
    const before = ledger.listPayouts();
    const incoming = { network: "mainnet", globalId: -239,
        listRoomIntents: () => [], listReceipts: () => [], listObservations: () => [] };
    const snapshot = createMainnetForensicFinancialSnapshot({ roomId: ROOM,
        incomingLedger: incoming, financialLedger: ledger });
    assert.equal(snapshot.network, "mainnet");
    assert.equal(snapshot.outstandingObligations, 0);
    assert.deepEqual(ledger.listPayouts(), before);
    assert.equal(ledger.getOutcome(ROOM), null);
});
