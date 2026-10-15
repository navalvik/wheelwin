import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    ROOM_LIFETIME_MS,
    ROOM_WALLET_POOL_SIZE,
    AssetDenominationRegistry,
    PaymentIntent,
    PaymentIntentStore,
    RoomWalletPaymentService,
    WalletAssignmentConflictError,
    WalletPoolRegistry
} from "../../payment/index.js";
import {
    RoomPreparationManifestError,
    RoomPreparationManifestStore
} from "../../payment/RoomPreparationManifestStore.js";
import { PAYMENT_INTENT_STATE } from "../../payment/PaymentIntentStatus.js";
import { formatPaymentReference } from "../../payment/incoming/index.js";
import { IncomingPaymentSettlementCoordinator } from "../../payment/incoming/IncomingPaymentSettlementCoordinator.js";
import {
    CurrencyMapping,
    INCOMING_PRINCIPAL_CONFIRMATION_SOURCE,
    LEDGER_ENTRY_KIND,
    LedgerStore,
    PayoutValidationError,
    RoomLedger
} from "../../payment/ledger/index.js";
import {
    RoomPaymentObservationService,
    ToncenterIncomingProvider,
    ToncenterRateLimitError,
    ToncenterTransactionsClient
} from "../../payment/toncenter/index.js";
import {
    DESCRIPTOR_STAKE_RELATION,
    RoomPaymentSessionAdapter,
    RoomPaymentSessionValidationError
} from "../../payment/runtime/RoomPaymentSessionAdapter.js";

const BASE_MS = 1_700_100_000_000;
const CREATED_AT = BASE_MS;
const NOW_MS = BASE_MS + 5_000;
const TRANSFER_SECONDS = Math.floor(NOW_MS / 1_000);
const SYNTHETIC_API_KEY = "SYNTHETIC-TONCENTER-TEST-KEY-NOT-REAL";
const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
let assertions = 0;
let sections = 0;
const TOTAL_SECTIONS = 22;
const PROCESS_WORKER_EXIT_CODE = 87;

function check(value, message) {
    assert.ok(value, message);
    assertions += 1;
}

function equal(actual, expected, message) {
    assert.equal(actual, expected, message);
    assertions += 1;
}

function deepEqual(actual, expected, message) {
    assert.deepEqual(actual, expected, message);
    assertions += 1;
}

function throws(fn, errorClass, message) {
    assert.throws(fn, errorClass, message);
    assertions += 1;
}

async function rejects(promise, errorClass, message) {
    await assert.rejects(promise, errorClass, message);
    assertions += 1;
}

async function section(name, callback) {
    const assertionsBefore = assertions;
    await callback();
    sections += 1;
    process.stdout.write(`[${sections}/${TOTAL_SECTIONS}] PASS ${name} (${assertions - assertionsBefore} assertions)\n`);
}

function crc16Xmodem(bytes) {
    let register = 0;
    for (const byte of bytes) {
        register ^= byte << 8;
        for (let bit = 0; bit < 8; bit += 1) {
            register = (register & 0x8000)
                ? ((register << 1) ^ 0x1021)
                : (register << 1);
            register &= 0xffff;
        }
    }
    return Buffer.from([register >> 8, register & 0xff]);
}

function syntheticAddress(seed) {
    const hash = createHash("sha256").update(`session-adapter:${seed}`).digest();
    const body = Buffer.concat([Buffer.from([0x11, 0]), hash]);
    return Buffer.concat([body, crc16Xmodem(body)]).toString("base64url");
}

function writeSyntheticCatalog(catalogPath) {
    const wallets = Array.from({ length: ROOM_WALLET_POOL_SIZE }, (_, index) => ({
        roomNumber: index + 1,
        address: syntheticAddress(`wallet-${index + 1}`),
        publicKey: null,
        workchain: 0,
        network: "testnet"
    }));
    writeFileSync(catalogPath, `${JSON.stringify(wallets)}\n`, "utf8");
}

function makeDescriptor({
    roomId = "room-session-1",
    roomCreatedAt = CREATED_AT,
    requiredPlayers = null,
    network = "testnet",
    asset = "TON",
    stakeLedgerRelation = DESCRIPTOR_STAKE_RELATION
} = {}) {
    const rows = requiredPlayers ?? [{
        roomId,
        paymentReference: "WW-SESSION-PLAYER-1",
        playerId: "player-1",
        expectedSender: syntheticAddress("sender-1"),
        amountAtomic: 2_000_000_000
    }];
    return {
        roomId,
        roomCreatedAt,
        network,
        asset,
        requiredPlayers: rows,
        stakeLedgerRelation
    };
}

function makeRecoveryDescriptor(roomId = "room-manifest-recovery") {
    return makeDescriptor({
        roomId,
        requiredPlayers: [
            {
                roomId,
                paymentReference: "WW-MANIFEST-RECOVERY-A",
                playerId: "manifest-player-a",
                expectedSender: syntheticAddress("manifest-sender-a"),
                amountAtomic: 2_000_000_000
            },
            {
                roomId,
                paymentReference: "WW-MANIFEST-RECOVERY-B",
                playerId: "manifest-player-b",
                expectedSender: syntheticAddress("manifest-sender-b"),
                amountAtomic: 3_000_000_000
            }
        ]
    });
}

function durableDirectorySnapshot(directory) {
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => [name, readFileSync(join(directory, name), "utf8")]);
}

function durablePreparationSnapshot(h, roomId) {
    const manifestId = createHash("sha256").update(roomId, "utf8").digest("hex");
    const manifestPath = join(h.workspace, "preparation-manifests", `${manifestId}.json`);
    const walletSnapshotPath = join(h.workspace, "payment-data", "wallet-pool.json");
    return {
        manifest: existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : null,
        intents: durableDirectorySnapshot(h.intentStore.intentsDir),
        walletSnapshot: existsSync(walletSnapshotPath)
            ? readFileSync(walletSnapshotPath, "utf8")
            : null,
        ledgerEntries: durableDirectorySnapshot(h.ledger.store.entriesDir)
    };
}

function readPersistedPreparationRecords(workspace, roomId) {
    const manifestId = createHash("sha256").update(roomId, "utf8").digest("hex");
    const manifestPath = join(workspace, "preparation-manifests", `${manifestId}.json`);
    const intentDirectory = join(workspace, "payment-data", "payment-intents");
    const ledgerDirectory = join(workspace, "ledger-data", "ledger", "entries");
    const walletSnapshotPath = join(workspace, "payment-data", "wallet-pool.json");
    const manifestFiles = durableDirectorySnapshot(join(workspace, "preparation-manifests"));
    const intents = durableDirectorySnapshot(intentDirectory).map(([name, contents]) => ({
        name,
        record: JSON.parse(contents),
        contents
    }));
    const ledgerEntries = durableDirectorySnapshot(ledgerDirectory).map(([name, contents]) => ({
        name,
        record: JSON.parse(contents),
        contents
    }));
    return {
        manifestFiles,
        manifestContents: existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : null,
        manifest: existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null,
        intents,
        walletSnapshotContents: existsSync(walletSnapshotPath)
            ? readFileSync(walletSnapshotPath, "utf8")
            : null,
        walletSnapshot: existsSync(walletSnapshotPath)
            ? JSON.parse(readFileSync(walletSnapshotPath, "utf8"))
            : null,
        ledgerEntries
    };
}

function workerAssert(condition, message) {
    if (!condition) throw new Error(message);
}

function workerDeepEqual(actual, expected, message) {
    try {
        assert.deepEqual(actual, expected, message);
    } catch (error) {
        throw new Error(`${message}: ${error?.message ?? error}`);
    }
}

function terminateWorkerAtBoundary(boundary) {
    process.stdout.write(`PROCESS_WORKER_INTERRUPTED:${JSON.stringify({
        pid: process.pid,
        boundary,
        exitCode: PROCESS_WORKER_EXIT_CODE
    })}\n`);
    process.exit(PROCESS_WORKER_EXIT_CODE);
}

function runManifestProcessWorker(mode, workspace, boundary) {
    if (typeof workspace !== "string" || workspace.trim() === "") {
        throw new Error("process worker requires a workspace directory");
    }
    const descriptor = makeRecoveryDescriptor();
    const h = createComponents(workspace, { clock: () => NOW_MS + 100 });

    if (mode === "interrupt") {
        if (boundary === "manifest") {
            const createIfAbsent = h.manifestStore.createIfAbsent.bind(h.manifestStore);
            h.manifestStore.createIfAbsent = (...args) => {
                const manifest = createIfAbsent(...args);
                terminateWorkerAtBoundary(boundary);
                return manifest;
            };
        } else if (boundary === "partial-intents") {
            const createIntent = h.service.createPaymentIntent.bind(h.service);
            let created = 0;
            h.service.createPaymentIntent = (...args) => {
                const intent = createIntent(...args);
                created += 1;
                if (created === 1) terminateWorkerAtBoundary(boundary);
                return intent;
            };
        } else if (boundary === "intent-before-wallet-snapshot") {
            h.service.persistSnapshot = () => terminateWorkerAtBoundary(boundary);
        } else if (boundary === "partial-stakes" || boundary === "all-stakes") {
            const recordStake = h.ledger.recordPlayerStake.bind(h.ledger);
            let recorded = 0;
            h.ledger.recordPlayerStake = (...args) => {
                const result = recordStake(...args);
                recorded += 1;
                if ((boundary === "partial-stakes" && recorded === 1)
                    || (boundary === "all-stakes" && recorded === 2)) {
                    terminateWorkerAtBoundary(boundary);
                }
                return result;
            };
        } else {
            throw new Error(`unsupported process interruption boundary: ${boundary}`);
        }

        h.adapter.prepareRoom(descriptor);
        throw new Error(`process worker did not reach interruption boundary: ${boundary}`);
    }

    if (mode === "recover") {
        const beforeRetry = durablePreparationSnapshot(h, descriptor.roomId);
        h.adapter.prepareRoom(descriptor);
        const afterPreparation = durablePreparationSnapshot(h, descriptor.roomId);
        h.adapter.prepareRoom(descriptor);
        workerDeepEqual(durablePreparationSnapshot(h, descriptor.roomId), afterPreparation,
            "exact prepareRoom retry changed persisted records");

        const beforeConflict = durablePreparationSnapshot(h, descriptor.roomId);
        const conflictingDescriptor = makeRecoveryDescriptor();
        conflictingDescriptor.requiredPlayers = conflictingDescriptor.requiredPlayers.map(
            (payment, index) => index === 0
                ? { ...payment, playerId: "conflicting-process-recovery-player" }
                : payment
        );
        let conflictRejected = false;
        try {
            h.adapter.prepareRoom(conflictingDescriptor);
        } catch (error) {
            conflictRejected = error instanceof RoomPaymentSessionValidationError;
        }
        workerAssert(conflictRejected, "conflicting process recovery descriptor was not rejected");
        workerDeepEqual(durablePreparationSnapshot(h, descriptor.roomId), beforeConflict,
            "conflicting descriptor changed persisted records");
        workerAssert(h.fetchCalls === 0, "prepareRoom recovery made a provider request");

        process.stdout.write(`PROCESS_WORKER_RECOVERED:${JSON.stringify({
            pid: process.pid,
            fetchCalls: h.fetchCalls,
            recordsUnchangedOnExactRetry: true,
            conflictRejectedWithoutWrites: true,
            initialSnapshot: beforeRetry
        })}\n`);
        return;
    }

    throw new Error(`unsupported process worker mode: ${mode}`);
}

function spawnManifestProcessWorker(mode, workspace, boundary = "") {
    const workerEnv = {};
    for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
        if (typeof process.env[key] === "string") workerEnv[key] = process.env[key];
    }
    return spawnSync(process.execPath, [
        fileURLToPath(import.meta.url),
        "--manifest-process-worker",
        mode,
        workspace,
        boundary
    ], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
        env: workerEnv
    });
}

function transactionFor(intent, wallet, overrides = {}) {
    const source = overrides.source ?? intent.expectedSender;
    const inMessage = {
        source,
        destination: wallet.address,
        value: String(overrides.amountAtomic ?? intent.amountAtomic),
        message_content: {
            decoded: {
                type: "text_comment",
                comment: formatPaymentReference(intent.paymentReference)
            }
        }
    };
    return {
        account: wallet.address,
        hash: createHash("sha256")
            .update(`${intent.paymentReference}:${overrides.suffix ?? "transaction"}`)
            .digest("hex"),
        now: overrides.nowSeconds ?? TRANSFER_SECONDS,
        description: { aborted: false, compute_ph: { success: true }, action: { success: true } },
        in_msg: inMessage
    };
}

function emptyPayload(...transactions) {
    return { transactions, address_book: {} };
}

function createComponents(workspace, {
    payload = emptyPayload(),
    status = 200,
    limit = 50,
    clock = () => NOW_MS,
    ledgerDataDir = join(workspace, "ledger-data"),
    intentDataDir = join(workspace, "payment-data"),
    manifestDataDir = join(workspace, "preparation-manifests"),
    persistSnapshots = true,
    assetDefinitions = null
} = {}) {
    const configDir = join(workspace, "config");
    mkdirSync(configDir, { recursive: true });
    const catalogPath = join(configDir, "synthetic-public-wallets.json");
    writeSyntheticCatalog(catalogPath);

    let responsePayload = payload;
    let responseStatus = status;
    let fetchCalls = 0;
    const walletPool = new WalletPoolRegistry({ catalogPath, network: "testnet" });
    const intentStore = new PaymentIntentStore({ dataDir: intentDataDir, nowProvider: clock });
    const assetRegistry = AssetDenominationRegistry.fromConfiguration({
        assets: assetDefinitions ?? [
            { asset: "TON", symbol: "Gram", network: "testnet", atomicUnitsPerUnit: 1_000_000_000 },
            { asset: "USDT", symbol: "USDT", network: "testnet", atomicUnitsPerUnit: 1 }
        ]
    });
    const client = new ToncenterTransactionsClient({
        apiKeyProvider: () => SYNTHETIC_API_KEY,
        fetchImpl: async () => {
            fetchCalls += 1;
            return { status: responseStatus, json: async () => responsePayload };
        }
    });
    const observationService = new RoomPaymentObservationService({
        provider: new ToncenterIncomingProvider({ client }),
        nowProvider: clock,
        limit
    });
    const service = new RoomWalletPaymentService({
        walletPool,
        intentStore,
        assetRegistry,
        observationService,
        snapshotDir: intentDataDir,
        nowProvider: clock,
        persistSnapshots
    });
    service.initialize();
    const coordinator = new IncomingPaymentSettlementCoordinator({
        paymentService: service,
        observationService,
        nowProvider: clock
    });
    const ledgerStore = new LedgerStore({ dataDir: ledgerDataDir, nowProvider: clock });
    const ledger = new RoomLedger({
        store: ledgerStore,
        currency: CurrencyMapping.nativeTon({ network: "testnet" }),
        intentStore
    });
    ledger.initialize();
    const manifestStore = new RoomPreparationManifestStore({ dataDir: manifestDataDir });
    manifestStore.initialize();
    const adapter = new RoomPaymentSessionAdapter({
        paymentService: service,
        coordinator,
        ledger,
        manifestStore,
        nowProvider: clock
    });

    return {
        workspace,
        manifestStore,
        walletPool,
        intentStore,
        assetRegistry,
        client,
        observationService,
        service,
        coordinator,
        ledger,
        adapter,
        get fetchCalls() { return fetchCalls; },
        setPayload(nextPayload) { responsePayload = nextPayload; },
        setStatus(nextStatus) { responseStatus = nextStatus; },
        close({ remove = true } = {}) {
            service.shutdown();
            if (remove) rmSync(workspace, { recursive: true, force: true });
        }
    };
}

function freshHarness(options = {}) {
    const workspace = mkdtempSync(join(tmpdir(), "wheelwin-session-adapter-"));
    return createComponents(workspace, options);
}

function persistSyntheticPoolSnapshot(workspace, snapshotDir, reservations = []) {
    const pool = new WalletPoolRegistry({
        catalogPath: join(workspace, "config", "synthetic-public-wallets.json"),
        network: "testnet"
    });
    pool.initialize();
    for (const reservation of reservations) {
        pool.reserve({
            roomId: reservation.roomId,
            network: "testnet",
            walletId: reservation.walletId
        });
    }
    return pool.persistSnapshot(snapshotDir);
}

async function withHarness(options, callback) {
    const harness = freshHarness(options);
    try {
        await callback(harness);
    } finally {
        harness.close();
    }
}

function principalEntries(ledger, roomId) {
    return ledger.store.listForRoom(roomId)
        .filter((entry) => entry.kind === LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL);
}

function intentEntries(service, roomId) {
    return service.listPaymentIntentsForRoom(roomId);
}

async function run() {
    await section("valid descriptor creates exact intents and one required stake each", async () => {
        await withHarness({}, (h) => {
            const descriptor = makeDescriptor({ requiredPlayers: [
                makeDescriptor().requiredPlayers[0],
                {
                    roomId: "room-session-1",
                    paymentReference: "WW-SESSION-PLAYER-2",
                    playerId: "player-2",
                    expectedSender: syntheticAddress("sender-2"),
                    amountAtomic: 3_000_000_000
                }
            ] });
            const prepared = h.adapter.prepareRoom(descriptor);
            equal(prepared.payments.length, 2, "one intent returned per required player");
            equal(intentEntries(h.service, descriptor.roomId).length, 2, "two intents persisted");
            equal(h.service.getWalletForRoom(descriptor.roomId).network, "testnet", "room wallet reserved");
            const manifest = h.manifestStore.get(descriptor.roomId);
            equal(manifest.schemaVersion, 1, "room preparation manifest has the current schema version");
            equal(manifest.preparationStartedAtMs, NOW_MS,
                "manifest captures the authoritative preparation start time");
            equal(manifest.descriptor.roomDeadlineMs, CREATED_AT + ROOM_LIFETIME_MS,
                "manifest stores the applicable immutable room deadline");
            equal(manifest.descriptor.requiredPlayers.length, 2,
                "manifest stores the complete required player set");
            equal(manifest.descriptor.denomination.atomicUnitsPerUnit, 1_000_000_000,
                "manifest binds preparation to the authoritative TON denomination");
            equal(h.ledger.store.listForRoom(descriptor.roomId).filter(
                (entry) => entry.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE
            ).length, 2, "each payment has one obligation stake entry");
            equal(h.ledger.store.listForRoom(descriptor.roomId).filter(
                (entry) => entry.kind === LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL
            ).length, 0, "stake entries do not claim principal was received");
            equal(h.service.getPaymentIntent("WW-SESSION-PLAYER-1").roomDeadlineMs,
                CREATED_AT + ROOM_LIFETIME_MS, "intent uses immutable room deadline");
        });
    });

    await section("future room creation timestamps fail before writes while current timestamps remain valid", async () => {
        await withHarness({}, (h) => {
            const futureDescriptor = makeDescriptor({
                roomId: "room-future-created-at",
                roomCreatedAt: NOW_MS + 1
            });
            throws(() => h.adapter.prepareRoom(futureDescriptor),
                RoomPaymentSessionValidationError, "future room creation timestamp is rejected");
            equal(intentEntries(h.service, futureDescriptor.roomId).length, 0,
                "future timestamp creates no payment intents");
            equal(h.service.getWalletForRoom(futureDescriptor.roomId), null,
                "future timestamp reserves no room wallet");
            equal(h.ledger.store.size, 0,
                "future timestamp writes no ledger entries");

            const currentDescriptor = makeDescriptor({
                roomId: "room-current-created-at",
                roomCreatedAt: NOW_MS
            });
            h.adapter.prepareRoom(currentDescriptor);
            equal(intentEntries(h.service, currentDescriptor.roomId).length, 1,
                "current room creation timestamp remains accepted");
            equal(h.service.getWalletForRoom(currentDescriptor.roomId).network, "testnet",
                "current timestamp still reserves the supported testnet wallet");
            equal(h.ledger.store.listForRoom(currentDescriptor.roomId).filter(
                (entry) => entry.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE
            ).length, 1, "current timestamp records its stake");
        });
    });

    await section("mainnet descriptors fail before writes while testnet remains supported", async () => {
        await withHarness({}, (h) => {
            const mainnetDescriptor = makeDescriptor({
                roomId: "room-mainnet-rejected",
                network: "mainnet"
            });
            throws(() => h.adapter.prepareRoom(mainnetDescriptor),
                RoomPaymentSessionValidationError, "mainnet descriptor is explicitly rejected");
            equal(intentEntries(h.service, mainnetDescriptor.roomId).length, 0,
                "mainnet rejection creates no payment intents");
            equal(h.service.getWalletForRoom(mainnetDescriptor.roomId), null,
                "mainnet rejection reserves no room wallet");
            equal(h.ledger.store.size, 0,
                "mainnet rejection writes no ledger entries");

            const testnetDescriptor = makeDescriptor({
                roomId: "room-testnet-after-mainnet-rejection"
            });
            h.adapter.prepareRoom(testnetDescriptor);
            equal(intentEntries(h.service, testnetDescriptor.roomId).length, 1,
                "valid testnet descriptor still creates its payment intent");
            equal(h.service.getWalletForRoom(testnetDescriptor.roomId).network, "testnet",
                "valid testnet descriptor still reserves a testnet wallet");
            equal(h.ledger.store.listForRoom(testnetDescriptor.roomId).filter(
                (entry) => entry.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE
            ).length, 1, "valid testnet descriptor still records its stake");
        });
    });

    await section("amount preflight uses the service mapping and rejects missing or inconsistent denominations", async () => {
        await withHarness({}, (h) => {
            const mapping = h.service.requireAssetDenomination("testnet", "TON");
            check(Object.isFrozen(mapping),
                "public denomination lookup returns an immutable mapping");
            throws(() => { mapping.atomicUnitsPerUnit = 2_000_000_000; }, TypeError,
                "public denomination mapping cannot be mutated by a caller");
            equal(h.service.requireAssetDenomination("testnet", "TON").atomicUnitsPerUnit,
                1_000_000_000,
                "caller mutation cannot change the service's authoritative mapping");
            equal(mapping.toAtomicUnits(1), 1_000_000_000,
                "authoritative mapping keeps one Gram equal to one TON in nanotons");
            equal(mapping.toAtomicUnits(10), 10_000_000_000,
                "authoritative mapping keeps ten Gram equal to ten TON in nanotons");
            const descriptor = makeDescriptor({
                roomId: "room-authoritative-denomination",
                requiredPlayers: [1, 10].map((grams) => ({
                    roomId: "room-authoritative-denomination",
                    paymentReference: `WW-DENOMINATION-${grams}`,
                    playerId: `denomination-player-${grams}`,
                    expectedSender: syntheticAddress(`denomination-sender-${grams}`),
                    amountAtomic: mapping.toAtomicUnits(grams)
                }))
            });
            const authoritativeLookup = h.service.requireAssetDenomination.bind(h.service);
            let publicLookupCalls = 0;
            h.service.requireAssetDenomination = (...args) => {
                publicLookupCalls += 1;
                return authoritativeLookup(...args);
            };
            const prepared = h.adapter.prepareRoom(descriptor);
            equal(publicLookupCalls, 1,
                "adapter validates through the payment service public denomination API");
            equal(prepared.payments[0].amountAtomic, mapping.toAtomicUnits(1),
                "one-Gram descriptor is accepted using the service mapping");
            equal(prepared.payments[1].amountAtomic, mapping.toAtomicUnits(10),
                "ten-Gram descriptor is accepted using the service mapping");
        });

        await withHarness({ assetDefinitions: [
            { asset: "USDT", symbol: "USDT", network: "testnet", atomicUnitsPerUnit: 1 }
        ] }, (h) => {
            const descriptor = makeDescriptor({ roomId: "room-missing-denomination" });
            throws(() => h.adapter.prepareRoom(descriptor), RoomPaymentSessionValidationError,
                "missing authoritative TON mapping is rejected in preflight");
            equal(intentEntries(h.service, descriptor.roomId).length, 0,
                "missing mapping creates no payment intents");
            equal(h.service.getWalletForRoom(descriptor.roomId), null,
                "missing mapping reserves no room wallet");
            equal(h.ledger.store.size, 0, "missing mapping writes no ledger entries");
        });

        await withHarness({}, (h) => {
            const descriptor = makeDescriptor({ roomId: "room-inconsistent-denomination" });
            h.assetRegistry.configure({
                asset: "TON",
                symbol: "Gram",
                network: "testnet",
                atomicUnitsPerUnit: 2_000_000_000
            });
            throws(() => h.adapter.prepareRoom(descriptor), RoomPaymentSessionValidationError,
                "service and ledger denomination mismatch is rejected in preflight");
            equal(intentEntries(h.service, descriptor.roomId).length, 0,
                "inconsistent mapping creates no payment intents");
            equal(h.service.getWalletForRoom(descriptor.roomId), null,
                "inconsistent mapping reserves no room wallet");
            equal(h.ledger.store.size, 0, "inconsistent mapping writes no ledger entries");
        });

        await withHarness({}, (h) => {
            const descriptor = makeDescriptor({ roomId: "room-redefined-gram" });
            h.assetRegistry.configure({
                asset: "TON",
                symbol: "Gram",
                network: "testnet",
                atomicUnitsPerUnit: 2_000_000_000
            });
            h.ledger._currency = CurrencyMapping.nativeTon({
                network: "testnet",
                atomicUnitsPerUnit: 2_000_000_000
            });
            throws(() => h.adapter.prepareRoom(descriptor), RoomPaymentSessionValidationError,
                "matching alternate mappings cannot redefine Gram as two TON");
            equal(intentEntries(h.service, descriptor.roomId).length, 0,
                "redefined Gram mapping creates no payment intents");
            equal(h.service.getWalletForRoom(descriptor.roomId), null,
                "redefined Gram mapping reserves no room wallet");
            equal(h.ledger.store.size, 0, "redefined Gram mapping writes no ledger entries");
        });

        await withHarness({}, (h) => {
            const descriptor = makeDescriptor({ roomId: "room-invalid-denomination" });
            h.service.requireAssetDenomination = () => ({
                asset: "TON",
                symbol: "Gram",
                network: "testnet",
                atomicUnitsPerUnit: Number.NaN
            });
            throws(() => h.adapter.prepareRoom(descriptor), RoomPaymentSessionValidationError,
                "invalid authoritative mapping fails closed");
            equal(intentEntries(h.service, descriptor.roomId).length, 0,
                "invalid mapping creates no payment intents");
            equal(h.service.getWalletForRoom(descriptor.roomId), null,
                "invalid mapping reserves no room wallet");
            equal(h.ledger.store.size, 0, "invalid mapping writes no ledger entries");
        });

        await withHarness({}, (h) => {
            const descriptor = makeDescriptor({
                roomId: "room-unrepresentable-denomination",
                requiredPlayers: [{
                    roomId: "room-unrepresentable-denomination",
                    paymentReference: "WW-ONE-NANOTON-UNREPRESENTABLE",
                    playerId: "one-nanoton-player",
                    expectedSender: syntheticAddress("one-nanoton-sender"),
                    amountAtomic: 1
                }]
            });
            throws(() => h.adapter.prepareRoom(descriptor), RoomPaymentSessionValidationError,
                "one nanotons cannot represent an exact whole-Gram payment");
            equal(intentEntries(h.service, descriptor.roomId).length, 0,
                "unrepresentable amount creates no payment intents");
            equal(h.service.getWalletForRoom(descriptor.roomId), null,
                "unrepresentable amount reserves no room wallet");
            equal(h.ledger.store.size, 0, "unrepresentable amount writes no ledger entries");
        });
    });

    await section("repeated preparation is idempotent", async () => {
        await withHarness({}, (h) => {
            const descriptor = makeDescriptor();
            const first = h.adapter.prepareRoom(descriptor);
            const wallet = h.service.getWalletForRoom(descriptor.roomId).walletId;
            const second = h.adapter.prepareRoom(descriptor);
            equal(first.payments[0].paymentReference, second.payments[0].paymentReference,
                "repeated setup returns the same reference");
            equal(h.service.getWalletForRoom(descriptor.roomId).walletId, wallet,
                "repeated setup reuses the room wallet");
            equal(intentEntries(h.service, descriptor.roomId).length, 1,
                "repeated setup does not duplicate intents");
            equal(h.ledger.store.listForRoom(descriptor.roomId).filter(
                (entry) => entry.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE
            ).length, 1, "repeated setup does not duplicate stake records");
        });

        await withHarness({}, (h) => {
            const descriptor = makeDescriptor({ roomId: "room-manifest-reference-replay" });
            const originalAppend = h.ledger.recordPlayerStake.bind(h.ledger);
            h.ledger.recordPlayerStake = (request) => originalAppend({
                ...request,
                idempotencyKey: `alternate:${request.paymentReference}`
            });
            const first = h.adapter.prepareRoom(descriptor);
            const persistedStake = h.ledger.store.listForRoom(descriptor.roomId).find(
                (entry) => entry.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE
            );
            equal(persistedStake.idempotencyKey,
                `alternate:${descriptor.requiredPlayers[0].paymentReference}`,
                "manifest preparation can identify a stake persisted under another key");
            h.ledger.recordPlayerStake = originalAppend;
            const replay = h.adapter.prepareRoom(descriptor);
            equal(replay.payments[0].paymentReference, first.payments[0].paymentReference,
                "exact preparation retry retains the original payment reference");
            equal(h.ledger.store.listForRoom(descriptor.roomId).filter(
                (entry) => entry.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE
            ).length, 1,
            "reference replay does not create a duplicate stake under the adapter key");
            equal(h.ledger.store.listForRoom(descriptor.roomId).find(
                (entry) => entry.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE
            ).entryId, persistedStake.entryId,
            "reference replay retains the original persisted stake entry ID");
        });
    });

    await section("duplicate and inconsistent descriptors fail before partial state creation", async () => {
        await withHarness({}, (h) => {
            const base = makeDescriptor();
            const duplicateReference = makeDescriptor({ requiredPlayers: [
                base.requiredPlayers[0],
                { ...base.requiredPlayers[0], playerId: "player-2" }
            ] });
            throws(() => h.adapter.prepareRoom(duplicateReference),
                RoomPaymentSessionValidationError, "duplicate reference rejected");
            const duplicatePlayer = makeDescriptor({ requiredPlayers: [
                base.requiredPlayers[0],
                { ...base.requiredPlayers[0], paymentReference: "WW-SESSION-PLAYER-2" }
            ] });
            throws(() => h.adapter.prepareRoom(duplicatePlayer),
                RoomPaymentSessionValidationError, "duplicate player rejected");
            const crossRoom = makeDescriptor({ requiredPlayers: [
                { ...base.requiredPlayers[0], roomId: "another-room" }
            ] });
            throws(() => h.adapter.prepareRoom(crossRoom),
                RoomPaymentSessionValidationError, "cross-room requirement rejected");
            const invalidLaterDenomination = makeDescriptor({ requiredPlayers: [
                base.requiredPlayers[0],
                {
                    roomId: base.roomId,
                    paymentReference: "WW-SESSION-PLAYER-2",
                    playerId: "player-2",
                    expectedSender: syntheticAddress("sender-2"),
                    amountAtomic: 1
                }
            ] });
            throws(() => h.adapter.prepareRoom(invalidLaterDenomination),
                RoomPaymentSessionValidationError,
                "later invalid denomination rejected before creating earlier payment");
            equal(intentEntries(h.service, base.roomId).length, 0,
                "invalid descriptors create no intents");
            equal(h.service.getWalletForRoom(base.roomId), null,
                "invalid descriptors reserve no room wallet");
            equal(h.ledger.store.size, 0, "invalid descriptors write no ledger records");
        });
    });

    await section("missing required descriptor fields are rejected", async () => {
        await withHarness({}, (h) => {
            const valid = makeDescriptor();
            for (const field of ["roomId", "roomCreatedAt", "network", "asset", "requiredPlayers", "stakeLedgerRelation"]) {
                const missing = { ...valid };
                delete missing[field];
                throws(() => h.adapter.prepareRoom(missing),
                    RoomPaymentSessionValidationError, `missing ${field} rejected`);
            }
            for (const field of ["roomId", "paymentReference", "playerId", "expectedSender", "amountAtomic"]) {
                const row = { ...valid.requiredPlayers[0] };
                delete row[field];
                throws(() => h.adapter.prepareRoom({
                    ...valid,
                    requiredPlayers: [row]
                }), RoomPaymentSessionValidationError, `missing payment ${field} rejected`);
            }
            equal(intentEntries(h.service, valid.roomId).length, 0,
                "missing fields leave intents untouched");
            equal(h.ledger.store.size, 0, "missing fields leave ledger untouched");
        });
    });

    await section("fractional, unsafe, zero, and negative amounts are rejected", async () => {
        await withHarness({}, (h) => {
            for (const amountAtomic of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
                const descriptor = makeDescriptor({ requiredPlayers: [{
                    ...makeDescriptor().requiredPlayers[0],
                    amountAtomic
                }] });
                throws(() => h.adapter.prepareRoom(descriptor),
                    RoomPaymentSessionValidationError, `invalid amount ${String(amountAtomic)} rejected`);
            }
            equal(intentEntries(h.service, "room-session-1").length, 0,
                "invalid amounts create no intents");
            equal(h.service.getWalletForRoom("room-session-1"), null,
                "invalid amounts reserve no room wallet");
            equal(h.ledger.store.size, 0, "invalid amounts create no ledger records");
        });
    });

    await section("480-second deadline and expired-intent behavior are preserved", async () => {
        let currentNow = NOW_MS;
        await withHarness({ clock: () => currentNow }, (h) => {
            const descriptor = makeDescriptor();
            h.adapter.prepareRoom(descriptor);
            const intent = h.service.getPaymentIntent(descriptor.requiredPlayers[0].paymentReference);
            equal(intent.expiresAt, CREATED_AT + ROOM_LIFETIME_MS,
                "expiresAt is capped at room deadline");
            const wallet = h.service.getWalletForRoom(descriptor.roomId);
            h.setPayload(emptyPayload(transactionFor(intent, wallet)));
            currentNow = intent.expiresAt;
            return h.adapter.observeRoomPayments({ roomId: descriptor.roomId }).then((result) => {
                equal(result.report.settled.length, 0, "expired intent does not settle");
                equal(principalEntries(h.ledger, descriptor.roomId).length, 0,
                    "expired intent does not create principal");
                equal(h.service.getPaymentIntent(intent.paymentReference).state,
                    PAYMENT_INTENT_STATE.PENDING, "expired intent remains an open nonsettled obligation");
                currentNow = CREATED_AT + ROOM_LIFETIME_MS;
                const expiredRoom = makeDescriptor({
                    roomId: "room-expired",
                    roomCreatedAt: CREATED_AT
                });
                throws(() => h.adapter.prepareRoom(expiredRoom),
                    RoomPaymentSessionValidationError, "expired room descriptor rejected");
                equal(h.service.getWalletForRoom("room-expired"), null,
                    "expired room does not reserve wallet");
            });
        });
    });

    await section("complete synthetic observation settles and records principal once", async () => {
        await withHarness({}, async (h) => {
            const descriptor = makeDescriptor();
            h.adapter.prepareRoom(descriptor);
            const intent = h.service.getPaymentIntent(descriptor.requiredPlayers[0].paymentReference);
            h.setPayload(emptyPayload(transactionFor(intent, h.service.getWalletForRoom(descriptor.roomId))));
            const first = await h.adapter.observeRoomPayments({ roomId: descriptor.roomId });
            equal(first.report.settled.length, 1,
                `coordinator settles exact payment; report=${JSON.stringify(first.report)}`);
            equal(first.principalEntries.length, 1, "one principal entry is recorded");
            equal(principalEntries(h.ledger, descriptor.roomId)[0].amountAtomic,
                intent.amountAtomic, "principal equals persisted intent amount");
            const replay = await h.adapter.observeRoomPayments({ roomId: descriptor.roomId });
            equal(replay.report.alreadySettled.length, 1, "repeat reports authoritative settled intent");
            equal(replay.report.mode, "PERSISTED_SETTLEMENT_RECOVERY",
                "all-settled replay is distinguished from a provider observation");
            equal(replay.report.resultWindowComplete, false,
                "persisted replay does not claim a provider result window");
            equal(replay.principalEntries[0].replay, true, "repeat recognizes existing principal entry");
            equal(principalEntries(h.ledger, descriptor.roomId).length, 1,
                "replay cannot double-book principal");
            equal(h.fetchCalls, 1, "settled replay performs no second provider request");
        });
    });

    await section("adapter unwraps and validates fresh and replayed principal append results", async () => {
        await withHarness({}, async (h) => {
            const descriptor = makeDescriptor({
                roomId: "room-principal-append-contract",
                requiredPlayers: [{
                    roomId: "room-principal-append-contract",
                    paymentReference: "WW-APPEND-CONTRACT-1",
                    playerId: "append-contract-player",
                    expectedSender: syntheticAddress("append-contract-sender"),
                    amountAtomic: 2_000_000_000
                }]
            });
            h.adapter.prepareRoom(descriptor);
            const intent = h.service.getPaymentIntent(descriptor.requiredPlayers[0].paymentReference);
            h.setPayload(emptyPayload(transactionFor(
                intent,
                h.service.getWalletForRoom(descriptor.roomId)
            )));

            const fresh = await h.adapter.observeRoomPayments({ roomId: descriptor.roomId });
            const persisted = principalEntries(h.ledger, descriptor.roomId)[0];
            equal(fresh.principalEntries[0].entryId, persisted.entryId,
                "fresh append exposes the persisted ledger entry ID");
            equal(fresh.principalEntries[0].replay, false,
                "fresh append is reported as a new ledger entry");

            const findByIdempotencyKey = h.ledger.store.findByIdempotencyKey.bind(h.ledger.store);
            const key = `ww:incoming-principal:${intent.paymentReference}`;
            let keyLookups = 0;
            h.ledger.store.findByIdempotencyKey = (requestedKey) => {
                if (requestedKey === key && keyLookups < 2) {
                    keyLookups += 1;
                    return null;
                }
                return findByIdempotencyKey(requestedKey);
            };
            let replay;
            try {
                replay = await h.adapter.observeRoomPayments({ roomId: descriptor.roomId });
            } finally {
                h.ledger.store.findByIdempotencyKey = findByIdempotencyKey;
            }
            equal(replay.principalEntries[0].entryId, persisted.entryId,
                "append replay exposes the existing persisted entry ID");
            equal(replay.principalEntries[0].replay, true,
                "append replay is reported as an idempotent replay");
            equal(principalEntries(h.ledger, descriptor.roomId).length, 1,
                "append replay does not create a duplicate principal entry");
        });

        for (const [label, malformedResult] of [
            ["missing-entry", { replay: false }],
            ["unpersisted-entry", { replay: false, entry: { entryId: "fabricated-entry-id" } }]
        ]) {
            await withHarness({}, async (h) => {
                const roomId = `room-principal-malformed-${label}`;
                const descriptor = makeDescriptor({
                    roomId,
                    requiredPlayers: [{
                        roomId,
                        paymentReference: `WW-MALFORMED-${label.toUpperCase()}`,
                        playerId: `malformed-${label}-player`,
                        expectedSender: syntheticAddress(`malformed-${label}-sender`),
                        amountAtomic: 2_000_000_000
                    }]
                });
                h.adapter.prepareRoom(descriptor);
                const intent = h.service.getPaymentIntent(descriptor.requiredPlayers[0].paymentReference);
                h.setPayload(emptyPayload(transactionFor(
                    intent,
                    h.service.getWalletForRoom(roomId)
                )));
                h.ledger.recordIncomingPrincipal = () => malformedResult;

                await rejects(h.adapter.observeRoomPayments({ roomId }),
                    RoomPaymentSessionValidationError,
                    `${label} append result does not report success`);
                equal(principalEntries(h.ledger, roomId).length, 0,
                    `${label} append result creates no reported principal entry`);
            });
        }
    });

    await section("incomplete, ambiguous, mismatched, and provider-error observations book no principal", async () => {
        await withHarness({ limit: 1 }, async (h) => {
            const descriptor = makeDescriptor();
            h.adapter.prepareRoom(descriptor);
            const intent = h.service.getPaymentIntent(descriptor.requiredPlayers[0].paymentReference);
            const wallet = h.service.getWalletForRoom(descriptor.roomId);
            h.setPayload(emptyPayload(
                transactionFor(intent, wallet, { suffix: "page-1" }),
                transactionFor(intent, wallet, { suffix: "page-2" })
            ));
            const result = await h.adapter.observeRoomPayments({ roomId: descriptor.roomId });
            equal(result.report.refusal, "OBSERVATION_WINDOW_INCOMPLETE",
                "truncated provider window is refused");
            equal(principalEntries(h.ledger, descriptor.roomId).length, 0,
                "incomplete observation creates no principal");
        });

        await withHarness({}, async (h) => {
            const descriptor = makeDescriptor();
            h.adapter.prepareRoom(descriptor);
            const intent = h.service.getPaymentIntent(descriptor.requiredPlayers[0].paymentReference);
            const wallet = h.service.getWalletForRoom(descriptor.roomId);
            h.setPayload(emptyPayload(
                transactionFor(intent, wallet, { suffix: "ambiguous-1" }),
                transactionFor(intent, wallet, { suffix: "ambiguous-2" })
            ));
            const result = await h.adapter.observeRoomPayments({ roomId: descriptor.roomId });
            equal(result.report.refusal, "AMBIGUOUS_OBSERVATION",
                "ambiguous observation is refused");
            equal(principalEntries(h.ledger, descriptor.roomId).length, 0,
                "ambiguous observation creates no principal");
        });

        await withHarness({}, async (h) => {
            const descriptor = makeDescriptor();
            h.adapter.prepareRoom(descriptor);
            const intent = h.service.getPaymentIntent(descriptor.requiredPlayers[0].paymentReference);
            h.setPayload(emptyPayload(transactionFor(intent,
                h.service.getWalletForRoom(descriptor.roomId), { source: syntheticAddress("wrong-sender") })));
            const result = await h.adapter.observeRoomPayments({ roomId: descriptor.roomId });
            equal(result.report.settled.length, 0, "wrong sender does not settle");
            equal(principalEntries(h.ledger, descriptor.roomId).length, 0,
                "mismatch creates no principal");
        });

        await withHarness({}, async (h) => {
            const descriptor = makeDescriptor();
            h.adapter.prepareRoom(descriptor);
            h.setStatus(429);
            await rejects(h.adapter.observeRoomPayments({ roomId: descriptor.roomId }),
                ToncenterRateLimitError, "provider rate-limit error is propagated");
            equal(principalEntries(h.ledger, descriptor.roomId).length, 0,
                "provider error creates no principal");
            equal(h.fetchCalls, 1, "provider error is not retried");
        });
    });

    await section("caller evidence objects, IDs, strings, proxies, and flags cannot authorize settlement", async () => {
        await withHarness({}, async (h) => {
            const descriptor = makeDescriptor();
            h.adapter.prepareRoom(descriptor);
            const evidence = {
                roomId: descriptor.roomId,
                transactionId: "caller-transaction-id",
                observation: { complete: true },
                confirmation: "SETTLED",
                providerConfirmed: true
            };
            await rejects(h.adapter.observeRoomPayments(evidence),
                RoomPaymentSessionValidationError, "caller evidence fields are rejected");
            await rejects(h.adapter.observeRoomPayments("caller-payment-reference"),
                RoomPaymentSessionValidationError, "string evidence is rejected");
            const proxy = new Proxy({ ...evidence }, {
                get() { throw new Error("proxy value access must not authorize anything"); }
            });
            await rejects(h.adapter.observeRoomPayments(proxy),
                RoomPaymentSessionValidationError, "proxy evidence wrapper is rejected");
            equal(h.fetchCalls, 0, "invalid caller evidence never reaches provider");
            equal(h.service.getPaymentIntent(descriptor.requiredPlayers[0].paymentReference).state,
                PAYMENT_INTENT_STATE.PENDING, "caller evidence cannot settle intent");
            equal(principalEntries(h.ledger, descriptor.roomId).length, 0,
                "caller evidence cannot record principal");
        });
    });

    await section("RoomLedger rejects principal unless its authoritative store has the settled intent", async () => {
        const h = freshHarness();
        const wrongIntentStore = new PaymentIntentStore({
            dataDir: join(h.workspace, "wrong-intents")
        });
        wrongIntentStore.initialize();
        const wrongLedger = new RoomLedger({
            store: new LedgerStore({ dataDir: join(h.workspace, "wrong-ledger") }),
            currency: CurrencyMapping.nativeTon({ network: "testnet" }),
            intentStore: wrongIntentStore
        });
        wrongLedger.initialize();
        const wrongAdapter = new RoomPaymentSessionAdapter({
            paymentService: h.service,
            coordinator: h.coordinator,
            ledger: wrongLedger,
            manifestStore: h.manifestStore,
            nowProvider: () => NOW_MS
        });
        try {
            const descriptor = makeDescriptor({ roomId: "room-wrong-ledger" });
            wrongAdapter.prepareRoom(descriptor);
            const intent = h.service.getPaymentIntent(descriptor.requiredPlayers[0].paymentReference);
            h.setPayload(emptyPayload(transactionFor(intent,
                h.service.getWalletForRoom(descriptor.roomId))));
            await rejects(wrongAdapter.observeRoomPayments({ roomId: descriptor.roomId }),
                PayoutValidationError, "ledger with a different authoritative store refuses principal");
            equal(h.service.getPaymentIntent(intent.paymentReference).state,
                PAYMENT_INTENT_STATE.SETTLED, "coordinator still persisted the verified settlement");
            equal(principalEntries(wrongLedger, descriptor.roomId).length, 0,
                "ledger refusal appends no principal");
            equal(wrongLedger.store.listForRoom(descriptor.roomId).filter(
                (entry) => entry.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE
            ).length, 1, "required stake record remains distinct from received principal");
            equal(wrongLedger.store.listForRoom(descriptor.roomId).filter(
                (entry) => entry.kind === LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL
            ).length, 0, "wrong authoritative store cannot confirm principal");
        } finally {
            h.close();
        }
    });

    await section("restart restores intents, wallet, stake, and principal idempotently", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "wheelwin-session-restart-"));
        let first = createComponents(workspace);
        try {
            const descriptor = makeDescriptor({
                roomId: "room-restart",
                requiredPlayers: [
                    {
                        roomId: "room-restart",
                        paymentReference: "WW-RESTART-PLAYER-1",
                        playerId: "player-1",
                        expectedSender: syntheticAddress("restart-sender-1"),
                        amountAtomic: 2_000_000_000
                    },
                    {
                        roomId: "room-restart",
                        paymentReference: "WW-RESTART-PLAYER-2",
                        playerId: "player-2",
                        expectedSender: syntheticAddress("restart-sender-2"),
                        amountAtomic: 3_000_000_000
                    }
                ]
            });
            first.adapter.prepareRoom(descriptor);
            const intent = first.service.getPaymentIntent(descriptor.requiredPlayers[0].paymentReference);
            first.setPayload(emptyPayload(transactionFor(intent,
                first.service.getWalletForRoom(descriptor.roomId))));
            await first.adapter.observeRoomPayments({ roomId: descriptor.roomId });
            const priorWalletId = first.service.getWalletForRoom(descriptor.roomId).walletId;
            equal(principalEntries(first.ledger, descriptor.roomId).length, 1,
                "one payment and principal are persisted before restart");
            first.close({ remove: false });

            first = null;
            const restarted = createComponents(workspace);
            try {
                const prepared = restarted.adapter.prepareRoom(descriptor);
                equal(prepared.payments[0].state, PAYMENT_INTENT_STATE.SETTLED,
                    "persisted settled intent is reused after restart");
                equal(prepared.payments[1].state, PAYMENT_INTENT_STATE.PENDING,
                    "open intent is restored after restart");
                equal(restarted.service.getWalletForRoom(descriptor.roomId).walletId, priorWalletId,
                    "open-obligation wallet reservation is restored");
                equal(restarted.ledger.store.listForRoom(descriptor.roomId).filter(
                    (entry) => entry.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE
                ).length, 2, "stake records survive restart without duplication");
                equal(principalEntries(restarted.ledger, descriptor.roomId).length, 1,
                    "prior principal record survives restart");
                const secondIntent = restarted.service.getPaymentIntent(
                    descriptor.requiredPlayers[1].paymentReference
                );
                restarted.setPayload(emptyPayload(transactionFor(secondIntent,
                    restarted.service.getWalletForRoom(descriptor.roomId))));
                const replay = await restarted.adapter.observeRoomPayments({ roomId: descriptor.roomId });
                equal(replay.report.alreadySettled.length, 1,
                    "coordinator reports the prior settled intent after restart");
                equal(replay.report.settled.length, 1,
                    "coordinator settles the remaining open intent after restart");
                const firstPrincipal = replay.principalEntries.find((entry) =>
                    entry.paymentReference === descriptor.requiredPlayers[0].paymentReference
                );
                equal(firstPrincipal.replay, true,
                    "post-restart replay recognizes existing principal");
                equal(principalEntries(restarted.ledger, descriptor.roomId).length, 2,
                    "restart settles remaining principal without duplicating prior entry");
            } finally {
                restarted.close();
            }
        } finally {
            if (first) first.close({ remove: false });
            rmSync(workspace, { recursive: true, force: true });
        }
    });

    await section("startup recovers the exact wallet from persisted open intents after a reservation snapshot crash", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "wheelwin-session-wallet-recovery-"));
        let first = createComponents(workspace, { persistSnapshots: false });
        try {
            const roomId = "room-wallet-crash-recovery";
            const descriptor = makeDescriptor({
                roomId,
                requiredPlayers: [1, 2].map((number) => ({
                    roomId,
                    paymentReference: `WW-WALLET-RECOVERY-${number}`,
                    playerId: `wallet-recovery-player-${number}`,
                    expectedSender: syntheticAddress(`wallet-recovery-sender-${number}`),
                    amountAtomic: number * 1_000_000_000
                }))
            });
            first.adapter.prepareRoom(descriptor);
            const inMemoryReservation = first.service.getWalletForRoom(roomId);
            equal(first.service.listPaymentIntentsForRoom(roomId).length, 2,
                "both open intents are durably written before the simulated crash");
            equal(first.ledger.store.listForRoom(roomId).filter(
                (entry) => entry.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE
            ).length, 2, "required stake records are durable before the simulated crash");

            persistSyntheticPoolSnapshot(workspace, join(workspace, "payment-data"));
            const blankSnapshot = JSON.parse(readFileSync(
                join(workspace, "payment-data", "wallet-pool.json"), "utf8"
            ));
            const snapshotWallet = blankSnapshot.reservations.find((wallet) =>
                wallet.walletId === inMemoryReservation.walletId
            );
            equal(snapshotWallet.reservedByRoomId, null,
                "durable pre-crash snapshot lacks the in-memory reservation");
            const originalWalletId = inMemoryReservation.walletId;
            const originalAddress = inMemoryReservation.address;
            first.close({ remove: false });
            first = null;

            const restarted = createComponents(workspace);
            try {
                const recovered = restarted.service.getWalletForRoom(roomId);
                equal(recovered.walletId, originalWalletId,
                    "startup restores the exact wallet ID recorded by the intents");
                equal(recovered.address, originalAddress,
                    "startup restores the exact wallet address recorded by the intents");
                const persisted = JSON.parse(readFileSync(
                    join(workspace, "payment-data", "wallet-pool.json"), "utf8"
                ));
                equal(persisted.reservations.find((wallet) =>
                    wallet.walletId === originalWalletId
                ).reservedByRoomId, roomId,
                "recovered reservation is persisted before startup succeeds");

                restarted.adapter.prepareRoom(descriptor);
                equal(restarted.service.getWalletForRoom(roomId).walletId, originalWalletId,
                    "retrying the descriptor retains the original wallet");
                equal(restarted.service.listPaymentIntentsForRoom(roomId).length, 2,
                    "retrying the descriptor does not duplicate payment intents");
                equal(restarted.ledger.store.listForRoom(roomId).filter(
                    (entry) => entry.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE
                ).length, 2, "retrying the descriptor does not duplicate stake records");
            } finally {
                restarted.close({ remove: false });
            }

            const subsequentRestart = createComponents(workspace);
            try {
                equal(subsequentRestart.service.getWalletForRoom(roomId).walletId,
                    originalWalletId, "a subsequent restart reads the persisted recovered reservation");
            } finally {
                subsequentRestart.close();
            }
        } finally {
            if (first) first.close({ remove: false });
            rmSync(workspace, { recursive: true, force: true });
        }

        const expectConflict = (label, mutate, reservations = []) => {
            const conflictWorkspace = mkdtempSync(join(tmpdir(), `wheelwin-recovery-${label}-`));
            let h = createComponents(conflictWorkspace, { persistSnapshots: false });
            try {
                const roomId = `room-recovery-${label}`;
                const descriptor = makeDescriptor({
                    roomId,
                    requiredPlayers: [1, 2].map((number) => ({
                        roomId,
                        paymentReference: `WW-${label.toUpperCase()}-${number}`,
                        playerId: `${label}-player-${number}`,
                        expectedSender: syntheticAddress(`${label}-sender-${number}`),
                        amountAtomic: number * 1_000_000_000
                    }))
                });
                h.adapter.prepareRoom(descriptor);
                mutate(h, roomId);
                persistSyntheticPoolSnapshot(
                    conflictWorkspace,
                    join(conflictWorkspace, "payment-data"),
                    reservations
                );
                h.close({ remove: false });
                h = null;
                throws(() => createComponents(conflictWorkspace), WalletAssignmentConflictError,
                    `${label} fails closed before startup completes`);
            } finally {
                if (h) h.close({ remove: false });
                rmSync(conflictWorkspace, { recursive: true, force: true });
            }
        };

        expectConflict("conflicting-ids", (h) => {
            const intents = h.service.listPaymentIntentsForRoom("room-recovery-conflicting-ids");
            const otherWallet = h.walletPool.getWallet("room-wallet-2");
            const tampered = new PaymentIntent({
                ...intents[1].toRecord(),
                destinationWalletId: otherWallet.walletId,
                destinationWalletAddress: otherWallet.address
            });
            writeFileSync(
                join(h.intentStore.intentsDir, `${tampered.paymentReference}.json`),
                `${JSON.stringify(tampered.toRecord(), null, 2)}\n`,
                "utf8"
            );
        });

        expectConflict("conflicting-addresses", (h) => {
            const intents = h.service.listPaymentIntentsForRoom("room-recovery-conflicting-addresses");
            const otherWallet = h.walletPool.getWallet("room-wallet-2");
            const tampered = new PaymentIntent({
                ...intents[1].toRecord(),
                destinationWalletAddress: otherWallet.address
            });
            writeFileSync(
                join(h.intentStore.intentsDir, `${tampered.paymentReference}.json`),
                `${JSON.stringify(tampered.toRecord(), null, 2)}\n`,
                "utf8"
            );
        });

        expectConflict("missing-wallet", (h) => {
            const intents = h.service.listPaymentIntentsForRoom("room-recovery-missing-wallet");
            const tampered = new PaymentIntent({
                ...intents[1].toRecord(),
                destinationWalletId: "room-wallet-no-longer-configured"
            });
            writeFileSync(
                join(h.intentStore.intentsDir, `${tampered.paymentReference}.json`),
                `${JSON.stringify(tampered.toRecord(), null, 2)}\n`,
                "utf8"
            );
        });

        expectConflict("reserved-elsewhere", (_h, roomId) => {}, [
            { roomId: "different-room", walletId: "room-wallet-1" }
        ]);

        expectConflict("cross-room-obligation", (h, roomId) => {
            const source = h.service.listPaymentIntentsForRoom(roomId)[0];
            h.intentStore.save(new PaymentIntent({
                ...source.toRecord(),
                paymentReference: "WW-CROSS-ROOM-OPEN",
                roomId: "different-open-room",
                playerId: "different-open-player"
            }));
        });

        const terminalWorkspace = mkdtempSync(join(tmpdir(), "wheelwin-terminal-only-wallet-"));
        let terminal = createComponents(terminalWorkspace, { persistSnapshots: false });
        try {
            const roomId = "room-terminal-only-wallet";
            const descriptor = makeDescriptor({ roomId, requiredPlayers: [{
                roomId,
                paymentReference: "WW-TERMINAL-ONLY-WALLET",
                playerId: "terminal-only-player",
                expectedSender: syntheticAddress("terminal-only-sender"),
                amountAtomic: 2_000_000_000
            }] });
            terminal.adapter.prepareRoom(descriptor);
            const intent = terminal.service.getPaymentIntent(descriptor.requiredPlayers[0].paymentReference);
            const transactionId = "synthetic-terminal-only-transaction";
            const matched = intent.transition(PAYMENT_INTENT_STATE.MATCHED, {
                transactionId,
                now: NOW_MS
            });
            terminal.intentStore.update(matched.transition(PAYMENT_INTENT_STATE.SETTLED, {
                transactionId,
                now: NOW_MS
            }));
            persistSyntheticPoolSnapshot(terminalWorkspace, join(terminalWorkspace, "payment-data"));
            terminal.close({ remove: false });
            terminal = null;
            const restarted = createComponents(terminalWorkspace);
            try {
                equal(restarted.service.getWalletForRoom(roomId), null,
                    "terminal settled-only intent does not reconstruct a wallet reservation");
                equal(restarted.service.countOpenObligations(roomId), 0,
                    "terminal settled-only room has no open wallet obligation");
            } finally {
                restarted.close();
            }
        } finally {
            if (terminal) terminal.close({ remove: false });
            rmSync(terminalWorkspace, { recursive: true, force: true });
        }
    });

    await section("restart recovers settled principal without a reservation or provider query", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "wheelwin-session-principal-recovery-"));
        let first = createComponents(workspace);
        try {
            const roomId = "room-principal-recovery";
            const requiredPlayers = Array.from({ length: 3 }, (_, index) => ({
                roomId,
                paymentReference: `WW-RECOVERY-PLAYER-${index + 1}`,
                playerId: `recovery-player-${index + 1}`,
                expectedSender: syntheticAddress(`recovery-sender-${index + 1}`),
                amountAtomic: (index + 2) * 1_000_000_000
            }));
            const descriptor = makeDescriptor({ roomId, requiredPlayers });
            first.adapter.prepareRoom(descriptor);
            const reservation = first.service.getWalletForRoom(roomId);
            const transfers = first.service.listPaymentIntentsForRoom(roomId)
                .map((intent) => transactionFor(intent, reservation));
            first.setPayload(emptyPayload(...transfers));

            const settled = await first.coordinator.settleRoomPayments({ roomId });
            equal(settled.mode, "FRESH_OBSERVATION",
                "initial crash setup uses the explicit synthetic observation path");
            equal(settled.settled.length, requiredPlayers.length,
                "all synthetic transfers become persisted SETTLED intents");
            equal(first.service.listPaymentIntentsForRoom(roomId).filter(
                (intent) => intent.state === PAYMENT_INTENT_STATE.SETTLED
            ).length, requiredPlayers.length, "all authoritative intents are persisted as SETTLED");
            equal(principalEntries(first.ledger, roomId).length, 0,
                "no principal is booked before the simulated crash");
            equal(first.fetchCalls, 1, "initial settlement uses one injected synthetic fetch");
            first.close({ remove: false });
            first = null;

            const restarted = createComponents(workspace);
            try {
                equal(restarted.service.getWalletForRoom(roomId), null,
                    "restart reconciliation releases the reservation with no open obligations");
                restarted.adapter.prepareRoom(descriptor);
                equal(principalEntries(restarted.ledger, roomId).length, 0,
                    "reloaded ledger still has no principal before recovery");

                const recovered = await restarted.adapter.observeRoomPayments({ roomId });
                equal(recovered.report.mode, "PERSISTED_SETTLEMENT_RECOVERY",
                    "adapter receives a distinct persisted-settlement recovery report");
                equal(recovered.report.observation, null,
                    "recovery report carries no provider observation");
                equal(recovered.report.resultWindowComplete, false,
                    "recovery does not claim a completed observation window");
                equal(recovered.report.settled.length, 0,
                    "recovery does not report a new settlement event");
                equal(recovered.report.alreadySettled.length, requiredPlayers.length,
                    "recovery identifies every persisted settled intent");
                equal(recovered.principalEntries.length, requiredPlayers.length,
                    "recovery books principal for every required player");
                const booked = principalEntries(restarted.ledger, roomId);
                equal(booked.length, requiredPlayers.length,
                    "one incoming-principal entry exists per recovered payment");
                equal(booked.reduce((sum, entry) => sum + entry.amountAtomic, 0),
                    requiredPlayers.reduce((sum, payment) => sum + payment.amountAtomic, 0),
                    "recovered principal total matches authoritative intent amounts");
                for (const payment of requiredPlayers) {
                    const matchingEntries = booked.filter((entry) =>
                        entry.metadata.paymentReference === payment.paymentReference
                    );
                    const authoritative = restarted.service.getPaymentIntent(payment.paymentReference);
                    equal(matchingEntries.length, 1,
                        `one principal entry is attributed to ${payment.paymentReference}`);
                    equal(matchingEntries[0].playerId, authoritative.playerId,
                        `principal player matches persisted intent ${payment.paymentReference}`);
                    equal(matchingEntries[0].amountAtomic, authoritative.amountAtomic,
                        `principal amount matches persisted intent ${payment.paymentReference}`);
                    equal(matchingEntries[0].metadata.transactionId, authoritative.transactionId,
                        `principal transaction matches persisted intent ${payment.paymentReference}`);
                }
                equal(restarted.fetchCalls, 0,
                    "already-settled recovery performs no provider query");

                const replay = await restarted.adapter.observeRoomPayments({ roomId });
                equal(replay.report.mode, "PERSISTED_SETTLEMENT_RECOVERY",
                    "repeated recovery remains distinguishable from observation");
                equal(replay.principalEntries.filter((entry) => entry.replay).length,
                    requiredPlayers.length, "repeated recovery replays every existing principal entry");
                equal(principalEntries(restarted.ledger, roomId).length, requiredPlayers.length,
                    "repeated recovery does not double-book principal");
                equal(restarted.fetchCalls, 0,
                    "repeated recovery still performs no provider query");
            } finally {
                restarted.close();
            }
        } finally {
            if (first) first.close({ remove: false });
            rmSync(workspace, { recursive: true, force: true });
        }

        const mixedWorkspace = mkdtempSync(join(tmpdir(), "wheelwin-session-recovery-fail-closed-"));
        let mixedFirst = createComponents(mixedWorkspace);
        try {
            const roomId = "room-recovery-mixed";
            const requiredPlayers = [1, 2].map((number) => ({
                roomId,
                paymentReference: `WW-RECOVERY-MIXED-${number}`,
                playerId: `recovery-mixed-player-${number}`,
                expectedSender: syntheticAddress(`recovery-mixed-sender-${number}`),
                amountAtomic: number * 1_000_000_000
            }));
            const descriptor = makeDescriptor({ roomId, requiredPlayers });
            mixedFirst.adapter.prepareRoom(descriptor);
            const reservation = mixedFirst.service.getWalletForRoom(roomId);
            const firstIntent = mixedFirst.service.getPaymentIntent(requiredPlayers[0].paymentReference);
            mixedFirst.setPayload(emptyPayload(transactionFor(firstIntent, reservation)));
            const initial = await mixedFirst.coordinator.settleRoomPayments({ roomId });
            equal(initial.settled.length, 1, "mixed-room setup persists one genuine settlement");
            mixedFirst.service.cancelPayment(requiredPlayers[1].paymentReference);
            mixedFirst.close({ remove: false });
            mixedFirst = null;

            const mixedRestart = createComponents(mixedWorkspace);
            try {
                equal(mixedRestart.service.getWalletForRoom(roomId), null,
                    "restart releases reservation when no obligations remain open");
                mixedRestart.adapter.prepareRoom(descriptor);
                const refused = await mixedRestart.adapter.observeRoomPayments({ roomId });
                equal(refused.report.refusal, "NO_ROOM_WALLET_RESERVATION",
                    "a room with a non-settled intent and no reservation fails closed");
                equal(refused.report.mode, "REFUSED", "fail-closed result is not recovery or observation");
                equal(refused.report.alreadySettled.length, 0,
                    "mixed room is not partially recovered");
                equal(refused.principalEntries.length, 0,
                    "fail-closed mixed room books no principal");
                equal(principalEntries(mixedRestart.ledger, roomId).length, 0,
                    "fail-closed mixed room leaves principal ledger empty");
                equal(mixedRestart.fetchCalls, 0,
                    "no-reservation refusal performs no provider query");
            } finally {
                mixedRestart.close();
            }
        } finally {
            if (mixedFirst) mixedFirst.close({ remove: false });
            rmSync(mixedWorkspace, { recursive: true, force: true });
        }
    });

    await section("manifest recovery resumes after every durable preparation boundary", async () => {
        const scenarios = [
            {
                name: "failure before manifest becomes durable",
                expectedManifest: false,
                expectedIntents: 0,
                expectedWalletSnapshot: false,
                expectedStakes: 0,
                inject(h) {
                    h.manifestStore.createIfAbsent = () => {
                        throw new Error("injected manifest persistence failure before commit");
                    };
                }
            },
            {
                name: "manifest before first intent",
                expectedManifest: true,
                expectedIntents: 0,
                expectedWalletSnapshot: false,
                expectedStakes: 0,
                inject(h) {
                    const create = h.manifestStore.createIfAbsent.bind(h.manifestStore);
                    h.manifestStore.createIfAbsent = (...args) => {
                        const manifest = create(...args);
                        throw new Error("injected interruption after manifest persistence");
                    };
                }
            },
            {
                name: "first intent before complete intent set",
                expectedManifest: true,
                expectedIntents: 1,
                expectedWalletSnapshot: true,
                expectedStakes: 0,
                inject(h) {
                    const create = h.service.createPaymentIntent.bind(h.service);
                    let created = 0;
                    h.service.createPaymentIntent = (...args) => {
                        const intent = create(...args);
                        created += 1;
                        if (created === 1) throw new Error("injected interruption after first intent");
                        return intent;
                    };
                }
            },
            {
                name: "intent before reservation snapshot",
                expectedManifest: true,
                expectedIntents: 1,
                expectedWalletSnapshot: false,
                expectedStakes: 0,
                inject(h) {
                    h.service.persistSnapshot = () => {
                        throw new Error("injected interruption before reservation snapshot");
                    };
                }
            },
            {
                name: "reservation snapshot before first stake",
                expectedManifest: true,
                expectedIntents: 2,
                expectedWalletSnapshot: true,
                expectedStakes: 0,
                inject(h) {
                    h.ledger.recordPlayerStake = () => {
                        throw new Error("injected interruption before first stake");
                    };
                }
            },
            {
                name: "some but not all stakes",
                expectedManifest: true,
                expectedIntents: 2,
                expectedWalletSnapshot: true,
                expectedStakes: 1,
                inject(h) {
                    const append = h.ledger.recordPlayerStake.bind(h.ledger);
                    let recorded = 0;
                    h.ledger.recordPlayerStake = (...args) => {
                        const result = append(...args);
                        recorded += 1;
                        if (recorded === 1) throw new Error("injected interruption after one stake");
                        return result;
                    };
                }
            },
            {
                name: "all stakes before prepare returns",
                expectedManifest: true,
                expectedIntents: 2,
                expectedWalletSnapshot: true,
                expectedStakes: 2,
                inject(h) {
                    const append = h.ledger.recordPlayerStake.bind(h.ledger);
                    let recorded = 0;
                    h.ledger.recordPlayerStake = (...args) => {
                        const result = append(...args);
                        recorded += 1;
                        if (recorded === 2) throw new Error("injected interruption after all stakes");
                        return result;
                    };
                }
            }
        ];

        for (const scenario of scenarios) {
            const workspace = mkdtempSync(join(tmpdir(), "wheelwin-manifest-crash-"));
            const descriptor = makeRecoveryDescriptor();
            try {
                const beforeCrash = createComponents(workspace);
                scenario.inject(beforeCrash);
                throws(() => beforeCrash.adapter.prepareRoom(descriptor), Error,
                    `${scenario.name} interruption is injected`);

                const oldIntents = intentEntries(beforeCrash.service, descriptor.roomId);
                const oldStakes = beforeCrash.ledger.store.listForRoom(descriptor.roomId)
                    .filter((entry) => entry.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE);
                equal(oldIntents.length, scenario.expectedIntents,
                    `${scenario.name} persists the expected number of intents`);
                equal(oldStakes.length, scenario.expectedStakes,
                    `${scenario.name} persists the expected number of stakes`);
                equal(beforeCrash.manifestStore.get(descriptor.roomId) !== null,
                    scenario.expectedManifest,
                    `${scenario.name} leaves the expected manifest state`);
                const beforeCrashSnapshot = durablePreparationSnapshot(beforeCrash, descriptor.roomId);
                equal(beforeCrashSnapshot.walletSnapshot !== null,
                    scenario.expectedWalletSnapshot,
                    `${scenario.name} leaves the expected wallet-snapshot state`);
                if (!scenario.expectedManifest) {
                    equal(beforeCrashSnapshot.intents.length, 0,
                        "failure before manifest commit creates no payment intent files");
                    equal(beforeCrashSnapshot.ledgerEntries.length, 0,
                        "failure before manifest commit creates no ledger files");
                }

                const originalIntentRecords = new Map(oldIntents.map((intent) => [
                    intent.paymentReference,
                    intent.toRecord()
                ]));
                const originalStakeIds = new Map(oldStakes.map((entry) => [
                    entry.metadata.paymentReference,
                    entry.entryId
                ]));
                const restarted = createComponents(workspace, { clock: () => NOW_MS + 100 });
                check(restarted.service !== beforeCrash.service
                    && restarted.adapter !== beforeCrash.adapter
                    && restarted.manifestStore !== beforeCrash.manifestStore,
                `${scenario.name} recovery uses recreated service, adapter, and manifest-store instances`);
                const prepared = restarted.adapter.prepareRoom(descriptor);

                equal(prepared.payments.length, 2,
                    `${scenario.name} converges to one payment per manifest row`);
                deepEqual(intentEntries(restarted.service, descriptor.roomId)
                    .map((intent) => intent.paymentReference),
                descriptor.requiredPlayers.map((payment) => payment.paymentReference),
                `${scenario.name} retains the complete original payment-reference set`);
                equal(intentEntries(restarted.service, descriptor.roomId).length, 2,
                    `${scenario.name} has no duplicate intents`);
                const reservation = restarted.service.getWalletForRoom(descriptor.roomId);
                check(reservation !== null,
                    `${scenario.name} has one recovered room reservation for open intents`);
                check(intentEntries(restarted.service, descriptor.roomId).every((intent) =>
                    intent.destinationWalletId === reservation.walletId
                        && intent.destinationWalletAddress === reservation.address),
                `${scenario.name} preserves one canonical wallet assignment across intents`);
                const stakes = restarted.ledger.store.listForRoom(descriptor.roomId)
                    .filter((entry) => entry.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE);
                equal(stakes.length, 2,
                    `${scenario.name} converges to exactly one stake per required payment`);
                equal(new Set(stakes.map((entry) => entry.metadata.paymentReference)).size, 2,
                    `${scenario.name} has no duplicate stake references`);
                equal(restarted.walletPool.getReservedCount(), 1,
                    `${scenario.name} retains exactly one room-wallet reservation`);
                equal(durableDirectorySnapshot(join(workspace, "preparation-manifests")).length, 1,
                    `${scenario.name} retains exactly one immutable room manifest`);

                for (const intent of intentEntries(restarted.service, descriptor.roomId)) {
                    const original = originalIntentRecords.get(intent.paymentReference);
                    if (original) {
                        deepEqual(intent.toRecord(), original,
                            `${scenario.name} preserves an already persisted intent identity`);
                    }
                }
                for (const entry of stakes) {
                    const oldEntryId = originalStakeIds.get(entry.metadata.paymentReference);
                    if (oldEntryId) {
                        equal(entry.entryId, oldEntryId,
                            `${scenario.name} preserves an already persisted stake entry ID`);
                    }
                }
                const manifest = restarted.manifestStore.get(descriptor.roomId);
                check(Object.isFrozen(manifest)
                    && Object.isFrozen(manifest.descriptor)
                    && Object.isFrozen(manifest.descriptor.requiredPlayers),
                `${scenario.name} returns an immutable persisted manifest`);
                check(intentEntries(restarted.service, descriptor.roomId).every((intent) =>
                    intent.createdAt === manifest.preparationStartedAtMs),
                `${scenario.name} reuses the original preparation time for every intent`);
            } finally {
                rmSync(workspace, { recursive: true, force: true });
            }
        }
    });

    await section("conflicting retries after a partial intent write are rejected without further writes", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "wheelwin-manifest-conflict-"));
        const descriptor = makeRecoveryDescriptor("room-manifest-conflict");
        try {
            const interrupted = createComponents(workspace);
            const create = interrupted.service.createPaymentIntent.bind(interrupted.service);
            let created = 0;
            interrupted.service.createPaymentIntent = (...args) => {
                const intent = create(...args);
                created += 1;
                if (created === 1) throw new Error("injected crash after the first intent");
                return intent;
            };
            throws(() => interrupted.adapter.prepareRoom(descriptor), Error,
                "test state stops after the first persisted intent");

            const restarted = createComponents(workspace, { clock: () => NOW_MS + 100 });
            equal(intentEntries(restarted.service, descriptor.roomId).length, 1,
                "restart sees exactly one persisted intent before conflict checks");
            check(restarted.manifestStore.get(descriptor.roomId) !== null,
                "restart sees the original complete descriptor manifest");
            const stable = durablePreparationSnapshot(restarted, descriptor.roomId);

            const conflictCases = [
                ["player identity", (input) => ({
                    ...input,
                    requiredPlayers: input.requiredPlayers.map((payment, index) => index === 0
                        ? { ...payment, playerId: "different-player" }
                        : payment)
                })],
                ["player set", (input) => ({
                    ...input,
                    requiredPlayers: input.requiredPlayers.slice(0, 1)
                })],
                ["payment reference", (input) => ({
                    ...input,
                    requiredPlayers: input.requiredPlayers.map((payment, index) => index === 0
                        ? { ...payment, paymentReference: "WW-MANIFEST-CONFLICT-REF" }
                        : payment)
                })],
                ["sender identity", (input) => ({
                    ...input,
                    requiredPlayers: input.requiredPlayers.map((payment, index) => index === 0
                        ? { ...payment, expectedSender: syntheticAddress("different-sender") }
                        : payment)
                })],
                ["amount", (input) => ({
                    ...input,
                    requiredPlayers: input.requiredPlayers.map((payment, index) => index === 0
                        ? { ...payment, amountAtomic: 4_000_000_000 }
                        : payment)
                })],
                ["asset", (input) => ({ ...input, asset: "USDT" })],
                ["network", (input) => ({ ...input, network: "mainnet" })],
                ["room creation timestamp and deadline", (input) => ({
                    ...input,
                    roomCreatedAt: input.roomCreatedAt - 1_000
                })]
            ];

            for (const [label, makeConflict] of conflictCases) {
                throws(() => restarted.adapter.prepareRoom(makeConflict(descriptor)),
                    RoomPaymentSessionValidationError,
                    `${label} conflict is rejected`);
                deepEqual(durablePreparationSnapshot(restarted, descriptor.roomId), stable,
                    `${label} conflict leaves manifest, intents, wallet snapshot, and ledger unchanged`);
            }
        } finally {
            rmSync(workspace, { recursive: true, force: true });
        }
    });

    await section("corrupted manifests stop recovery without replacement", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "wheelwin-manifest-corrupt-"));
        const descriptor = makeRecoveryDescriptor("room-manifest-corrupt");
        try {
            const first = createComponents(workspace);
            first.adapter.prepareRoom(descriptor);
            const manifestId = createHash("sha256")
                .update(descriptor.roomId, "utf8")
                .digest("hex");
            const manifestPath = join(workspace, "preparation-manifests", `${manifestId}.json`);
            writeFileSync(manifestPath, "{corrupted manifest", "utf8");

            const restarted = createComponents(workspace, { clock: () => NOW_MS + 100 });
            const stable = durablePreparationSnapshot(restarted, descriptor.roomId);
            throws(() => restarted.adapter.prepareRoom(descriptor),
                RoomPaymentSessionValidationError,
                "corrupted manifest prevents preparation recovery");
            deepEqual(durablePreparationSnapshot(restarted, descriptor.roomId), stable,
                "corrupted manifest and all financial records remain unchanged");
            equal(readFileSync(manifestPath, "utf8"), "{corrupted manifest",
                "corrupted manifest is not overwritten or reconstructed");
        } finally {
            rmSync(workspace, { recursive: true, force: true });
        }
    });

    await section("manifest recovery survives actual Node.js process restarts at every required boundary", async () => {
        const scenarios = [
            {
                name: "manifest persisted before any intent",
                boundary: "manifest",
                expectedIntents: 0,
                expectedStakes: 0,
                expectedWalletSnapshot: false
            },
            {
                name: "one intent persisted before the complete intent set",
                boundary: "partial-intents",
                expectedIntents: 1,
                expectedStakes: 0,
                expectedWalletSnapshot: true
            },
            {
                name: "intent persisted before wallet reservation snapshot",
                boundary: "intent-before-wallet-snapshot",
                expectedIntents: 1,
                expectedStakes: 0,
                expectedWalletSnapshot: false
            },
            {
                name: "wallet snapshot persisted before all stake entries",
                boundary: "partial-stakes",
                expectedIntents: 2,
                expectedStakes: 1,
                expectedWalletSnapshot: true
            },
            {
                name: "all stake entries persisted before prepareRoom returns",
                boundary: "all-stakes",
                expectedIntents: 2,
                expectedStakes: 2,
                expectedWalletSnapshot: true
            }
        ];

        for (const scenario of scenarios) {
            const workspace = mkdtempSync(join(tmpdir(), "wheelwin-process-recovery-"));
            const descriptor = makeRecoveryDescriptor();
            try {
                const interrupted = spawnManifestProcessWorker(
                    "interrupt",
                    workspace,
                    scenario.boundary
                );
                equal(interrupted.error, undefined,
                    `${scenario.name}: interruption worker starts and exits`);
                equal(interrupted.status, PROCESS_WORKER_EXIT_CODE,
                    `${scenario.name}: original Node.js process terminates at the durable boundary`);
                const interruptedMarkerLine = interrupted.stdout.split(/\r?\n/)
                    .find((line) => line.startsWith("PROCESS_WORKER_INTERRUPTED:"));
                check(Boolean(interruptedMarkerLine),
                    `${scenario.name}: original process reports the reached boundary`);
                const interruptedMarker = JSON.parse(
                    interruptedMarkerLine.slice("PROCESS_WORKER_INTERRUPTED:".length)
                );
                equal(interruptedMarker.boundary, scenario.boundary,
                    `${scenario.name}: process exits at the requested boundary`);
                check(interruptedMarker.pid !== process.pid,
                    `${scenario.name}: interruption runs in a child Node.js process`);

                const beforeRecovery = readPersistedPreparationRecords(
                    workspace,
                    descriptor.roomId
                );
                equal(beforeRecovery.manifestFiles.length, 1,
                    `${scenario.name}: exactly one manifest is durable before recovery`);
                equal(beforeRecovery.intents.filter(({ record }) =>
                    record.roomId === descriptor.roomId
                ).length, scenario.expectedIntents,
                `${scenario.name}: interrupted process left the expected intent count`);
                equal(beforeRecovery.ledgerEntries.filter(({ record }) =>
                    record.roomId === descriptor.roomId
                        && record.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE
                ).length, scenario.expectedStakes,
                `${scenario.name}: interrupted process left the expected stake count`);
                equal(beforeRecovery.walletSnapshot !== null,
                    scenario.expectedWalletSnapshot,
                    `${scenario.name}: interrupted process left the expected wallet snapshot`);
                deepEqual(beforeRecovery.manifest.descriptor.requiredPlayers.map((payment) => ({
                    paymentReference: payment.paymentReference,
                    playerId: payment.playerId,
                    expectedSender: payment.expectedSender,
                    amountAtomic: payment.amountAtomic
                })), descriptor.requiredPlayers.map((payment) => ({
                    paymentReference: payment.paymentReference,
                    playerId: payment.playerId,
                    expectedSender: payment.expectedSender,
                    amountAtomic: payment.amountAtomic
                })), `${scenario.name}: complete intended player/payment set is already in the manifest`);

                const oldIntents = new Map(beforeRecovery.intents
                    .filter(({ record }) => record.roomId === descriptor.roomId)
                    .map((item) => [item.record.paymentReference, item]));
                const oldStakes = new Map(beforeRecovery.ledgerEntries
                    .filter(({ record }) => record.roomId === descriptor.roomId
                        && record.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE)
                    .map((item) => [item.record.metadata.paymentReference, item.record]));

                const recovered = spawnManifestProcessWorker("recover", workspace);
                equal(recovered.error, undefined,
                    `${scenario.name}: recovery worker starts and exits`);
                equal(recovered.status, 0,
                    `${scenario.name}: separate Node.js recovery process completes successfully`);
                const recoveredMarkerLine = recovered.stdout.split(/\r?\n/)
                    .find((line) => line.startsWith("PROCESS_WORKER_RECOVERED:"));
                check(Boolean(recoveredMarkerLine),
                    `${scenario.name}: recovery process reports its checks`);
                const recoveredMarker = JSON.parse(
                    recoveredMarkerLine.slice("PROCESS_WORKER_RECOVERED:".length)
                );
                check(recoveredMarker.pid !== interruptedMarker.pid
                    && recoveredMarker.pid !== process.pid,
                `${scenario.name}: recovery uses a different Node.js process`);
                equal(recoveredMarker.fetchCalls, 0,
                    `${scenario.name}: recovery makes no provider request`);
                check(recoveredMarker.recordsUnchangedOnExactRetry,
                    `${scenario.name}: exact retry adds no records`);
                check(recoveredMarker.conflictRejectedWithoutWrites,
                    `${scenario.name}: conflicting descriptor is rejected without writes`);

                const afterRecovery = readPersistedPreparationRecords(
                    workspace,
                    descriptor.roomId
                );
                equal(afterRecovery.manifestFiles.length, 1,
                    `${scenario.name}: recovery retains exactly one immutable manifest`);
                equal(afterRecovery.manifestContents, beforeRecovery.manifestContents,
                    `${scenario.name}: persisted manifest bytes remain unchanged`);
                const finalIntents = afterRecovery.intents
                    .filter(({ record }) => record.roomId === descriptor.roomId);
                equal(finalIntents.length, descriptor.requiredPlayers.length,
                    `${scenario.name}: one persisted intent exists for every payment`);
                deepEqual(finalIntents.map(({ record }) => record.paymentReference).sort(),
                    descriptor.requiredPlayers.map((payment) => payment.paymentReference).sort(),
                    `${scenario.name}: original payment references are retained`);
                deepEqual(finalIntents.map(({ record }) => [
                    record.paymentReference,
                    record.playerId,
                    record.expectedSender,
                    record.amountAtomic
                ]).sort((left, right) => left[0].localeCompare(right[0])),
                descriptor.requiredPlayers.map((payment) => [
                    payment.paymentReference,
                    payment.playerId,
                    payment.expectedSender,
                    payment.amountAtomic
                ]).sort((left, right) => left[0].localeCompare(right[0])),
                `${scenario.name}: persisted intent amounts and player identities remain exact`);
                equal(new Set(finalIntents.map(({ record }) => record.paymentReference)).size,
                    descriptor.requiredPlayers.length,
                    `${scenario.name}: payment obligations have no duplicate references`);
                check(finalIntents.every(({ record }) => !Object.hasOwn(record, "intentId")),
                    `${scenario.name}: persisted model has no separate intentId field`);
                for (const [paymentReference, original] of oldIntents) {
                    const recoveredIntent = finalIntents.find(({ record }) =>
                        record.paymentReference === paymentReference
                    );
                    check(Boolean(recoveredIntent),
                        `${scenario.name}: original intent ${paymentReference} remains persisted`);
                    equal(recoveredIntent.name, original.name,
                        `${scenario.name}: payment reference remains the original persisted intent key`);
                    equal(recoveredIntent.contents, original.contents,
                        `${scenario.name}: existing intent record remains byte-for-byte stable`);
                }

                check(afterRecovery.walletSnapshot !== null,
                    `${scenario.name}: recovered open intents have a persisted wallet snapshot`);
                const reservations = afterRecovery.walletSnapshot.reservations.filter((record) =>
                    record.reservedByRoomId === descriptor.roomId
                );
                equal(reservations.length, 1,
                    `${scenario.name}: exactly one wallet remains reserved for the room`);
                const assignedWalletId = reservations[0].walletId;
                check(finalIntents.every(({ record }) =>
                    record.destinationWalletId === assignedWalletId
                ), `${scenario.name}: every open intent uses the assigned wallet`);
                const priorWalletIntent = [...oldIntents.values()][0]?.record;
                if (priorWalletIntent) {
                    equal(assignedWalletId, priorWalletIntent.destinationWalletId,
                        `${scenario.name}: recovery preserves the wallet already persisted in an intent`);
                }

                const finalStakes = afterRecovery.ledgerEntries
                    .filter(({ record }) => record.roomId === descriptor.roomId
                        && record.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE);
                equal(finalStakes.length, descriptor.requiredPlayers.length,
                    `${scenario.name}: exactly one PLAYER_STAKE exists per expected payment`);
                for (const payment of descriptor.requiredPlayers) {
                    const matching = finalStakes.filter(({ record }) =>
                        record.metadata.paymentReference === payment.paymentReference
                    );
                    equal(matching.length, 1,
                        `${scenario.name}: one stake exists for ${payment.paymentReference}`);
                    equal(matching[0].record.amountAtomic, payment.amountAtomic,
                        `${scenario.name}: exact atomic amount remains for ${payment.paymentReference}`);
                    equal(matching[0].record.playerId, payment.playerId,
                        `${scenario.name}: player identity remains for ${payment.paymentReference}`);
                    const oldStake = oldStakes.get(payment.paymentReference);
                    if (oldStake) {
                        equal(matching[0].record.entryId, oldStake.entryId,
                            `${scenario.name}: existing persisted stake identifier remains stable`);
                    }
                }
            } finally {
                rmSync(workspace, { recursive: true, force: true });
            }
        }
    });

    await section("adapter has no runtime wiring, timers, retries, signing, or transfer path", async () => {
        await withHarness({}, async (h) => {
            const source = readFileSync(join(TEST_DIR, "../../payment/runtime/RoomPaymentSessionAdapter.js"), "utf8");
            check(!/from\s+["'][^"']*(?:server\/app|gameplay|EventBus|socket|Page4)/i.test(source),
                "no runtime/gameplay/socket import");
            check(!/\bset(?:Interval|Timeout)\s*\(/.test(source), "no timer creation");
            check(!/\bfetch\s*\(/.test(source), "adapter does not issue network requests");
            check(!/\.(?:executePayment|broadcast|signTransaction|refundPayment)\s*\(|RoomPayoutCalculator/.test(source),
                "adapter does not execute outgoing financial operations");
            check(h.observationService === h.service.observationService,
                "payment service uses its bound observation instance");
            check(h.coordinator.observationService === h.service.observationService,
                "coordinator uses that exact observation instance");
            const descriptor = makeDescriptor();
            h.adapter.prepareRoom(descriptor);
            const intent = h.service.getPaymentIntent(descriptor.requiredPlayers[0].paymentReference);
            h.setPayload(emptyPayload(transactionFor(intent,
                h.service.getWalletForRoom(descriptor.roomId))));
            await h.adapter.observeRoomPayments({ roomId: descriptor.roomId });
            equal(h.fetchCalls, 1, "one caller operation invokes one synthetic fetch");
            equal(h.ledger.store.listForRoom(descriptor.roomId).filter(
                (entry) => entry.kind === LEDGER_ENTRY_KIND.PAYOUT_PLAN
            ).length, 0, "adapter creates no payout plan");
        });
    });

    equal(sections, TOTAL_SECTIONS, "all requested sections ran");
    process.stdout.write(`ASSERTIONS=${assertions}\n`);
    process.stdout.write(`SECTIONS=${sections}\n`);
}

if (process.argv[2] === "--manifest-process-worker") {
    try {
        runManifestProcessWorker(process.argv[3], process.argv[4], process.argv[5]);
    } catch (error) {
        process.stderr.write(`${error?.stack ?? error}\n`);
        process.exitCode = 1;
    }
} else {
    run().catch((error) => {
        process.stderr.write(`${error?.stack ?? error}\n`);
        process.exitCode = 1;
    });
}
