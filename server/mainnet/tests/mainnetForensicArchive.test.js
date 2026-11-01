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
import { R2ForensicArchiveUploader } from "../../forensic/R2ForensicArchiveUploader.js";

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
    const payout = { roomId: ROOM, payoutId: "payout_synthetic", winner: { recipientId: "p1", state: "CONFIRMED" },
        owner: { recipientId: "owner", state: "CONFIRMED" } };
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
    assert.equal(evaluateFinalForensicArchive({ snapshot, sessionRecord: {
        finishedAt: 40, lifecycleResult: "GAME_COMPLETED"
    } }).ready, true);
    assert.throws(() => createMainnetForensicFinancialSnapshot({ roomId: ROOM,
        incomingLedger: { network: "testnet", globalId: -3 }, financialLedger: {} }),
    /MAINNET_FORENSIC_SNAPSHOT_SOURCE_INVALID/);
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
