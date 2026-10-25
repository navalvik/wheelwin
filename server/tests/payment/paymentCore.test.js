/**
 * Phase 1 вЂ” Room Wallet Payment Core (ISOLATED).
 *
 * This test is fully self-contained: it builds a synthetic 64-wallet catalog in
 * a temporary directory, so it never depends on, reads, or mutates any
 * repository config file or wallet secret material. Durable state for the
 * payment intent ledger and the wallet-pool snapshot lives only inside that
 * temporary workspace.
 *
 * Covered scenarios (per Phase 1 scope):
 *   1. Normal flow (wallet reservation, intent creation, credit, settle)
 *   2. Duplicate transactions (R7 вЂ” one tx id credited to at most one intent)
 *   3. Duplicate / conflicting wallet reservations (R3 / R8)
 *   4. Expiration + the immutable 300000 ms room deadline (R1)
 *   5. Restart-safe durable persistence (R4)
 *   6. Execution gate (no blockchain transfer can run in Phase 1)
 *   7. Asset / denomination mapping must be explicit (fail closed)
 *
 * Project convention: plain ESM + a manual `assert` harness; no test framework
 * and no external dependencies are required.
 */

import { createHash } from "node:crypto";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    ROOM_LIFETIME_MS,
    ROOM_WALLET_POOL_SIZE,
    PAYMENT_INTENT_STATE,
    AssetDenominationRegistry,
    InvalidPaymentStateTransitionError,
    PaymentIntentStore,
    RoomWalletPaymentService,
    WalletPoolRegistry,
    canTransition
} from "../../payment/index.js";

import {
    deriveTonAddressIdentity,
    formatPaymentReference
} from "../../payment/incoming/index.js";

import {
    RoomPaymentObservationService,
    ToncenterIncomingProvider,
    ToncenterTransactionsClient
} from "../../payment/toncenter/index.js";
import { SyntheticTonSettlementEvidenceProvider } from "../helpers/syntheticTonSettlementEvidence.js";

import {
    IncomingPaymentSettlementCoordinator
} from "../../payment/incoming/IncomingPaymentSettlementCoordinator.js";

// ---------------------------------------------------------------------------
// Minimal assertion harness (project convention)
// ---------------------------------------------------------------------------

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

let checksPassed = 0;

function check(condition, message) {

    assert(condition, message);

    checksPassed += 1;

}

function expectThrow(fn, expectedName, message) {

    let thrown = null;

    try {

        fn();

    } catch (error) {

        thrown = error;

    }

    assert(
        thrown !== null,
        `${message} (expected ${expectedName}, nothing thrown)`
    );

    assert(
        thrown?.name === expectedName,
        `${message} (expected ${expectedName}, got ${thrown?.name}: ${thrown?.message})`
    );

    return thrown;

}

// ---------------------------------------------------------------------------
// Isolated workspace fixture (synthetic catalog вЂ” no secrets, no repo access)
// ---------------------------------------------------------------------------

const ROOM_CREATED_AT = 1_700_000_000_000;

/** Synthetic key fixture вЂ” never read from the environment, never real. */
const SYNTHETIC_API_KEY = "SYNTHETIC-TONCENTER-TEST-KEY-NOT-REAL";

function crc16Xmodem(template) {

    const poly = 0x1021;

    let register = 0;

    const message = Buffer.alloc(template.length + 2);

    message.set(template);

    for (const byte of message) {

        for (let mask = 0x80; mask > 0; mask >>= 1) {

            register <<= 1;

            if (byte & mask) {

                register += 1;

            }

            if (register > 0xffff) {

                register &= 0xffff;
                register ^= poly;

            }

        }

    }

    return [Math.floor(register / 256), register % 256];

}

/**
 * Deterministic, checksum-valid synthetic TON address (test data only). Same
 * construction `TonAddressIdentity.js` validates, so every fixture address
 * below is a real address of a synthetic account.
 */
function friendlyAddressFor(seed) {

    const hashHex = createHash("sha256")
        .update(`wheelwin-payment-core:${seed}`, "utf8")
        .digest("hex");

    const payload = Buffer.concat([
        Buffer.from([0x11, 0x00]),
        Buffer.from(hashHex, "hex")
    ]);

    const [high, low] = crc16Xmodem(payload);

    return Buffer.concat([payload, Buffer.from([high, low])]).toString("base64url");

}

function isolatedWorkspace() {

    const workspace = mkdtempSync(join(tmpdir(), "wheelwin-payment-isolated-"));

    const configDir = join(workspace, "config");

    mkdirSync(configDir, { recursive: true });

    // Synthetic 64-wallet testnet pool. Public identity only вЂ” no secret keys.
    const catalog = [];

    for (let roomNumber = 1; roomNumber <= ROOM_WALLET_POOL_SIZE; roomNumber += 1) {

        catalog.push({
            roomNumber,
            address: friendlyAddressFor(`room-wallet-${roomNumber}`),
            publicKey: null,
            workchain: 0,
            network: "testnet"
        });

    }

    const catalogPath = join(configDir, "wallets.json");

    writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

    return {
        workspace,
        catalogPath,
        dataDir: join(workspace, "data")
    };

}

function configuredAssets() {

    // Explicit mapping вЂ” NOT hardcoded. `Gram` is never assumed to equal a
    // particular amount of TON; the atomic-unit value comes from config.
    return [
        {
            asset: "TON",
            symbol: "Gram",
            network: "testnet",
            atomicUnitsPerUnit: 1_000_000_000
        }
    ];

}

function buildHarness({ assets = configuredAssets(), clock = null } = {}) {

    const env = isolatedWorkspace();

    let syntheticTransactions = [];

    const nowProvider = clock ?? (() => ROOM_CREATED_AT + 1_000);

    const walletPool = new WalletPoolRegistry({
        catalogPath: env.catalogPath,
        network: "testnet"
    });

    const intentStore = new PaymentIntentStore({
        dataDir: env.dataDir,
        nowProvider
    });

    const assetRegistry = AssetDenominationRegistry.fromConfiguration({ assets });

    const client = new ToncenterTransactionsClient({

        apiKeyProvider: () => SYNTHETIC_API_KEY,

        fetchImpl: async () => ({

            status: 200,

            json: async () => ({

                transactions: syntheticTransactions,
                address_book: {}

            })

        })

    });

    const observationService = new RoomPaymentObservationService({
        provider: new ToncenterIncomingProvider({ client }),
        settlementEvidenceProvider: new SyntheticTonSettlementEvidenceProvider({ nowProvider }),
        nowProvider
    });
    const service = new RoomWalletPaymentService({
        walletPool,
        intentStore,
        assetRegistry,
        snapshotDir: env.dataDir,
        nowProvider,
        observationService
    });

    return {
        env,
        nowProvider,
        walletPool,
        intentStore,
        assetRegistry,
        observationService,
        service,
        setSyntheticTransactions(transactions) {
            syntheticTransactions = [...transactions];
        }
    };

}

function createIntent(harness, overrides = {}) {

    return harness.service.createPaymentIntent({
        paymentReference: `pay-${Math.random().toString(36).slice(2, 11)}`,
        roomId: "room-a",
        playerId: "player-1",
        expectedSender: friendlyAddressFor("sender-111"),
        amountAtomic: 2_000_000_000,
        asset: "TON",
        network: "testnet",
        roomCreatedAt: ROOM_CREATED_AT,
        now: harness.nowProvider(),
        ...overrides
    });

}

// ---------------------------------------------------------------------------
// Phase 3D вЂ” trusted observation stack (synthetic response, no network)
// ---------------------------------------------------------------------------

/** A synthetic player sender address (synthetic test data only). */
function syntheticSender(tag) {

    return friendlyAddressFor(`sender-${tag}`);

}

/**
 * One transaction in the documented v3 response shape for `intent`, mapped
 * inside the observation window the coordinator derives from the intents of the
 * room.
 */
function syntheticTransactionRow(harness, intent, overrides = {}) {

    const destination = deriveTonAddressIdentity(intent.destinationWalletAddress);

    const source = deriveTonAddressIdentity(intent.expectedSender);

    const nowSeconds = Math.floor(harness.nowProvider() / 1000);

    return {
        account: destination,
        hash: overrides.hash ?? "a".repeat(64),
        lt: "40576730000001",
        now: nowSeconds,
        orig_status: "active",
        end_status: "active",
        total_fees: "1234",
        prev_trans_hash: "0".repeat(64),
        prev_trans_lt: "40576730000000",
        description: {
            type: "trans_ord",
            aborted: false,
            destroyed: false,
            credit_first: true,
            storage_ph: { status_change: "unchanged" },
            compute_ph: { success: true, exit_code: 0, gas_used: "0" },
            action: { success: true, valid: true, no_funds: false }
        },
        in_msg: {
            hash: "c".repeat(64),
            source,
            destination,
            value: String(intent.amountAtomic),
            fwd_fee: "1",
            ihr_fee: "0",
            created_lt: "40576730000001",
            created_at: String(nowSeconds),
            opcode: 0,
            bounce: true,
            bounced: false,
            message_content: {
                hash: "d".repeat(64),
                body: "te6cckEBAQEAAgAAAEysuc0=",
                decoded: {
                    type: "text_comment",
                    comment: formatPaymentReference(intent.paymentReference)
                }
            }
        },
        out_msgs: []
    };

}

/**
 * The Phase 3D settlement coordinator over the REAL observation stack with a
 * synthetic in-memory provider response. Nothing here talks to the network.
 *
 * @param {object} harness
 * @param {object} intent authoritative intent the observation must confirm
 * @param {{ hash?: string }} [overrides]
 */
function buildObservationCoordinator(harness, intent, overrides = {}) {

    harness.setSyntheticTransactions([
        syntheticTransactionRow(harness, intent, overrides)
    ]);

    return new IncomingPaymentSettlementCoordinator({
        paymentService: harness.service,
        observationService: harness.observationService,
        nowProvider: () => harness.nowProvider()
    });

}

/**
 * Settle `intent` through the trusted observation boundary.
 *
 * @param {object} harness
 * @param {object} intent
 * @param {{ hash?: string }} [overrides]
 */
async function settleFromObservation(harness, intent, overrides = {}) {

    const coordinator = buildObservationCoordinator(harness, intent, overrides);

    return coordinator.settleRoomPayments({
        roomId: intent.roomId,
        now: harness.nowProvider()
    });

}

// ---------------------------------------------------------------------------
// Group 1 вЂ” normal flow
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    harness.service.initialize();

    const intent = createIntent(harness, {
        paymentReference: "pay-normal-1",
        playerId: "player-1",
        expectedSender: syntheticSender("111"),
        amountAtomic: 3_000_000_000
    });

    // R5 вЂ” every required identity field present.
    check(intent.roomId === "room-a", "payment intent must identify the room");
    check(intent.playerId === "player-1", "payment intent must identify the player");
    check(intent.network === "testnet", "payment intent must identify the network");
    check(
        typeof intent.destinationWalletId === "string"
            && intent.destinationWalletId.trim() !== "",
        "payment intent must identify the assigned destination wallet"
    );
    check(
        intent.expectedSender === syntheticSender("111"),
        "payment intent must identify the expected sender"
    );
    check(
        Number.isSafeInteger(intent.amountAtomic) && intent.amountAtomic === 3_000_000_000,
        "payment intent must carry an exact integer atomic-unit amount"
    );
    check(
        typeof intent.createdAt === "number" && intent.createdAt > 0,
        "payment intent must carry a creation time"
    );
    check(
        Number.isInteger(intent.expiresAt) && intent.expiresAt > intent.createdAt,
        "payment intent must carry an absolute expiration time"
    );
    check(
        intent.roomDeadlineMs === ROOM_CREATED_AT + ROOM_LIFETIME_MS,
        "payment intent deadline must equal roomCreatedAt + 300000"
    );
    check(intent.state === "PENDING", "new payment intent must start PENDING");

    // R3 вЂ” exactly one wallet per room; a second player reuses it.
    const secondIntent = createIntent(harness, {
        paymentReference: "pay-normal-2",
        playerId: "player-2",
        expectedSender: syntheticSender("222"),
        amountAtomic: 1_000_000_000
    });

    check(
        secondIntent.destinationWalletId === intent.destinationWalletId,
        "players in the same room must reuse the room's assigned wallet"
    );

    check(
        harness.walletPool.getReservedCount() === 1,
        "one reservation must back both intents of the room"
    );

    // Retrieve by unique reference (R6 вЂ” identity is the reference).
    const fetched = harness.service.getPaymentIntent("pay-normal-1");

    check(
        fetched.paymentReference === "pay-normal-1",
        "payment intents must be retrievable by their unique payment reference"
    );

    // Credit then settle вЂ” the credit transition of the second room-mate.
    const matched = harness.service.matchTransaction("pay-normal-2", "tx-0002");

    check(matched.state === "MATCHED", "credited intent must be MATCHED");
    check(
        matched.transactionId === "tx-0002",
        "the credited transaction id must be recorded"
    );

    // Phase 3D вЂ” a credit alone can NEVER settle a payment: settlement requires
    // a trusted observation authority issued by the settlement coordinator.
    const direct = expectThrow(
        () => harness.service.settlePayment("pay-normal-2"),
        "PaymentValidationError",
        "settlePayment() must fail closed without a trusted observation authority"
    );

    check(
        direct.code === "PAYMENT_VALIDATION_INVALID",
        "a direct settlement must be a payment validation failure"
    );

    expectThrow(
        () => harness.service.settlePayment("pay-normal-2", {
            paymentReference: "pay-normal-2",
            transactionId: "tx-0002",
            providerConfirmed: true
        }),
        "PaymentValidationError",
        "an object with matching field names must never authorize a settlement"
    );

    // The first payment, settled only through the trusted observation boundary.
    const report = await settleFromObservation(harness, intent);

    check(
        report.settled.length === 1
            && report.settled[0].paymentReference === "pay-normal-1",
        "a validated observation must settle exactly the observed payment"
    );

    check(
        harness.service.getPaymentIntent("pay-normal-1").state === "SETTLED",
        "the persisted payment intent must be SETTLED"
    );

    check(
        harness.service.getPaymentIntent("pay-normal-1").transactionId
            === report.settled[0].transactionId,
        "the settled intent must carry the observed transaction identity"
    );

    // The credited room-mate was NOT observed, so it can never settle.
    check(
        harness.service.getPaymentIntent("pay-normal-2").state === "MATCHED",
        "a payment without a matching observation must stay MATCHED"
    );

    // Invalid transitions must be rejected.
    expectThrow(
        () => harness.intentStore.get("pay-normal-1").transition("SETTLED"),
        "InvalidPaymentStateTransitionError",
        "settling an already SETTLED intent must be rejected"
    );

    // State transition invariant only; no refund transfer is performed.
    const settledIntent = harness.service.getPaymentIntent("pay-normal-1");

    expectThrow(
        () => settledIntent.transition(PAYMENT_INTENT_STATE.REFUNDED),
        InvalidPaymentStateTransitionError.name,
        "an already-SETTLED intent must reject transition to REFUNDED"
    );

    expectThrow(
        () => harness.service.cancelPayment("pay-normal-1"),
        "InvalidPaymentStateTransitionError",
        "cancelling a terminal intent must be rejected"
    );

    check(
        canTransition("SETTLED", "PENDING") === false,
        "no transition may leave a terminal state"
    );

    rmSync(harness.env.workspace, { recursive: true, force: true });

    console.log("[1/6] normal flow: PASS");

}

// ---------------------------------------------------------------------------
// Group 2 вЂ” duplicate transactions (R7 idempotency)
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    harness.service.initialize();

    createIntent(harness, {
        paymentReference: "pay-tx-A",
        playerId: "player-1",
        expectedSender: syntheticSender("111"),
        amountAtomic: 2_000_000_000
    });

    createIntent(harness, {
        paymentReference: "pay-tx-B",
        playerId: "player-2",
        expectedSender: syntheticSender("222"),
        amountAtomic: 2_000_000_000
    });

    // Same amount + same destination + a close timestamp вЂ” but distinct
    // references. Neither may be credited to the same transaction.
    harness.service.matchTransaction("pay-tx-A", "tx-shared-1");

    const duplicate = expectThrow(
        () => harness.service.matchTransaction("pay-tx-B", "tx-shared-1"),
        "TransactionAlreadyCreditedError",
        "the same transaction id must not be credited to a second intent"
    );

    check(
        duplicate.code === "TRANSACTION_ALREADY_CREDITED",
        "duplicate transaction must use TRANSACTION_ALREADY_CREDITED"
    );

    check(
        duplicate.details.creditedTo === "pay-tx-A",
        "the conflict must name the payment intent already credited"
    );

    // Idempotent replay of the SAME credit on the SAME intent is allowed.
    const replay = harness.service.matchTransaction("pay-tx-A", "tx-shared-1");

    check(
        replay.state === "MATCHED" && replay.transactionId === "tx-shared-1",
        "replaying the identical credit must be idempotent"
    );

    // A different transaction on the already-matched intent must be rejected.
    const rebound = expectThrow(
        () => harness.service.matchTransaction("pay-tx-A", "tx-shared-2"),
        "InvalidPaymentStateTransitionError",
        "re-pointing a MATCHED intent to a new transaction must be rejected"
    );

    check(
        rebound.code === "PAYMENT_STATE_TRANSITION_INVALID",
        "rebinding a matched intent must be an invalid state transition"
    );

    check(
        harness.intentStore.findByTransactionId("tx-shared-1")?.paymentReference
            === "pay-tx-A",
        "transaction lookup must resolve to the credited payment reference"
    );

    rmSync(harness.env.workspace, { recursive: true, force: true });

    console.log("[2/6] duplicate transactions (idempotency): PASS");

}

// ---------------------------------------------------------------------------
// Group 3 вЂ” duplicate / conflicting wallet reservations (R3 / R8)
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    harness.service.initialize();

    const wallet = harness.service.reserveWalletForRoom({ roomId: "room-dup" });

    check(
        wallet.reservedByRoomId === "room-dup",
        "reservation must record the owning room"
    );

    // Duplicate assignment for the same room.
    expectThrow(
        () => harness.service.reserveWalletForRoom({ roomId: "room-dup" }),
        "WalletAssignmentConflictError",
        "a room must not be assigned a second wallet"
    );

    // Conflicting active reservation on that wallet.
    expectThrow(
        () => harness.service.reserveWalletForRoom({
            roomId: "room-conflict",
            walletId: wallet.walletId
        }),
        "WalletAssignmentConflictError",
        "an active reservation must conflict with a second room"
    );

    // A different free wallet for the other room is fine.
    const other = harness.service.reserveWalletForRoom({ roomId: "room-other" });

    check(
        other.walletId !== wallet.walletId,
        "a second room must receive a different wallet"
    );

    // Creating a payment intent for an already-reserved room reuses the wallet.
    const intent = createIntent(harness, {
        paymentReference: "pay-dup-1",
        roomId: "room-dup"
    });

    check(
        intent.destinationWalletId === wallet.walletId,
        "intent creation must reuse the room's existing wallet reservation"
    );

    // A duplicate payment reference must be rejected (R6).
    expectThrow(
        () => createIntent(harness, {
            paymentReference: "pay-dup-1",
            roomId: "room-dup"
        }),
        "PaymentReferenceCollisionError",
        "a duplicate payment reference must be rejected"
    );

    // R8 вЂ” release is blocked while the room's intent is PENDING.
    expectThrow(
        () => harness.service.releaseWalletForRoom("room-dup"),
        "WalletRecyclingBlockedError",
        "release must be blocked while the room has an open obligation"
    );

    rmSync(harness.env.workspace, { recursive: true, force: true });

    console.log("[3/6] duplicate / conflicting reservations: PASS");

}

// ---------------------------------------------------------------------------
// Group 4 вЂ” expiration + immutable 300000 ms room deadline (R1)
// ---------------------------------------------------------------------------

{

    let clockNow = ROOM_CREATED_AT + 1_000;

    const harness = buildHarness({ clock: () => clockNow });

    harness.service.initialize();

    // The room deadline is exactly roomCreatedAt + 300000 ms.
    const deadline = harness.service.getRoomDeadline(ROOM_CREATED_AT);

    check(
        deadline.deadlineMs === ROOM_CREATED_AT + 300_000,
        "room deadline must be exactly roomCreatedAt + 300000"
    );

    check(
        harness.service.roomLifetimeMs === 300_000,
        "room lifetime must remain exactly 300000 ms"
    );

    createIntent(harness, {
        paymentReference: "pay-exp-1",
        roomId: "room-exp",
        playerId: "player-1",
        expectedSender: syntheticSender("111"),
        amountAtomic: 2_000_000_000
    });

    // Before expiry, an expiry attempt is invalid.
    expectThrow(
        () => harness.service.expirePaymentIntent(
            "pay-exp-1",
            ROOM_CREATED_AT + 300_000 - 1
        ),
        "PaymentValidationError",
        "expiring before the deadline must be rejected"
    );

    // A credit after expiration must be refused and must not mutate state.
    const afterDeadline = ROOM_CREATED_AT + 480_001;

    clockNow = afterDeadline;

    expectThrow(
        () => harness.service.matchTransaction("pay-exp-1", "tx-late"),
        "PaymentIntentExpiredError",
        "crediting an expired payment intent must be refused"
    );

    check(
        harness.intentStore.get("pay-exp-1").state === "PENDING",
        "a refused late credit must leave the intent unchanged"
    );

    // Expiring at exactly the deadline is allowed and is terminal.
    const expired = harness.service.expirePaymentIntent(
        "pay-exp-1",
        ROOM_CREATED_AT + 300_000
    );

    check(expired.state === "EXPIRED", "intent must be EXPIRED at its deadline");

    expectThrow(
        () => harness.service.matchTransaction("pay-exp-1", "tx-never"),
        "InvalidPaymentStateTransitionError",
        "crediting an EXPIRED intent must be rejected"
    );

    // Creating an intent at/after the immutable room deadline is refused.
    expectThrow(
        () => createIntent(harness, {
            paymentReference: "pay-exp-late",
            roomId: "room-exp-late",
            playerId: "player-9",
            expectedSender: syntheticSender("999"),
            amountAtomic: 1_000_000_000,
            now: afterDeadline
        }),
        "PaymentIntentExpiredError",
        "creating a payment intent after the room deadline must be refused"
    );

    rmSync(harness.env.workspace, { recursive: true, force: true });

    console.log("[4/6] expiration + 300s deadline: PASS");

}

// ---------------------------------------------------------------------------
// Group 5 вЂ” restart-safe durable persistence (R4)
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    harness.service.initialize();

    createIntent(harness, {
        paymentReference: "pay-persist-1",
        roomId: "room-p",
        playerId: "player-1",
        expectedSender: syntheticSender("111"),
        amountAtomic: 4_000_000_000
    });

    createIntent(harness, {
        paymentReference: "pay-persist-2",
        roomId: "room-q",
        playerId: "player-2",
        expectedSender: syntheticSender("222"),
        amountAtomic: 1_000_000_000
    });

    // Phase 3D вЂ” the payment can only reach SETTLED through the trusted
    // observation boundary.
    const persistReport = await settleFromObservation(
        harness,
        harness.service.getPaymentIntent("pay-persist-1")
    );

    check(
        persistReport.settled.length === 1,
        "a validated observation must settle the observed payment"
    );

    check(
        persistReport.settled[0].transactionId.startsWith("ttx_"),
        "the settled transaction must be the server-derived transaction identity"
    );

    const qWalletBeforeRestart = harness.service.getWalletForRoom("room-q");

    harness.service.shutdown();

    // --- simulate a full restart against the SAME durable data directory ----
    const restartedWalletPool = new WalletPoolRegistry({
        catalogPath: harness.env.catalogPath,
        network: "testnet"
    });

    const restartedStore = new PaymentIntentStore({
        dataDir: harness.env.dataDir
    });

    const restartedClient = new ToncenterTransactionsClient({
        apiKeyProvider: () => SYNTHETIC_API_KEY,
        fetchImpl: async () => ({
            status: 200,
            json: async () => ({ transactions: [], address_book: {} })
        })
    });
    const restartedObservationService = new RoomPaymentObservationService({
        provider: new ToncenterIncomingProvider({ client: restartedClient }),
        nowProvider: harness.nowProvider
    });

    const restartedService = new RoomWalletPaymentService({
        walletPool: restartedWalletPool,
        intentStore: restartedStore,
        assetRegistry: AssetDenominationRegistry.fromConfiguration({
            assets: configuredAssets()
        }),
        snapshotDir: harness.env.dataDir,
        observationService: restartedObservationService
    });

    restartedService.initialize();

    check(
        restartedService.hasPaymentIntent("pay-persist-1") === true,
        "a payment intent must survive a restart"
    );

    const restored = restartedService.getPaymentIntent("pay-persist-1");

    check(
        restored.state === "SETTLED",
        `restored intent state must be SETTLED, got ${restored.state}`
    );

    check(
        restored.transactionId === persistReport.settled[0].transactionId,
        "the credited transaction must survive a restart"
    );

    check(
        restartedStore.size === 2,
        `both payment intents must survive a restart, got ${restartedStore.size}`
    );

    // R7 must hold across restarts.
    expectThrow(
        () => restartedService.matchTransaction(
            "pay-persist-2",
            persistReport.settled[0].transactionId
        ),
        "TransactionAlreadyCreditedError",
        "a transaction credited before a restart must not be reusable after it"
    );

    // R8 must hold across restarts: room-q is still PENDING.
    check(
        restartedService.countOpenObligations("room-q") === 1,
        "a PENDING intent must still block wallet recycling after a restart"
    );

    expectThrow(
        () => restartedService.releaseWalletForRoom("room-q"),
        "WalletRecyclingBlockedError",
        "an unresolved obligation must still block release after a restart"
    );

    expectThrow(
        () => restartedService.reserveWalletForRoom({
            roomId: "room-conflicting",
            walletId: qWalletBeforeRestart.walletId
        }),
        "WalletAssignmentConflictError",
        "a wallet with unresolved obligations must not be recycled after a restart"
    );

    rmSync(harness.env.workspace, { recursive: true, force: true });

    console.log("[5/6] restart-safe durable persistence: PASS");

}

// ---------------------------------------------------------------------------
// Group 6 вЂ” execution gate + explicit denomination mapping
// ---------------------------------------------------------------------------

{

    // 6a. Phase 1 can never execute a transfer, with or without config.
    const configured = buildHarness();

    configured.service.initialize();

    const blocked = expectThrow(
        () => configured.service.executePayment(),
        "PaymentExecutionBlockedError",
        "executePayment must be blocked in Phase 1"
    );

    check(
        blocked.code === "PAYMENT_EXECUTION_BLOCKED",
        "executePayment must fail with PAYMENT_EXECUTION_BLOCKED"
    );

    const capabilities = configured.service.getCapabilities();

    check(capabilities.transfersEnabled === false, "transfer capability must be explicitly disabled");
    check(capabilities.smartContractsEnabled === false, "smart-contract capability must be explicitly disabled");
    check(capabilities.realPaymentCollectionEnabled === false, "real payment collection must be explicitly disabled");
    check(capabilities.walletPoolSize === 64, "capability descriptor must report the 64-wallet pool");

    // 6b. Without the mapping, payment execution must be refused and no
    // orphan reservation may be left behind.
    const unconfigured = buildHarness({ assets: [] });

    unconfigured.service.initialize();

    const rejected = expectThrow(
        () => createIntent(unconfigured, {
            paymentReference: "pay-unconfigured",
            roomId: "room-u"
        }),
        "PaymentExecutionBlockedError",
        "payment execution must be rejected when the mapping is not configured"
    );

    check(
        rejected.code === "PAYMENT_EXECUTION_BLOCKED",
        "missing denomination mapping must fail with PAYMENT_EXECUTION_BLOCKED"
    );

    check(
        unconfigured.service.getWalletForRoom("room-u") === null,
        "a refused execution must not leave a reservation behind"
    );

    // 6c. Floating-point amounts must be rejected (integer atomic units only).
    expectThrow(
        () => createIntent(configured, {
            paymentReference: "pay-float",
            roomId: "room-f",
            amountAtomic: 1.5
        }),
        "PaymentValidationError",
        "floating-point amounts must be rejected"
    );

    rmSync(configured.env.workspace, { recursive: true, force: true });
    rmSync(unconfigured.env.workspace, { recursive: true, force: true });

    console.log("[6/6] execution gate + denomination mapping: PASS");

}

console.log(
    `\nIsolated payment-core tests passed | assertions=${checksPassed}`
        + ` | roomLifetimeMs=${ROOM_LIFETIME_MS}`
        + ` | walletPoolSize=${ROOM_WALLET_POOL_SIZE}`
        + ` | transfersEnabled=false`
);

export { checksPassed };
