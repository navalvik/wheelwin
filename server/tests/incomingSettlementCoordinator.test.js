/**
 * Reconstructed Phase 3D settlement-coordinator regression suite.
 *
 * This is a new suite based on the current public APIs and the documented
 * security coverage. It is not an authenticated recovery of the missing
 * original test. Every provider request is routed to the in-memory fetch
 * supplied below; the suite never uses the default HTTP transport.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    ROOM_LIFETIME_MS,
    ROOM_WALLET_POOL_SIZE,
    AssetDenominationRegistry,
    PaymentExecutionBlockedError,
    PaymentIntentStore,
    PaymentValidationError,
    RoomWalletPaymentService,
    WalletPoolRegistry
} from "../payment/index.js";
import {
    formatPaymentReference
} from "../payment/incoming/index.js";
import {
    IncomingPaymentSettlementCoordinator,
    INCOMING_SETTLEMENT_REFUSAL,
    INCOMING_SETTLEMENT_REFUSAL_REASON
} from "../payment/incoming/IncomingPaymentSettlementCoordinator.js";
import {
    CurrencyMapping,
    INCOMING_PRINCIPAL_CONFIRMATION_SOURCE,
    LEDGER_ENTRY_KIND,
    LedgerStore,
    RoomLedger
} from "../payment/ledger/index.js";
import {
    RoomPaymentObservationService,
    ToncenterIncomingProvider,
    ToncenterRateLimitError,
    ToncenterResponseError,
    ToncenterTransactionsClient
} from "../payment/toncenter/index.js";
import { SyntheticTonSettlementEvidenceProvider } from "./helpers/syntheticTonSettlementEvidence.js";

const BASE_MS = 1_700_000_000_000;
const CREATED_AT = BASE_MS + 1_000;
const TRANSFER_SECONDS = Math.floor((BASE_MS + 2_000) / 1_000);
const NOW_MS = BASE_MS + 5_000;
const SYNTHETIC_API_KEY = "SYNTHETIC-TONCENTER-TEST-KEY-NOT-REAL";
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
let assertionCount = 0;
let sectionCount = 0;

function check(condition, message) {
    assert.ok(condition, message);
    assertionCount += 1;
}

function equal(actual, expected, message) {
    assert.equal(actual, expected, message);
    assertionCount += 1;
}

function throws(fn, errorClass, message) {
    assert.throws(fn, errorClass, message);
    assertionCount += 1;
}

async function rejects(promise, errorClass, message) {
    await assert.rejects(promise, errorClass, message);
    assertionCount += 1;
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
    const accountHash = createHash("sha256")
        .update(`wheelwin-settlement-regression:${seed}`, "utf8")
        .digest();
    const body = Buffer.concat([Buffer.from([0x11, 0]), accountHash]);
    return Buffer.concat([body, crc16Xmodem(body)]).toString("base64url");
}

function syntheticCatalog(catalogPath, network) {
    const wallets = Array.from({ length: ROOM_WALLET_POOL_SIZE }, (_, index) => ({
        roomNumber: index + 1,
        address: syntheticAddress(`wallet-${network}-${index + 1}`),
        publicKey: null,
        workchain: 0,
        network
    }));
    writeFileSync(catalogPath, `${JSON.stringify(wallets)}\n`, "utf8");
}

function defaultAssets(network) {
    return [
        { asset: "TON", symbol: "Gram", network, atomicUnitsPerUnit: 1_000_000_000 },
        { asset: "USDT", symbol: "USDT", network, atomicUnitsPerUnit: 1 }
    ];
}

function buildHarness({ network = "testnet", limit = 50, responseStatus = 200, withFinalityEvidence = true, evidenceFactory = null } = {}) {
    const workspace = mkdtempSync(join(tmpdir(), "wheelwin-settlement-regression-"));
    const configDir = join(workspace, "config");
    const dataDir = join(workspace, "data");
    mkdirSync(configDir, { recursive: true });
    const catalogPath = join(configDir, "synthetic-wallets.json");
    syntheticCatalog(catalogPath, network);

    let payload = { transactions: [], address_book: {} };
    let status = responseStatus;
    let fetchCalls = 0;
    const clock = () => NOW_MS;
    const walletPool = new WalletPoolRegistry({ catalogPath, network });
    const intentStore = new PaymentIntentStore({ dataDir, nowProvider: clock });
    const assetRegistry = AssetDenominationRegistry.fromConfiguration({
        assets: defaultAssets(network)
    });
    const client = new ToncenterTransactionsClient({
        apiKeyProvider: () => SYNTHETIC_API_KEY,
        fetchImpl: async () => {
            fetchCalls += 1;
            return {
                status,
                json: async () => payload
            };
        }
    });
    const provider = new ToncenterIncomingProvider({ client });
    const observationService = new RoomPaymentObservationService({
        provider,
        settlementEvidenceProvider: withFinalityEvidence
            ? new SyntheticTonSettlementEvidenceProvider({
                nowProvider: clock,
                evidenceFactory
            })
            : null,
        nowProvider: clock,
        limit
    });
    const service = new RoomWalletPaymentService({
        walletPool,
        intentStore,
        assetRegistry,
        observationService,
        snapshotDir: dataDir,
        nowProvider: clock
    });
    service.initialize();
    const coordinator = new IncomingPaymentSettlementCoordinator({
        paymentService: service,
        observationService,
        nowProvider: clock
    });
    const ledgerStore = new LedgerStore({
        dataDir: join(workspace, "ledger-data"),
        nowProvider: clock
    });
    const ledger = new RoomLedger({
        store: ledgerStore,
        currency: CurrencyMapping.nativeTon({ network: "testnet" }),
        intentStore
    });
    ledger.initialize();

    return {
        workspace,
        network,
        dataDir,
        walletPool,
        intentStore,
        assetRegistry,
        client,
        provider,
        observationService,
        service,
        coordinator,
        ledger,
        get fetchCalls() { return fetchCalls; },
        setPayload(nextPayload) { payload = nextPayload; },
        setStatus(nextStatus) { status = nextStatus; },
        async close() {
            service.shutdown();
            rmSync(workspace, { recursive: true, force: true });
        }
    };
}

async function usingHarness(options, callback) {
    const harness = buildHarness(options);
    try {
        await callback(harness);
    } finally {
        await harness.close();
    }
}

let referenceSequence = 0;
function makeIntent(harness, {
    roomId = "room-regression",
    playerId = `player-${referenceSequence + 1}`,
    amountAtomic = 2_000_000_000,
    asset = "TON",
    network = harness.network,
    expectedSender = syntheticAddress("sender-default"),
    paymentReference = `WW-PAY-${String(++referenceSequence).padStart(5, "0")}`,
    now = CREATED_AT
} = {}) {
    return harness.service.createPaymentIntent({
        paymentReference,
        roomId,
        playerId,
        expectedSender,
        amountAtomic,
        asset,
        network,
        roomCreatedAt: BASE_MS,
        now
    });
}

function transactionFor(intent, wallet, overrides = {}) {
    const message = {
        source: intent.expectedSender,
        destination: wallet.address,
        value: String(intent.amountAtomic),
        message_content: {
            decoded: {
                type: "text_comment",
                comment: formatPaymentReference(intent.paymentReference)
            }
        },
        ...(overrides.inMsg ?? {})
    };
    return {
        account: wallet.address,
        hash: overrides.hash ?? createHash("sha256")
            .update(`${intent.paymentReference}:${overrides.suffix ?? "tx"}`)
            .digest("hex"),
        now: overrides.nowSeconds ?? TRANSFER_SECONDS,
        description: { aborted: false, compute_ph: { success: true }, action: { success: true } },
        in_msg: message,
        ...(overrides.row ?? {})
    };
}

function rowPayload(...transactions) {
    return { transactions, address_book: {} };
}

async function settle(harness, roomId = "room-regression", options = {}) {
    return harness.coordinator.settleRoomPayments({
        roomId,
        now: options.now ?? NOW_MS,
        floorMs: options.floorMs,
        ceilingMs: options.ceilingMs,
        limit: options.limit
    });
}

async function section(name, callback) {
    await callback();
    sectionCount += 1;
    process.stdout.write(`[G${sectionCount}/15] PASS ${name}\n`);
}

async function run() {
    // G1: A complete, synthetic provider window settles only its exact intent.
    await section("complete synthetic observation settles one exact intent", async () => {
        await usingHarness({}, async (h) => {
            const intent = makeIntent(h);
            const other = makeIntent(h, { playerId: "player-other", amountAtomic: 3_000_000_000 });
            const wallet = h.service.getWalletForRoom(intent.roomId);
            h.setPayload(rowPayload(transactionFor(intent, wallet)));
            const report = await settle(h);
            equal(report.settled.length, 1, "one matching intent settles");
            equal(report.settled[0].paymentReference, intent.paymentReference, "exact reference settles");
            equal(report.resultWindowComplete, true, "provider window is complete");
            equal(h.service.getPaymentIntent(intent.paymentReference).state, "SETTLED", "settled state persisted");
            equal(h.service.getPaymentIntent(other.paymentReference).state, "PENDING", "unrelated intent stays pending");
            const settled = h.service.getPaymentIntent(intent.paymentReference);
            h.ledger.recordIncomingPrincipal({
                idempotencyKey: `ledger:${intent.paymentReference}`,
                roomId: intent.roomId,
                playerId: intent.playerId,
                amountAtomic: intent.amountAtomic,
                confirmation: {
                    paymentReference: intent.paymentReference,
                    transactionId: settled.transactionId,
                    source: INCOMING_PRINCIPAL_CONFIRMATION_SOURCE
                }
            });
            equal(h.ledger.getTotalSettledPrincipalAtomic(intent.roomId), intent.amountAtomic, "ledger principal follows authoritative settlement");
            equal(h.ledger.store.list().filter((entry) => entry.kind === LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL).length, 1, "one principal entry recorded");
            equal(h.ledger.getRoomLedgerView(intent.roomId).safetyMarginAtomic, 0, "ledger safety margin remains zero");
        });
    });

    // G2: A direct service call cannot settle without trusted observation proof.
    await section("direct settlement without observation evidence fails closed", async () => {
        await usingHarness({}, async (h) => {
            const intent = makeIntent(h);
            throws(() => h.service.settlePayment(intent.paymentReference), PaymentValidationError, "direct settlement is rejected");
            equal(h.service.getPaymentIntent(intent.paymentReference).state, "PENDING", "intent remains pending");
        });
    });

    // G3: A caller-selected transaction id is not observation evidence.
    await section("arbitrary matchTransaction id cannot authorize settlement", async () => {
        await usingHarness({}, async (h) => {
            const intent = makeIntent(h);
            h.service.matchTransaction(intent.paymentReference, "caller-selected-transaction-id");
            throws(() => h.service.settlePayment(intent.paymentReference), PaymentValidationError, "matched intent still needs trusted evidence");
            equal(h.service.getPaymentIntent(intent.paymentReference).state, "MATCHED", "forged path does not settle intent");
        });
    });

    // G4: Neither shape, copied values, caller brands nor Proxy traps forge identity.
    await section("forged, copied, altered and proxied authority objects are rejected", async () => {
        await usingHarness({}, async (h) => {
            const intent = makeIntent(h);
            const fake = { providerConfirmed: true, resultWindowComplete: true, observations: [], transfers: [] };
            const proxy = new Proxy(fake, { get() { throw new Error("proxy getter must not run"); } });
            const wallet = h.service.getWalletForRoom(intent.roomId);
            h.setPayload(rowPayload(transactionFor(intent, wallet)));
            const genuineResult = await h.observationService.checkRoomPayments({
                roomId: intent.roomId,
                walletAddress: wallet.address,
                destinationWalletId: wallet.walletId,
                paymentIntents: [intent],
                floorMs: intent.createdAt,
                ceilingMs: NOW_MS
            });
            for (const candidate of [
                fake,
                proxy,
                { ...fake },
                { ...fake, roomId: "room-regression", providerConfirmed: false },
                Object.assign({}, fake, { trusted: true }),
                { ...genuineResult },
                { ...genuineResult, resultWindowComplete: false }
            ]) {
                throws(() => h.service.settlePayment(intent.paymentReference, candidate, genuineResult.transfers[0].transactionId), PaymentValidationError, "forged observation result rejected");
            }
            equal(h.service.getPaymentIntent(intent.paymentReference).state, "PENDING", "forgeries do not alter intent");
        });
    });

    // G5: Exact service-instance registration is part of the trust boundary.
    await section("another observation service instance cannot authorize settlement", async () => {
        await usingHarness({}, async (h) => {
            const intent = makeIntent(h);
            const wallet = h.service.getWalletForRoom(intent.roomId);
            const foreignClient = new ToncenterTransactionsClient({
                apiKeyProvider: () => SYNTHETIC_API_KEY,
                fetchImpl: async () => ({ status: 200, json: async () => rowPayload(transactionFor(intent, wallet)) })
            });
            const foreignService = new RoomPaymentObservationService({
                provider: new ToncenterIncomingProvider({ client: foreignClient }),
                nowProvider: () => NOW_MS
            });
            const foreignResult = await foreignService.checkRoomPayments({
                roomId: intent.roomId,
                walletAddress: wallet.address,
                destinationWalletId: wallet.walletId,
                paymentIntents: [intent],
                floorMs: intent.createdAt,
                ceilingMs: NOW_MS
            });
            throws(() => h.service.settlePayment(intent.paymentReference, foreignResult, foreignResult.transfers[0].transactionId), PaymentValidationError, "foreign result rejected");
            equal(h.service.getPaymentIntent(intent.paymentReference).state, "PENDING", "foreign result does not settle intent");
        });
    });

    // G6: Completeness, room binding, expiration and time-window constraints.
    await section("incomplete, expired, wrong-room and stale observations do not settle", async () => {
        await usingHarness({ limit: 1 }, async (h) => {
            const intent = makeIntent(h);
            const wallet = h.service.getWalletForRoom(intent.roomId);
            h.setPayload(rowPayload(transactionFor(intent, wallet)));
            const report = await settle(h, intent.roomId, { limit: 1 });
            equal(report.refusal, INCOMING_SETTLEMENT_REFUSAL.OBSERVATION_WINDOW_INCOMPLETE, "full limit is conservatively incomplete");
            equal(h.service.getPaymentIntent(intent.paymentReference).state, "PENDING", "incomplete window settles nothing");
        });
        await usingHarness({}, async (h) => {
            const intent = makeIntent(h);
            const wallet = h.service.getWalletForRoom(intent.roomId);
            h.setPayload(rowPayload(transactionFor(intent, wallet)));
            const report = await settle(h, intent.roomId, { now: intent.expiresAt + 1 });
            check(report.refused.length + report.unmatched.length > 0, "expired intent is reported without settlement");
            equal(h.service.getPaymentIntent(intent.paymentReference).state, "PENDING", "expired intent stays pending");
        });
        await usingHarness({}, async (h) => {
            const intent = makeIntent(h);
            h.setPayload(rowPayload());
            const report = await settle(h, "different-room");
            equal(report.refusal, INCOMING_SETTLEMENT_REFUSAL.NO_PAYMENT_INTENTS, "unrelated room is refused before observation");
            equal(h.fetchCalls, 0, "wrong room makes no provider request");
            equal(h.service.getPaymentIntent(intent.paymentReference).state, "PENDING", "wrong-room request changes nothing");
        });
        await usingHarness({}, async (h) => {
            const intent = makeIntent(h);
            const wallet = h.service.getWalletForRoom(intent.roomId);
            const stale = transactionFor(intent, wallet, { nowSeconds: TRANSFER_SECONDS - 10 });
            h.setPayload(rowPayload(stale));
            const report = await settle(h);
            equal(report.settled.length, 0, "stale row is excluded");
            equal(h.service.getPaymentIntent(intent.paymentReference).state, "PENDING", "stale row does not settle");
        });
        await usingHarness({}, async (h) => {
            const intent = makeIntent(h);
            const wallet = h.service.getWalletForRoom(intent.roomId);
            const row = transactionFor(intent, wallet, { inMsg: { destination: syntheticAddress("wrong-destination") } });
            h.setPayload(rowPayload(row));
            const report = await settle(h);
            equal(report.settled.length, 0, "wrong destination cannot settle");
            equal(h.service.getPaymentIntent(intent.paymentReference).state, "PENDING", "wallet mismatch leaves obligation open");
        });
    });

    // G7: Every matcher dimension remains exact and independently required.
    await section("destination, sender, amount, asset, network, reference and tx identity match exactly", async () => {
        const cases = [
            { name: "destination", row: (intent) => ({ inMsg: { destination: syntheticAddress("other-destination") } }) },
            { name: "sender", row: () => ({ inMsg: { source: syntheticAddress("other-sender") } }) },
            { name: "amount", row: () => ({ inMsg: { value: "3000000000" } }) },
            { name: "reference", row: () => ({ inMsg: { message_content: { decoded: { type: "text_comment", comment: "WW1:OTHER-REFERENCE" } } } }) }
        ];
        for (const mismatch of cases) {
            await usingHarness({}, async (h) => {
                const intent = makeIntent(h);
                const wallet = h.service.getWalletForRoom(intent.roomId);
                h.setPayload(rowPayload(transactionFor(intent, wallet, mismatch.row(intent))));
                const report = await settle(h);
                equal(report.settled.length, 0, `${mismatch.name} mismatch is not settled`);
                equal(h.service.getPaymentIntent(intent.paymentReference).state, "PENDING", `${mismatch.name} mismatch preserves pending state`);
            });
        }
        await usingHarness({}, async (h) => {
            const intent = makeIntent(h, { asset: "USDT", amountAtomic: 2_000_000 });
            const wallet = h.service.getWalletForRoom(intent.roomId);
            h.setPayload(rowPayload(transactionFor(intent, wallet)));
            const report = await settle(h);
            equal(report.settled.length, 0, "TON transfer cannot match a USDT intent");
            equal(h.service.getPaymentIntent(intent.paymentReference).state, "PENDING", "asset mismatch leaves pending intent");
        });
        await usingHarness({ network: "mainnet" }, async (h) => {
            const intent = makeIntent(h, { network: "mainnet" });
            const wallet = h.service.getWalletForRoom(intent.roomId);
            h.setPayload(rowPayload(transactionFor(intent, wallet)));
            const report = await settle(h);
            equal(report.settled.length, 0, "testnet provider row cannot match mainnet intent");
            equal(h.service.getPaymentIntent(intent.paymentReference).state, "PENDING", "network mismatch leaves pending intent");
        });
        await usingHarness({}, async (h) => {
            const intent = makeIntent(h);
            const wallet = h.service.getWalletForRoom(intent.roomId);
            const row = transactionFor(intent, wallet);
            h.setPayload(rowPayload(row));
            h.service.matchTransaction(intent.paymentReference, "arbitrary-not-derived-id");
            const report = await settle(h);
            equal(report.settled.length, 0, "arbitrary transaction binding is not replaced");
            check(report.refused.length + report.unmatched.length > 0, "transaction identity mismatch is refused or left unmatched");
            equal(h.service.getPaymentIntent(intent.paymentReference).state, "MATCHED", "identity mismatch does not settle");
        });
    });

    // G8: Several distinct rows claiming one reference are globally ambiguous.
    await section("ambiguous duplicate-reference observations settle none", async () => {
        await usingHarness({}, async (h) => {
            const intent = makeIntent(h);
            const wallet = h.service.getWalletForRoom(intent.roomId);
            h.setPayload(rowPayload(
                transactionFor(intent, wallet, { suffix: "one" }),
                transactionFor(intent, wallet, { suffix: "two" })
            ));
            const report = await settle(h);
            equal(report.refusal, INCOMING_SETTLEMENT_REFUSAL.AMBIGUOUS_OBSERVATION, "duplicate candidate window is ambiguous");
            equal(report.settled.length, 0, "ambiguous window settles none");
            equal(h.service.getPaymentIntent(intent.paymentReference).state, "PENDING", "ambiguous intent stays pending");
        });
    });

    // G9: A transaction id cannot settle a second intent; exact replay is stable.
    await section("transaction collisions are refused and identical replay is idempotent", async () => {
        await usingHarness({}, async (h) => {
            const first = makeIntent(h, { playerId: "collision-first" });
            const second = makeIntent(h, { playerId: "collision-second" });
            const wallet = h.service.getWalletForRoom(first.roomId);
            const firstRow = transactionFor(first, wallet);
            h.setPayload(rowPayload(firstRow));
            const firstReport = await settle(h);
            equal(firstReport.settled.length, 1, "first intent claims transaction");
            h.setPayload(rowPayload(transactionFor(second, wallet, { hash: firstRow.hash })));
            const secondReport = await settle(h);
            equal(secondReport.settled.length, 0, "same provider transaction cannot settle a second intent");
            check(secondReport.refused.some((item) => item.reason === INCOMING_SETTLEMENT_REFUSAL_REASON.TRANSACTION_ALREADY_CREDITED), "transaction collision is explicitly refused");
            equal(h.service.getPaymentIntent(second.paymentReference).state, "PENDING", "collision does not bind second intent");
        });
        await usingHarness({}, async (h) => {
            const intent = makeIntent(h);
            const wallet = h.service.getWalletForRoom(intent.roomId);
            h.setPayload(rowPayload(transactionFor(intent, wallet)));
            const first = await settle(h);
            const second = await settle(h);
            equal(first.settled.length, 1, "initial call settles once");
            equal(second.settled.length, 0, "replay creates no second settlement");
            equal(second.alreadySettled.length, 1, "replay reports already-settled intent");
            equal(h.service.getPaymentIntent(intent.paymentReference).transactionId, first.settled[0].transactionId, "replay preserves transaction binding");
        });
    });

    // G10: Missing, unavailable and malformed evidence cannot produce settlement.
    await section("missing evidence and malformed provider payload fail closed", async () => {
        await usingHarness({}, async (h) => {
            const intent = makeIntent(h);
            throws(() => h.service.settlePayment(intent.paymentReference, null, "synthetic-tx"), PaymentValidationError, "null evidence rejected");
            h.setPayload({ notTransactions: [] });
            await rejects(settle(h), ToncenterResponseError, "malformed provider response rejected");
            equal(h.service.getPaymentIntent(intent.paymentReference).state, "PENDING", "unavailable evidence changes no state");
        });
    });

    // G11: Provider errors propagate from the synthetic transport with no retry.
    await section("HTTP 429 propagates without retry or settlement", async () => {
        await usingHarness({ responseStatus: 429 }, async (h) => {
            const intent = makeIntent(h);
            await rejects(settle(h), ToncenterRateLimitError, "rate limit error propagates");
            equal(h.fetchCalls, 1, "one explicit check makes one mocked request");
            equal(h.service.getPaymentIntent(intent.paymentReference).state, "PENDING", "rate limit does not settle");
        });
    });

    // G12: Refusals never become accounting principal.
    await section("failed observations append no principal and preserve zero total", async () => {
        await usingHarness({}, async (h) => {
            const intent = makeIntent(h);
            const wallet = h.service.getWalletForRoom(intent.roomId);
            h.setPayload(rowPayload(transactionFor(intent, wallet, { inMsg: { value: "1" } })));
            const report = await settle(h);
            equal(report.settled.length, 0, "mismatching transfer is refused");
            equal(h.ledger.store.list().filter((entry) => entry.kind === LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL).length, 0, "no principal ledger entry is appended");
            equal(h.ledger.getTotalSettledPrincipalAtomic(intent.roomId), 0, "settled principal remains zero");
            equal(h.ledger.getRoomLedgerView(intent.roomId).safetyMarginAtomic, 0, "safety margin remains fixed at zero");
        });
    });

    // G13: Public structure exposes no execution, scheduler or runtime wiring.
    await section("execution is disabled and coordinator remains explicit and isolated", async () => {
        await usingHarness({}, async (h) => {
            const capabilities = h.service.getCapabilities();
            equal(capabilities.transfersEnabled, false, "transfers disabled");
            equal(capabilities.broadcastsEnabled, false, "broadcasts disabled");
            equal(capabilities.smartContractsEnabled, false, "contracts disabled");
            equal(capabilities.realPaymentCollectionEnabled, false, "real collection disabled");
            throws(() => h.service.executePayment(), PaymentExecutionBlockedError, "execution gate refuses payment execution");
            equal(h.coordinator.hasBackgroundWork(), false, "coordinator has no background polling or retries");
            equal(h.observationService.hasBackgroundWork(), false, "observation service has no background work");
            check(Object.getOwnPropertyNames(Object.getPrototypeOf(h.coordinator)).includes("settleRoomPayments"), "coordinator exposes explicit public entry point");
            check(!Object.getOwnPropertyNames(Object.getPrototypeOf(h.coordinator)).includes("_settleValidatedCandidate"), "candidate settlement is not a public prototype method");
            const coordinatorSource = readFileSync(join(TEST_DIR, "../payment/incoming/IncomingPaymentSettlementCoordinator.js"), "utf8");
            const serviceSource = readFileSync(join(TEST_DIR, "../payment/RoomWalletPaymentService.js"), "utf8");
            check(!/from\s+["'][^"']*(?:server\/app|EventBus|gameplay|Page4|socket)[^"']*["']/i.test(coordinatorSource), "coordinator has no production runtime imports");
            check(!/from\s+["'][^"']*(?:server\/app|EventBus|gameplay|Page4|socket)[^"']*["']/i.test(serviceSource), "payment service has no production runtime imports");
            check(!/from\s+["'][^"']*(?:server\/app|EventBus|gameplay|Page4|socket)[^"']*["']/i.test(readFileSync(fileURLToPath(import.meta.url), "utf8")), "regression suite does not wire production runtime modules");
            equal(ROOM_LIFETIME_MS, 300_000, "immutable room lifetime is five minutes from room creation");
            check(h.client.baseUrl.includes("toncenter.com"), "client metadata is configured but its fetch path is injected mock");
        });
    });

    // G14: A normalized provider flag cannot replace trusted finality evidence.
    await section("provider confirmation flag alone cannot settle or book principal", async () => {
        await usingHarness({ withFinalityEvidence: false }, async (h) => {
            const intent = makeIntent(h);
            const wallet = h.service.getWalletForRoom(intent.roomId);
            h.setPayload(rowPayload(transactionFor(intent, wallet)));
            const report = await settle(h);
            equal(report.settled.length, 0, "confirmation flag does not authorize settlement");
            equal(report.refused[0].reason,
                INCOMING_SETTLEMENT_REFUSAL_REASON.SETTLEMENT_EVIDENCE_UNAVAILABLE,
                "coordinator reports missing finality evidence");
            equal(h.service.getPaymentIntent(intent.paymentReference).state, "PENDING",
                "intent remains unsettled");
            equal(h.ledger.store.list().filter((entry) =>
                entry.kind === LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL).length, 0,
            "no principal is booked");
            equal(h.ledger.getTotalSettledPrincipalAtomic(intent.roomId), 0,
                "ledger total remains zero");
        });
    });

    // G15: Malformed, contradictory and stale evidence are blocked before state or ledger writes.
    await section("malformed, contradictory and stale evidence leave intent and ledger unchanged", async () => {
        const invalidEvidence = [
            (query) => ({
                networkIdentity: undefined,
                transactionInclusion: {
                    transactionId: query.providerTransactionId,
                    accountId: query.accountId,
                    block: { workchain: 0, shard: "8000000000000000", seqno: 10 }
                },
                finality: { status: "finalized" }
            }),
            (query) => {
                const block = { workchain: 0, shard: "8000000000000000", seqno: 10 };
                const observedAtMs = NOW_MS;
                return {
                    networkIdentity: {
                        network: "testnet", globalId: -3,
                        source: "toncenter-masterchain-info", observedAtMs
                    },
                    transactionInclusion: {
                        transactionId: query.providerTransactionId,
                        accountId: query.accountId, block
                    },
                    finality: {
                        status: "finalized", source: "toncenter-streaming-v2",
                        transactionId: "different-transaction",
                        accountId: query.accountId, block,
                        masterchainSeqno: 11, observedAtMs
                    }
                };
            },
            (query) => {
                const block = { workchain: 0, shard: "8000000000000000", seqno: 10 };
                const observedAtMs = NOW_MS - 30_001;
                return {
                    networkIdentity: {
                        network: "testnet", globalId: -3,
                        source: "toncenter-masterchain-info", observedAtMs
                    },
                    transactionInclusion: {
                        transactionId: query.providerTransactionId,
                        accountId: query.accountId, block
                    },
                    finality: {
                        status: "finalized", source: "toncenter-streaming-v2",
                        transactionId: query.providerTransactionId,
                        accountId: query.accountId, block,
                        masterchainSeqno: 11, observedAtMs
                    }
                };
            }
        ];
        for (const evidenceFactory of invalidEvidence) {
            await usingHarness({ evidenceFactory }, async (h) => {
                const intent = makeIntent(h);
                const wallet = h.service.getWalletForRoom(intent.roomId);
                h.setPayload(rowPayload(transactionFor(intent, wallet)));
                const report = await settle(h);
                equal(report.settled.length, 0, "invalid evidence cannot settle");
                equal(report.refused[0].reason,
                    INCOMING_SETTLEMENT_REFUSAL_REASON.SETTLEMENT_EVIDENCE_UNAVAILABLE,
                    "invalid evidence is refused by coordinator");
                equal(h.service.getPaymentIntent(intent.paymentReference).state, "PENDING",
                    "invalid evidence leaves the intent pending");
                equal(h.ledger.getTotalSettledPrincipalAtomic(intent.roomId), 0,
                    "invalid evidence leaves ledger principal at zero");
            });
        }
    });

    if (sectionCount !== 15) {
        throw new Error(`Expected 15 groups; ran ${sectionCount}`);
    }
    process.stdout.write(`PASS ${sectionCount} groups, ${assertionCount} assertions\n`);
}

run().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
});
