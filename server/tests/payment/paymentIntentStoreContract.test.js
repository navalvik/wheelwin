import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPaymentReference } from "../../payment/incoming/PaymentReferenceCodec.js";

import {
    AssetDenominationRegistry,
    PaymentConfigurationError,
    PaymentIntent,
    PaymentIntentStore,
    RoomWalletPaymentService,
    WalletPoolRegistry,
    isPaymentIntentStoreContract
} from "../../payment/index.js";
import { SqlitePaymentIntentStore } from "../../payment/SqlitePaymentIntentStore.js";
import {
    CurrencyMapping,
    INCOMING_PRINCIPAL_CONFIRMATION_SOURCE,
    LedgerStore,
    LedgerStorageError,
    PayoutValidationError,
    RoomLedger
} from "../../payment/ledger/index.js";
import {
    RoomPaymentObservationService
} from "../../payment/toncenter/RoomPaymentObservationService.js";
import { ToncenterIncomingProvider } from "../../payment/toncenter/ToncenterIncomingProvider.js";
import { ToncenterTransactionsClient } from "../../payment/toncenter/ToncenterTransactionsClient.js";

const NOW = 1_700_000_000_000;
const ROOM_LIFETIME_MS = 480_000;

function crc16Xmodem(bytes) {
    let crc = 0;
    for (const byte of bytes) {
        crc ^= byte << 8;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
            crc &= 0xffff;
        }
    }
    return [(crc >> 8) & 0xff, crc & 0xff];
}

function syntheticAddress(seed) {
    const hash = createHash("sha256").update(seed).digest();
    const payload = Buffer.concat([Buffer.from([0x11, 0x00]), hash]);
    return Buffer.concat([payload, Buffer.from(crc16Xmodem(payload))]).toString("base64url");
}

function createWorkspace() {
    const root = mkdtempSync(join(tmpdir(), "wheelwin-intent-contract-"));
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    const catalog = Array.from({ length: 64 }, (_, index) => ({
        roomNumber: index + 1,
        address: syntheticAddress(`contract-wallet-${index + 1}`),
        publicKey: null,
        workchain: 0,
        network: "testnet"
    }));
    const catalogPath = join(configDir, "wallets.json");
    writeFileSync(catalogPath, JSON.stringify(catalog), "utf8");
    return { root, catalogPath, dataDir: join(root, "payment-data") };
}

function createStore(backend, workspace) {
    return backend === "sqlite"
        ? new SqlitePaymentIntentStore({ databasePath: join(workspace.dataDir, "intents.sqlite"), nowProvider: () => NOW })
        : new PaymentIntentStore({ dataDir: workspace.dataDir, nowProvider: () => NOW });
}

function createService(store, workspace) {
    const walletPool = new WalletPoolRegistry({ catalogPath: workspace.catalogPath, network: "testnet" });
    const assetRegistry = AssetDenominationRegistry.fromConfiguration({
        assets: [{ asset: "TON", symbol: "Gram", network: "testnet", atomicUnitsPerUnit: 1_000_000_000 }]
    });
    let providerPayload = { transactions: [], address_book: {} };
    const client = new ToncenterTransactionsClient({
        apiKeyProvider: () => "SYNTHETIC-TEST-KEY",
        fetchImpl: async () => ({ status: 200, json: async () => providerPayload })
    });
    const observationService = new RoomPaymentObservationService({
        provider: new ToncenterIncomingProvider({ client }),
        nowProvider: () => NOW + 3_000
    });
    const service = new RoomWalletPaymentService({
        walletPool,
        intentStore: store,
        assetRegistry,
        observationService,
        snapshotDir: join(workspace.root, "snapshots"),
        nowProvider: () => NOW + 3_000
    });
    service.initialize();
    return {
        service,
        observationService,
        setProviderPayload(payload) { providerPayload = payload; }
    };
}

function transactionFor(intent) {
    return {
        account: intent.destinationWalletAddress,
        hash: createHash("sha256").update(`contract:${intent.paymentReference}`).digest("hex"),
        now: Math.floor((NOW + 2_000) / 1_000),
        description: { aborted: false, compute_ph: { success: true }, action: { success: true } },
        in_msg: {
            source: intent.expectedSender,
            destination: intent.destinationWalletAddress,
            value: String(intent.amountAtomic),
            message_content: { decoded: { type: "text_comment", comment: formatPaymentReference(intent.paymentReference) } }
        }
    };
}

function createIntent(service, paymentReference) {
    return service.createPaymentIntent({
        paymentReference,
        roomId: "contract-room",
        playerId: `player-${paymentReference}`,
        expectedSender: syntheticAddress(`sender-${paymentReference}`),
        amountAtomic: 2_000_000_000,
        asset: "TON",
        network: "testnet",
        roomCreatedAt: NOW,
        now: NOW + 1_000
    });
}

function recordFor(reference) {
    return new PaymentIntent({
        paymentReference: reference,
        roomId: "ledger-room",
        playerId: "ledger-player",
        network: "testnet",
        destinationWalletId: "synthetic-wallet",
        destinationWalletAddress: syntheticAddress("ledger-wallet"),
        expectedSender: syntheticAddress("ledger-sender"),
        amountAtomic: 1_000,
        asset: "TON",
        createdAt: NOW,
        expiresAt: NOW + 100_000,
        roomDeadlineMs: NOW + ROOM_LIFETIME_MS
    });
}

function assertCommitted(result, store, reference, expectedState, expectedVersion) {
    assert.ok(result instanceof PaymentIntent);
    assert.equal(result.paymentReference, reference);
    assert.equal(result.state, expectedState);
    const persisted = store.require(reference);
    assert.deepEqual(result.toRecord(), persisted.toRecord());
    if (expectedVersion !== null) {
        assert.equal(result.getExpectedStorageVersion(), expectedVersion);
        assert.equal(persisted.getExpectedStorageVersion(), expectedVersion);
    }
}

async function main() {
    let assertions = 0;
    for (const backend of ["json", "sqlite"]) {
        const workspace = createWorkspace();
        const store = createStore(backend, workspace);
        try {
            if (backend === "sqlite") store.initialize();
            assert.equal(isPaymentIntentStoreContract(store), true);
            assertions += 1;

            const { service, observationService, setProviderPayload } = createService(store, workspace);
            const created = createIntent(service, `${backend}-create`);
            assertCommitted(created, store, `${backend}-create`, "PENDING", backend === "sqlite" ? 1 : null);
            if (backend === "json") {
                assert.strictEqual(created, store.require(`${backend}-create`));
                assertions += 1;
            }
            assertions += 1;

            const matched = service.matchTransaction(`${backend}-create`, `${backend}-transaction`);
            assertCommitted(matched, store, `${backend}-create`, "MATCHED", backend === "sqlite" ? 2 : null);
            assertions += 1;

            if (backend === "sqlite") {
                const next = matched.transition("SETTLED", { now: NOW + 2_000 });
                const committed = store.update(next);
                assertCommitted(committed, store, `${backend}-create`, "SETTLED", 3);
                assertions += 1;
            } else {
                assert.strictEqual(matched, store.require(`${backend}-create`));
                assertions += 1;
            }

            const cancel = createIntent(service, `${backend}-cancel`);
            const cancelled = service.cancelPayment(cancel.paymentReference);
            assertCommitted(cancelled, store, `${backend}-cancel`, "CANCELLED", backend === "sqlite" ? 2 : null);
            assertions += 1;

            const fail = createIntent(service, `${backend}-fail`);
            const failed = service.failPayment(fail.paymentReference);
            assertCommitted(failed, store, `${backend}-fail`, "FAILED", backend === "sqlite" ? 2 : null);
            assertions += 1;

            const expire = createIntent(service, `${backend}-expire`);
            const expired = service.expirePaymentIntent(expire.paymentReference, expire.expiresAt + 1);
            assertCommitted(expired, store, `${backend}-expire`, "EXPIRED", backend === "sqlite" ? 2 : null);
            assertions += 1;

            const settleIntent = createIntent(service, `${backend}-settle`);
            setProviderPayload({ transactions: [transactionFor(settleIntent)], address_book: {} });
            const observation = await observationService.checkRoomPayments({
                roomId: settleIntent.roomId,
                walletAddress: settleIntent.destinationWalletAddress,
                paymentIntents: [settleIntent],
                floorMs: settleIntent.createdAt,
                ceilingMs: NOW + 5_000,
                destinationWalletId: settleIntent.destinationWalletId
            });
            assert.equal(observation.observations[0]?.status, "matched");
            const transactionId = observation.transfers[0].transactionId;
            service.matchTransaction(settleIntent.paymentReference, transactionId);
            const settled = service.settlePayment(settleIntent.paymentReference, observation, transactionId);
            assertCommitted(settled, store, settleIntent.paymentReference, "SETTLED", backend === "sqlite" ? 3 : null);
            assertions += 1;

            const ledgerStore = new LedgerStore({ dataDir: join(workspace.root, "ledger-data"), nowProvider: () => NOW });
            const ledger = new RoomLedger({
                store: ledgerStore,
                currency: CurrencyMapping.nativeTon({ network: "testnet" }),
                intentStore: store
            });
            ledger.initialize();
            const pending = store.save(recordFor(`${backend}-principal`));
            assert.throws(() => ledger.recordIncomingPrincipal({
                idempotencyKey: `${backend}:principal`,
                roomId: pending.roomId,
                playerId: pending.playerId,
                amountAtomic: pending.amountAtomic,
                confirmation: {
                    paymentReference: pending.paymentReference,
                    transactionId: `${backend}-principal-tx`,
                    source: INCOMING_PRINCIPAL_CONFIRMATION_SOURCE
                }
            }), PayoutValidationError);
            assertions += 1;

            let settledPrincipalIntent = store.update(pending.transition("MATCHED", {
                transactionId: `${backend}-principal-tx`, now: NOW + 1_000
            }));
            settledPrincipalIntent = store.update(settledPrincipalIntent.transition("SETTLED", { now: NOW + 2_000 }));
            const principal = ledger.recordIncomingPrincipal({
                idempotencyKey: `${backend}:principal`,
                roomId: settledPrincipalIntent.roomId,
                playerId: settledPrincipalIntent.playerId,
                amountAtomic: settledPrincipalIntent.amountAtomic,
                confirmation: {
                    paymentReference: settledPrincipalIntent.paymentReference,
                    transactionId: settledPrincipalIntent.transactionId,
                    source: INCOMING_PRINCIPAL_CONFIRMATION_SOURCE
                }
            });
            assert.equal(principal.entry.metadata.paymentReference, settledPrincipalIntent.paymentReference);
            assertions += 1;

            ledgerStore.close?.();
        } finally {
            store.close?.();
            rmSync(workspace.root, { recursive: true, force: true });
        }
    }

    const invalidWorkspace = createWorkspace();
    try {
        assert.throws(() => createService({}, invalidWorkspace), PaymentConfigurationError);
        assertions += 1;

        const ledgerStore = new LedgerStore({ dataDir: join(invalidWorkspace.root, "invalid-ledger") });
        assert.throws(() => new RoomLedger({
            store: ledgerStore,
            currency: CurrencyMapping.nativeTon({ network: "testnet" }),
            intentStore: {}
        }), LedgerStorageError);
        assertions += 1;
        ledgerStore.close?.();
    } finally {
        rmSync(invalidWorkspace.root, { recursive: true, force: true });
    }
    console.log(`PASS: ${assertions} payment intent store contract assertions`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
