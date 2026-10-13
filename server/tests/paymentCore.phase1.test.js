/**
 * Phase 1 — Room Wallet Payment Core tests (ISOLATED).
 *
 * Covers:
 *   1. Normal flow (wallet reservation, intent creation, credit, settle)
 *   2. Duplicate transactions (one tx id credited to at most one intent)
 *   3. Duplicate reservations / conflicting active reservations
 *   4. Expiration (absolute expiry + the 480s room deadline rule)
 *   5. Restart-safe durable persistence
 *   6. Execution gate (no transfer can be executed in Phase 1)
 *   7. Asset / denomination mapping (explicit, integer-only, fail closed)
 *
 * These tests are fully isolated from gameplay: they never touch Page1/Page4,
 * Player Setup, game navigation, game-stage transitions, or the existing
 * 480-second room timer. No blockchain node is ever contacted.
 */

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { LoggerService } from "../services/LoggerService.js";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    ROOM_LIFETIME_MS,
    ROOM_WALLET_POOL_SIZE,
    AssetDenominationRegistry,
    PaymentIntentStore,
    RoomWalletPaymentService,
    WalletPoolRegistry,
    InvalidPaymentStateTransitionError,
    PaymentExecutionBlockedError,
    PaymentIntentExpiredError,
    TransactionAlreadyCreditedError,
    WalletAssignmentConflictError,
    canTransition
} from "../payment/index.js";

// ---------------------------------------------------------------------------
// Minimal assertion + harness helpers
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

/**
 * Copy the real 64-wallet catalog into an isolated temp dir so the test never
 * depends on, or mutates, the repository config file.
 */
function isolatedCatalogCopy() {

    const workspace = mkdtempSync(join(tmpdir(), "wheelwin-payment-"));

    const configDir = join(workspace, "config");

    mkdirSync(configDir, { recursive: true });

    const source = join(
        process.cwd(),
        "config",
        "room-wallets-testnet-ROOM_WALLETS_JSON.json"
    );

    copyFileSync(source, join(configDir, "wallets.json"));

    return {
        workspace,
        catalogPath: join(configDir, "wallets.json"),
        dataDir: join(workspace, "data")
    };

}

function buildHarness(options = {}) {

    const logger = new LoggerService({ logLevel: "error" });

    logger.initialize();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const env = options.catalogPath
        ? { catalogPath: options.catalogPath, dataDir: options.dataDir }
        : isolatedCatalogCopy();

    const clock = options.clock ?? (() => ROOM_CREATED_AT + 1_000);

    const walletPool = new WalletPoolRegistry({
        logger,
        catalogPath: env.catalogPath,
        network: "testnet"
    });

    const intentStore = new PaymentIntentStore({
        dataDir: env.dataDir,
        logger,
        nowProvider: clock
    });

    const assetRegistry = AssetDenominationRegistry.fromConfiguration({
        // Explicit mapping — NOT hardcoded. `Gram` is never assumed to equal a
        // particular amount of TON; the atomic-unit value comes from config.
        assets: options.assets === undefined
            ? [
                {
                    asset: "TON",
                    symbol: "Gram",
                    network: "testnet",
                    atomicUnitsPerUnit: 1_000_000_000
                }
            ]
            : options.assets
    });

    const service = new RoomWalletPaymentService({
        walletPool,
        intentStore,
        assetRegistry,
        logger,
        snapshotDir: env.dataDir,
        nowProvider: clock
    });

    return {
        logger,
        eventBus,
        env,
        clock,
        walletPool,
        intentStore,
        assetRegistry,
        service
    };

}

const ROOM_CREATED_AT = 1_700_000_000_000;

function createIntent(harness, overrides = {}) {

    return harness.service.createPaymentIntent({
        paymentReference: `pay-${Math.random().toString(36).slice(2, 11)}`,
        roomId: "room-a",
        playerId: "player-1",
        expectedSender: "EQPLAYERWALLET____111",
        amountAtomic: 2_000_000_000,
        asset: "TON",
        network: "testnet",
        roomCreatedAt: ROOM_CREATED_AT,
        now: harness.clock(),
        ...overrides
    });

}

// ---------------------------------------------------------------------------
// Group 1 — wallet pool registry
// ---------------------------------------------------------------------------

{

    const logger = new LoggerService({ logLevel: "error" });

    logger.initialize();

    const env = isolatedCatalogCopy();

    const registry = new WalletPoolRegistry({
        logger,
        catalogPath: env.catalogPath,
        network: "testnet"
    });

    registry.initialize();

    check(
        registry.size === ROOM_WALLET_POOL_SIZE,
        `wallet pool size must be ${ROOM_WALLET_POOL_SIZE}, got ${registry.size}`
    );

    check(
        registry.getAvailableCount() === ROOM_WALLET_POOL_SIZE,
        "all 64 wallets must start available"
    );

    // Wallet secrets must never be surfaced by the registry.
    for (const wallet of registry.listWallets()) {

        check(
            wallet.secretKey === undefined,
            "registry must never expose wallet secret material"
        );

        check(
            wallet.publicKey !== undefined || wallet.publicKey === null,
            "registry wallet record shape"
        );

    }

    // R3 — at most one wallet per active room.
    const first = registry.reserve({ roomId: "room-1" });

    check(
        first.wallet.reservedByRoomId === "room-1",
        "reserved wallet must record the owning room"
    );

    check(
        registry.getReservedCount() === 1,
        "reserved count must be 1 after one reservation"
    );

    const sameRoom = expectThrow(
        () => registry.reserve({ roomId: "room-1" }),
        "WalletAssignmentConflictError",
        "reserving twice for the same room must be rejected"
    );

    check(
        sameRoom.code === "WALLET_ASSIGNMENT_CONFLICT",
        "duplicate-room reservation must use WALLET_ASSIGNMENT_CONFLICT"
    );

    // R8 — the previously reserved wallet cannot be taken by another room.
    const conflict = expectThrow(
        () => registry.reserve({
            roomId: "room-2",
            walletId: first.wallet.walletId
        }),
        "WalletAssignmentConflictError",
        "reserving an already-reserved wallet for another room must be rejected"
    );

    check(
        conflict.code === "WALLET_ASSIGNMENT_CONFLICT",
        "conflicting active reservation must use WALLET_ASSIGNMENT_CONFLICT"
    );

    // R8 — release is blocked while obligations remain.
    const blocked = expectThrow(
        () => registry.release({ roomId: "room-1", unresolvedObligations: 2 }),
        "WalletRecyclingBlockedError",
        "release must be blocked while unresolved obligations remain"
    );

    check(
        blocked.details.unresolvedObligations === 2,
        "blocked release must report the unresolved obligation count"
    );

    check(
        registry.hasReservationForRoom("room-1") === true,
        "blocked release must keep the reservation intact"
    );

    // With no obligations, release succeeds.
    const released = registry.release({ roomId: "room-1", unresolvedObligations: 0 });

    check(
        released.released === true,
        "release must succeed once no obligations remain"
    );

    check(
        registry.getAvailableCount() === ROOM_WALLET_POOL_SIZE,
        "all wallets must be available again after release"
    );

    // The released wallet can now be recycled.
    const recycled = registry.reserve({
        roomId: "room-2",
        walletId: first.wallet.walletId
    });

    check(
        recycled.wallet.walletId === first.wallet.walletId,
        "a released wallet must be recyclable by another room"
    );

    registry.release({ roomId: "room-2" });

    // Exhaustion.
    for (let index = 0; index < ROOM_WALLET_POOL_SIZE; index += 1) {

        registry.reserve({ roomId: `room-x-${index}` });

    }

    const exhausted = expectThrow(
        () => registry.reserve({ roomId: "room-overflow" }),
        "WalletPoolExhaustedError",
        "reservation must fail once all 64 wallets are reserved"
    );

    check(
        exhausted.code === "WALLET_POOL_EXHAUSTED",
        "pool exhaustion must use WALLET_POOL_EXHAUSTED"
    );

    rmSync(env.workspace, { recursive: true, force: true });

    console.log("[1/8] wallet pool registry: PASS");

}

// ---------------------------------------------------------------------------
// Group 2 — room deadline (480s exactly)
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    const deadline = harness.service.getRoomDeadline(ROOM_CREATED_AT);

    check(
        deadline.deadlineMs === ROOM_CREATED_AT + 480_000,
        "room deadline must be exactly roomCreatedAt + 480000"
    );

    check(
        harness.service.roomLifetimeMs === 480_000,
        "room lifetime must remain exactly 480000 ms"
    );

    check(
        deadline.roomLifetimeMs === 480_000,
        "roomLifetimeMs must be 480000"
    );

    // A negative / shifted creation time must still produce an exact 480s span.
    const second = harness.service.getRoomDeadline(ROOM_CREATED_AT + 1_234);

    check(
        second.deadlineMs - second.roomCreatedAt === 480_000,
        "room deadline span must be exactly 480000 ms"
    );

    rmSync(harness.env.workspace, { recursive: true, force: true });

    console.log("[2/8] room deadline (480s): PASS");

}

// ---------------------------------------------------------------------------
// Group 3 — normal flow
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
        intent.destinationWalletId !== null
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
        intent.roomDeadlineMs === ROOM_CREATED_AT + 480_000,
        "payment intent deadline must equal roomCreatedAt + 480000"
    );
    check(intent.state === "PENDING", "new payment intent must start PENDING");
    check(
        intent.hasOpenObligation() === true,
        "a PENDING payment intent must leave an open obligation"
    );

    // R3 — exactly one wallet per room.
    const wallet = harness.service.getWalletForRoom("room-a");

    check(
        wallet !== null && wallet.walletId === intent.destinationWalletId,
        "the room's assigned wallet must equal the intent destination wallet"
    );

    // Retrieval by unique reference.
    const fetched = harness.service.getPaymentIntent("pay-normal-1");

    check(
        fetched.paymentReference === "pay-normal-1",
        "payment intents must be retrievable by their unique payment reference"
    );

    // A second player in the same room reuses the room's wallet.
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

    // Credit (R7) and settle.
    const matched = harness.service.matchTransaction(
        "pay-normal-1",
        "tx-0001"
    );

    check(matched.state === "MATCHED", "credited intent must be MATCHED");
    check(
        matched.transactionId === "tx-0001",
        "the credited transaction id must be recorded"
    );
    check(
        matched.hasOpenObligation() === true,
        "a MATCHED intent must still leave an open obligation"
    );

    const settled = harness.service.settlePayment("pay-normal-1");

    check(settled.state === "SETTLED", "matched intent must be settleable");
    check(
        settled.hasOpenObligation() === false,
        "a SETTLED intent must leave no open obligation"
    );

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

    // R8 — release is permitted only once the room's obligations resolve.
    const stillOpen = expectThrow(
        () => harness.service.releaseWalletForRoom("room-a"),
        "WalletRecyclingBlockedError",
        "release must be blocked while another player's intent is PENDING"
    );

    check(
        stillOpen.details.unresolvedObligations === 1,
        "release must report the remaining open obligation (pay-normal-2)"
    );

    harness.service.expirePaymentIntent("pay-normal-2", ROOM_CREATED_AT + 480_001);

    const obligationCount = harness.service.countOpenObligations("room-a");

    check(
        obligationCount === 0,
        `room obligations must resolve after expiry, got ${obligationCount}`
    );

    const releaseResult = harness.service.releaseWalletForRoom("room-a");

    check(
        releaseResult.released === true,
        "release must succeed once all obligations are resolved"
    );

    rmSync(harness.env.workspace, { recursive: true, force: true });

    console.log("[3/8] normal flow: PASS");

}

// ---------------------------------------------------------------------------
// Group 4 — duplicate transactions (R7)
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
    const matchedA = harness.service.matchTransaction("pay-tx-A", "tx-shared-1");

    check(matchedA.state === "MATCHED", "first credit must succeed");

    // The same transaction cannot be credited to a second intent.
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

    // The ledger must expose the exact credit ownership.
    const credited = harness.service.listCreditedTransactions();

    check(
        credited.length === 1 && credited[0].paymentReference === "pay-tx-A",
        "exactly one transaction must be credited in the ledger"
    );

    check(
        harness.intentStore.findByTransactionId("tx-shared-1")?.paymentReference
            === "pay-tx-A",
        "transaction lookup must resolve to the credited payment reference"
    );

    rmSync(harness.env.workspace, { recursive: true, force: true });

    console.log("[4/8] duplicate transactions (idempotency): PASS");

}

// ---------------------------------------------------------------------------
// Group 5 — duplicate reservations / conflicting active reservations
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

    // Creating a payment intent for a room that already holds a reservation
    // must reuse it, not reserve a second wallet.
    const intent = createIntent(harness, {
        paymentReference: "pay-dup-1",
        roomId: "room-dup"
    });

    check(
        intent.destinationWalletId === wallet.walletId,
        "intent creation must reuse the room's existing wallet reservation"
    );

    expectThrow(
        () => createIntent(harness, {
            paymentReference: "pay-dup-1",
            roomId: "room-dup"
        }),
        "PaymentReferenceCollisionError",
        "a duplicate payment reference must be rejected"
    );

    rmSync(harness.env.workspace, { recursive: true, force: true });

    console.log("[5/8] duplicate reservations: PASS");

}

// ---------------------------------------------------------------------------
// Group 6 — expiration
// ---------------------------------------------------------------------------

{

    let clockNow = ROOM_CREATED_AT + 1_000;

    const harness = buildHarness({ clock: () => clockNow });

    harness.service.initialize();

    createIntent(harness, {
        paymentReference: "pay-exp-1",
        roomId: "room-exp",
        playerId: "player-1",
        expectedSender: "EQSENDER____111",
        amountAtomic: 2_000_000_000
    });

    // Bulk sweep behavior. Created while the room is still inside its 480s
    // lifetime, then the clock advances past the deadline.
    createIntent(harness, {
        paymentReference: "pay-exp-2",
        roomId: "room-exp-2",
        playerId: "player-2",
        expectedSender: "EQSENDER____222",
        amountAtomic: 1_000_000_000
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

    // A credit after expiration must be refused.
    const afterDeadline = ROOM_CREATED_AT + 480_001;

    clockNow = afterDeadline;

    expectThrow(
        () => harness.service.matchTransaction("pay-exp-1", "tx-late"),
        "PaymentIntentExpiredError",
        "crediting an expired payment intent must be refused"
    );

    // The refused late credit must not have been recorded anywhere.
    check(
        harness.service.hasPaymentIntent("pay-exp-1") === true,
        "the expired intent must still exist"
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

    check(
        expired.state === "EXPIRED",
        "intent must be EXPIRED at its deadline"
    );

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
            now: ROOM_CREATED_AT + 480_001
        }),
        "PaymentIntentExpiredError",
        "creating a payment intent after the room deadline must be refused"
    );

    const swept = harness.service.sweepExpiredPaymentIntents(afterDeadline);

    check(
        swept.expired === 1
            && swept.expiredReferences.includes("pay-exp-2"),
        "sweep must expire every intent past its absolute deadline"
    );

    // The room deadline stays at exactly +480000 ms regardless of clock skew.
    const deadline = harness.service.getRoomDeadline(ROOM_CREATED_AT);

    check(
        deadline.deadlineMs === ROOM_CREATED_AT + 480_000,
        "room deadline must remain exactly roomCreatedAt + 480000 ms"
    );

    rmSync(harness.env.workspace, { recursive: true, force: true });

    console.log("[6/8] expiration: PASS");

}

// ---------------------------------------------------------------------------
// Group 7 — execution gate + denomination mapping
// ---------------------------------------------------------------------------

{

    // 7a. Phase 1 can never execute a transfer, with or without config.
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

    check(
        capabilities.transfersEnabled === false,
        "transfer capability must be explicitly disabled"
    );

    check(
        capabilities.smartContractsEnabled === false,
        "smart-contract capability must be explicitly disabled"
    );

    check(
        capabilities.realPaymentCollectionEnabled === false,
        "real payment collection must be explicitly disabled"
    );

    check(
        capabilities.walletPoolSize === 64,
        "capability descriptor must report the 64-wallet pool"
    );

    // No blockchain / contract API is reachable from this module.
    const moduleSurface = Object.keys(await import("../payment/index.js"));

    for (const forbidden of ["sendTransaction", "broadcast", "deploy", "GameEscrow"]) {

        check(
            moduleSurface.includes(forbidden) === false,
            `module surface must not expose ${forbidden}`
        );

    }

    // 7b. Without the mapping, payment execution must be refused.
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

    // 7c. An amount that is not an exact integer multiple is rejected.
    expectThrow(
        () => createIntent(configured, {
            paymentReference: "pay-fractional",
            roomId: "room-f",
            amountAtomic: 1_500_000_000
        }),
        "PaymentValidationError",
        "non-multiple atomic amounts must be rejected (integer-only)"
    );

    expectThrow(
        () => createIntent(configured, {
            paymentReference: "pay-float",
            roomId: "room-g",
            amountAtomic: 1.5
        }),
        "PaymentValidationError",
        "floating-point amounts must be rejected"
    );

    rmSync(configured.env.workspace, { recursive: true, force: true });
    rmSync(unconfigured.env.workspace, { recursive: true, force: true });

    console.log("[7/8] execution gate + denomination mapping: PASS");

}

// ---------------------------------------------------------------------------
// Group 8 — restart-safe durable persistence
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

    const pWalletBeforeRestart = harness.service.getWalletForRoom("room-p");

    check(
        qWalletBeforeRestart !== null,
        "room-q must hold a wallet reservation before the restart"
    );

    harness.service.shutdown();

    // --- simulate a full restart against the SAME durable data directory -----
    const restartedWalletPool = new WalletPoolRegistry({
        logger: harness.logger,
        catalogPath: harness.env.catalogPath,
        network: "testnet"
    });

    const restartedStore = new PaymentIntentStore({
        dataDir: harness.env.dataDir,
        logger: harness.logger
    });

    const restartedService = new RoomWalletPaymentService({
        walletPool: restartedWalletPool,
        intentStore: restartedStore,
        assetRegistry: AssetDenominationRegistry.fromConfiguration({
            assets: [
                {
                    asset: "TON",
                    symbol: "Gram",
                    network: "testnet",
                    atomicUnitsPerUnit: 1_000_000_000
                }
            ]
        }),
        logger: harness.logger,
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
        restored.amountAtomic === 4_000_000_000,
        "the exact integer atomic amount must survive a restart"
    );

    check(
        restored.roomDeadlineMs === ROOM_CREATED_AT + 480_000,
        "the immutable room deadline must survive a restart"
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

    // R8 must hold across restarts: room-p is settled (its wallet is released),
    // room-q is still PENDING and must still block recycling its wallet.
    check(
        restartedService.countOpenObligations("room-p") === 0,
        "settled intents must leave no obligation after a restart"
    );

    check(
        restartedService.countOpenObligations("room-q") === 1,
        "a PENDING intent must still block wallet recycling after a restart"
    );

    check(
        restartedService.getWalletForRoom("room-p") === null,
        "a settled room's wallet must be released (recyclable) after a restart"
    );

    expectThrow(
        () => restartedService.releaseWalletForRoom("room-q"),
        "WalletRecyclingBlockedError",
        "an unresolved obligation must still block release after a restart"
    );

    const walletQ = restartedService.getWalletForRoom("room-q");

    check(
        walletQ !== null && walletQ.walletId === qWalletBeforeRestart.walletId,
        "an unresolved wallet reservation must survive a restart unchanged"
    );

    // The released room-p wallet must now be recyclable by a different room.
    const recycled = restartedService.reserveWalletForRoom({
        roomId: "room-recycled",
        walletId: pWalletBeforeRestart.walletId
    });

    check(
        recycled.walletId === pWalletBeforeRestart.walletId,
        "a freed wallet must be recyclable by another room after a restart"
    );

    // The still-owed room-q wallet must never be recyclable.
    expectThrow(
        () => restartedService.reserveWalletForRoom({
            roomId: "room-conflicting",
            walletId: walletQ.walletId
        }),
        "WalletAssignmentConflictError",
        "a wallet with unresolved obligations must not be recycled after a restart"
    );

    restartedService.shutdown();

    rmSync(harness.env.workspace, { recursive: true, force: true });

    console.log("[8/8] restart-safe durable persistence: PASS");

}

console.log(
    `\nAll payment-core tests passed | assertions=${checksPassed}`
        + ` | roomLifetimeMs=${ROOM_LIFETIME_MS}`
        + ` | walletPoolSize=${ROOM_WALLET_POOL_SIZE}`
        + ` | transfersEnabled=false`
);

export { checksPassed };
