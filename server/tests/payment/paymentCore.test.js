/**
 * Phase 1 — Room Wallet Payment Core (ISOLATED).
 *
 * This test is fully self-contained: it builds a synthetic 64-wallet catalog in
 * a temporary directory, so it never depends on, reads, or mutates any
 * repository config file or wallet secret material. Durable state for the
 * payment intent ledger and the wallet-pool snapshot lives only inside that
 * temporary workspace.
 *
 * Covered scenarios (per Phase 1 scope):
 *   1. Normal flow (wallet reservation, intent creation, credit, settle)
 *   2. Duplicate transactions (R7 — one tx id credited to at most one intent)
 *   3. Duplicate / conflicting wallet reservations (R3 / R8)
 *   4. Expiration + the immutable 480000 ms room deadline (R1)
 *   5. Restart-safe durable persistence (R4)
 *   6. Execution gate (no blockchain transfer can run in Phase 1)
 *   7. Asset / denomination mapping must be explicit (fail closed)
 *
 * Project convention: plain ESM + a manual `assert` harness; no test framework
 * and no external dependencies are required.
 */

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
    AssetDenominationRegistry,
    PaymentIntentStore,
    RoomWalletPaymentService,
    WalletPoolRegistry,
    canTransition
} from "../../payment/index.js";

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
// Isolated workspace fixture (synthetic catalog — no secrets, no repo access)
// ---------------------------------------------------------------------------

const ROOM_CREATED_AT = 1_700_000_000_000;

function isolatedWorkspace() {

    const workspace = mkdtempSync(join(tmpdir(), "wheelwin-payment-isolated-"));

    const configDir = join(workspace, "config");

    mkdirSync(configDir, { recursive: true });

    // Synthetic 64-wallet testnet pool. Public identity only — no secret keys.
    const catalog = [];

    for (let roomNumber = 1; roomNumber <= ROOM_WALLET_POOL_SIZE; roomNumber += 1) {

        catalog.push({
            roomNumber,
            address: `EQRoomWallet${String(roomNumber).padStart(3, "0")}____________`,
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

    // Explicit mapping — NOT hardcoded. `Gram` is never assumed to equal a
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

    const service = new RoomWalletPaymentService({
        walletPool,
        intentStore,
        assetRegistry,
        snapshotDir: env.dataDir,
        nowProvider
    });

    return { env, nowProvider, walletPool, intentStore, assetRegistry, service };

}

function createIntent(harness, overrides = {}) {

    return harness.service.createPaymentIntent({
        paymentReference: `pay-${Math.random().toString(36).slice(2, 11)}`,
        roomId: "room-a",
        playerId: "player-1",
        expectedSender: "EQSENDER____111",
        amountAtomic: 2_000_000_000,
        asset: "TON",
        network: "testnet",
        roomCreatedAt: ROOM_CREATED_AT,
        now: harness.nowProvider(),
        ...overrides
    });

}

// ---------------------------------------------------------------------------
// Group 1 — normal flow
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    harness.service.initialize();

    const intent = createIntent(harness, {
        paymentReference: "pay-normal-1",
        playerId: "player-1",
        expectedSender: "EQSENDER____111",
        amountAtomic: 3_000_000_000
    });

    // R5 — every required identity field present.
    check(intent.roomId === "room-a", "payment intent must identify the room");
    check(intent.playerId === "player-1", "payment intent must identify the player");
    check(intent.network === "testnet", "payment intent must identify the network");
    check(
        typeof intent.destinationWalletId === "string"
            && intent.destinationWalletId.trim() !== "",
        "payment intent must identify the assigned destination wallet"
    );
    check(
        intent.expectedSender === "EQSENDER____111",
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
        "payment intent deadline must equal roomCreatedAt + 480000"
    );
    check(intent.state === "PENDING", "new payment intent must start PENDING");

    // R3 — exactly one wallet per room; a second player reuses it.
    const secondIntent = createIntent(harness, {
        paymentReference: "pay-normal-2",
        playerId: "player-2",
        expectedSender: "EQSENDER____222",
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

    // Retrieve by unique reference (R6 — identity is the reference).
    const fetched = harness.service.getPaymentIntent("pay-normal-1");

    check(
        fetched.paymentReference === "pay-normal-1",
        "payment intents must be retrievable by their unique payment reference"
    );

    // Credit then settle.
    const matched = harness.service.matchTransaction("pay-normal-1", "tx-0001");

    check(matched.state === "MATCHED", "credited intent must be MATCHED");
    check(
        matched.transactionId === "tx-0001",
        "the credited transaction id must be recorded"
    );

    const settled = harness.service.settlePayment("pay-normal-1");

    check(settled.state === "SETTLED", "matched intent must be settleable");

    // Invalid transitions must be rejected.
    expectThrow(
        () => harness.service.settlePayment("pay-normal-1"),
        "InvalidPaymentStateTransitionError",
        "settling an already SETTLED intent must be rejected"
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
// Group 2 — duplicate transactions (R7 idempotency)
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    harness.service.initialize();

    createIntent(harness, {
        paymentReference: "pay-tx-A",
        playerId: "player-1",
        expectedSender: "EQSENDER____111",
        amountAtomic: 2_000_000_000
    });

    createIntent(harness, {
        paymentReference: "pay-tx-B",
        playerId: "player-2",
        expectedSender: "EQSENDER____222",
        amountAtomic: 2_000_000_000
    });

    // Same amount + same destination + a close timestamp — but distinct
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
// Group 3 — duplicate / conflicting wallet reservations (R3 / R8)
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

    // R8 — release is blocked while the room's intent is PENDING.
    expectThrow(
        () => harness.service.releaseWalletForRoom("room-dup"),
        "WalletRecyclingBlockedError",
        "release must be blocked while the room has an open obligation"
    );

    rmSync(harness.env.workspace, { recursive: true, force: true });

    console.log("[3/6] duplicate / conflicting reservations: PASS");

}

// ---------------------------------------------------------------------------
// Group 4 — expiration + immutable 480000 ms room deadline (R1)
// ---------------------------------------------------------------------------

{

    let clockNow = ROOM_CREATED_AT + 1_000;

    const harness = buildHarness({ clock: () => clockNow });

    harness.service.initialize();

    // The room deadline is exactly roomCreatedAt + 480000 ms.
    const deadline = harness.service.getRoomDeadline(ROOM_CREATED_AT);

    check(
        deadline.deadlineMs === ROOM_CREATED_AT + 480_000,
        "room deadline must be exactly roomCreatedAt + 480000"
    );

    check(
        harness.service.roomLifetimeMs === 480_000,
        "room lifetime must remain exactly 480000 ms"
    );

    createIntent(harness, {
        paymentReference: "pay-exp-1",
        roomId: "room-exp",
        playerId: "player-1",
        expectedSender: "EQSENDER____111",
        amountAtomic: 2_000_000_000
    });

    // Before expiry, an expiry attempt is invalid.
    expectThrow(
        () => harness.service.expirePaymentIntent(
            "pay-exp-1",
            ROOM_CREATED_AT + 480_000 - 1
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
        ROOM_CREATED_AT + 480_000
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
            expectedSender: "EQSENDER____999",
            amountAtomic: 1_000_000_000,
            now: afterDeadline
        }),
        "PaymentIntentExpiredError",
        "creating a payment intent after the room deadline must be refused"
    );

    rmSync(harness.env.workspace, { recursive: true, force: true });

    console.log("[4/6] expiration + 480s deadline: PASS");

}

// ---------------------------------------------------------------------------
// Group 5 — restart-safe durable persistence (R4)
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    harness.service.initialize();

    createIntent(harness, {
        paymentReference: "pay-persist-1",
        roomId: "room-p",
        playerId: "player-1",
        expectedSender: "EQSENDER____111",
        amountAtomic: 4_000_000_000
    });

    createIntent(harness, {
        paymentReference: "pay-persist-2",
        roomId: "room-q",
        playerId: "player-2",
        expectedSender: "EQSENDER____222",
        amountAtomic: 1_000_000_000
    });

    harness.service.matchTransaction("pay-persist-1", "tx-persist-1");

    harness.service.settlePayment("pay-persist-1");

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

    const restartedService = new RoomWalletPaymentService({
        walletPool: restartedWalletPool,
        intentStore: restartedStore,
        assetRegistry: AssetDenominationRegistry.fromConfiguration({
            assets: configuredAssets()
        }),
        snapshotDir: harness.env.dataDir
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
        restored.transactionId === "tx-persist-1",
        "the credited transaction must survive a restart"
    );

    check(
        restartedStore.size === 2,
        `both payment intents must survive a restart, got ${restartedStore.size}`
    );

    // R7 must hold across restarts.
    expectThrow(
        () => restartedService.matchTransaction("pay-persist-2", "tx-persist-1"),
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
// Group 6 — execution gate + explicit denomination mapping
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
