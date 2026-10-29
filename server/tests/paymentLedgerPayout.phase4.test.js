/** Synthetic isolated ledger regression checks: exact amounts, 95/4.9/reserve,
 * durable obligations, verified incoming authority and no execution in ledger. */

import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    NANOTONS_PER_TON,
    CANONICAL_TON_ASSET,
    GRAM_DISPLAY_SYMBOL,
    BASE_STAKE_LABELS,
    LEDGER_ENTRY_KIND,
    LEDGER_CAPABILITIES,
    LEDGER_FORBIDDEN_OPERATIONS,
    CurrencyMapping,
    PayoutAllocationConfig,
    RoomPayoutCalculator,
    LedgerStore,
    RoomLedger,
    INCOMING_PRINCIPAL_CONFIRMATION_SOURCE
} from "../payment/ledger/index.js";

import { PaymentIntent } from "../payment/PaymentIntent.js";
import { PaymentIntentStore } from "../payment/PaymentIntentStore.js";
import { PAYMENT_INTENT_STATE } from "../payment/PaymentIntentStatus.js";

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

function equal(actual, expected, message) {

    assert(
        actual === expected,
        `${message} (expected ${expected}, got ${actual})`
    );

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

    checksPassed += 1;

    return thrown;

}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

const NETWORK = "testnet";

const ONE_GRAM = 1_000_000_000;      // 1 Gram = 1 TON
const TEN_GRAM = 10_000_000_000;     // 10 Gram = 10 TON

// Three players stake 10 TON each -> 30 TON of confirmed settled principal.
const PLAYER_STAKE = TEN_GRAM;
const PLAYER_COUNT = 3;
const PRINCIPAL = PLAYER_STAKE * PLAYER_COUNT; // 30_000_000_000

const WINNER_FEE = 5_000_000;
const OWNER_FEE = 1_000_000;

/**
 * The APPROVED payout rule under test: the winner's gross allocation is an
 * explicit authoritative atomic amount, and the owner's gross allocation is
 * the exact residual. There is no percentage of any kind and no reserve.
 */
function allocFor({ winnerGrossAllocationAtomic, allocationSource = null } = {}) {

    return { winnerGrossAllocationAtomic, allocationSource };

}

// Authoritative winner gross allocation: 28.5 TON of the 30 TON principal.
// The owner residual is then exactly 1.5 TON by subtraction, never by
// percentage.
const WINNER_ALLOCATION = 28_500_000_000;

function standardAllocation() {

    return allocFor({ winnerGrossAllocationAtomic: WINNER_ALLOCATION });

}

function isolatedWorkspace() {

    return mkdtempSync(join(tmpdir(), "wheelwin-ledger-p4-"));

}

/**
 * An authoritative, durable payment intent store in an isolated temporary
 * directory. It is the ONLY thing that can prove a settled payment.
 */
function makeIntentStore({ dataDir = isolatedWorkspace(), clock = () => NOW } = {}) {

    const intentStore = new PaymentIntentStore({ dataDir, nowProvider: clock });

    intentStore.initialize();

    return intentStore;

}

function makeLedger({
    dataDir = isolatedWorkspace(),
    clock = () => NOW,
    intentStore = null
} = {}) {

    const store = new LedgerStore({ dataDir, nowProvider: clock });

    const currency = CurrencyMapping.nativeTon({ network: NETWORK });

    // The authoritative Phase-1 payment intent store is an EXPLICIT dependency:
    // without it no payment intent can ever be resolved as settled, so no
    // principal could ever be confirmed.
    const authoritativeIntents = intentStore ?? makeIntentStore({ dataDir, clock });

    const ledger = new RoomLedger({
        store,
        currency,
        intentStore: authoritativeIntents
    });

    ledger.initialize();

    return {
        dataDir,
        store,
        currency,
        ledger,
        nowProvider: clock,
        intentStore: authoritativeIntents
    };

}

function feeQuotes({ winnerFee = WINNER_FEE, ownerFee = OWNER_FEE, quotedAtMs = NOW } = {}) {

    return {
        winner: { feeAtomic: winnerFee, quotedAtMs },
        owner: { feeAtomic: ownerFee, quotedAtMs }
    };

}

// Synthetic payment-intent lifecycle constants (no real timings, no deadlines
// derived from any repository configuration).
const INTENT_CREATED_AT = NOW;
const INTENT_EXPIRES_AT = NOW + 240_000;
const INTENT_ROOM_DEADLINE_MS = NOW + 480_000;

/**
 * Persist a synthetic payment intent through the AUTHORITATIVE intent store.
 * Every wallet identifier below is a synthetic fixture string — no wallet
 * catalog, address book or secret file is ever read.
 *
 * @param {{ intentStore: PaymentIntentStore, paymentReference: string,
 *   roomId: string, playerId: string, amountAtomic?: number,
 *   transactionId?: string|null, network?: string, asset?: string,
 *   state?: string }} request
 * @returns {PaymentIntent}
 */
function createIntent({
    intentStore,
    paymentReference,
    roomId,
    playerId,
    amountAtomic = TEN_GRAM,
    transactionId = null,
    network = NETWORK,
    asset = CANONICAL_TON_ASSET,
    state = PAYMENT_INTENT_STATE.PENDING
}) {

    const intent = new PaymentIntent({
        paymentReference,
        roomId,
        playerId,
        network,
        destinationWalletId: `synthetic-wallet-${roomId}`,
        destinationWalletAddress: `synthetic-destination-${roomId}`,
        expectedSender: `synthetic-sender-${playerId}`,
        amountAtomic,
        asset,
        createdAt: INTENT_CREATED_AT,
        expiresAt: INTENT_EXPIRES_AT,
        roomDeadlineMs: INTENT_ROOM_DEADLINE_MS,
        state,
        transactionId
    });

    return intentStore.save(intent);

}

/**
 * Drive a persisted synthetic intent through the authoritative lifecycle
 * PENDING -> MATCHED -> SETTLED (never invented: every transition goes through
 * the validated `PaymentIntent.transition()` table and is persisted).
 *
 * @returns {PaymentIntent} the persisted SETTLED intent
 */
function createSettledIntent({
    intentStore,
    paymentReference,
    roomId,
    playerId,
    amountAtomic = TEN_GRAM,
    transactionId,
    network = NETWORK,
    asset = CANONICAL_TON_ASSET
}) {

    const pending = createIntent({
        intentStore, paymentReference, roomId, playerId, amountAtomic, network, asset
    });

    const matched = pending.transition(PAYMENT_INTENT_STATE.MATCHED, {
        transactionId,
        now: NOW
    });

    intentStore.update(matched);

    const settled = matched.transition(PAYMENT_INTENT_STATE.SETTLED, { now: NOW });

    return intentStore.update(settled);

}

/**
 * Persist a synthetic intent stopped at MATCHED (an observed transaction id is
 * still NOT a settled payment).
 *
 * @returns {PaymentIntent} the persisted MATCHED intent
 */
function createMatchedIntent({
    intentStore,
    paymentReference,
    roomId,
    playerId,
    amountAtomic = TEN_GRAM,
    transactionId,
    network = NETWORK,
    asset = CANONICAL_TON_ASSET
}) {

    const pending = createIntent({
        intentStore, paymentReference, roomId, playerId, amountAtomic, network, asset
    });

    const matched = pending.transition(PAYMENT_INTENT_STATE.MATCHED, {
        transactionId,
        now: NOW
    });

    return intentStore.update(matched);

}

function seedConfirmedRoom(ledger, roomId, intentStoreArg) {

    for (let index = 0; index < PLAYER_COUNT; index += 1) {

        const playerId = `player-${index + 1}`;

        const paymentReference = `pay-${roomId}-${playerId}`;
        const transactionId = `tx-${roomId}-${playerId}`;

        ledger.recordPlayerStake({
            idempotencyKey: `stake:${roomId}:${playerId}:base`,
            roomId,
            playerId,
            stakeLabel: "10 Gram"
        });

        // Authoritative SETTLED payment intent for exactly this player, room,
        // amount, network and asset.
        createSettledIntent({
            intentStore: intentStoreArg,
            paymentReference,
            roomId,
            playerId,
            amountAtomic: PLAYER_STAKE,
            transactionId
        });

        ledger.recordIncomingPrincipal({
            idempotencyKey: `principal:${roomId}:${playerId}:tx`,
            roomId,
            playerId,
            amountAtomic: PLAYER_STAKE,
            confirmation: {
                paymentReference,
                transactionId,
                source: INCOMING_PRINCIPAL_CONFIRMATION_SOURCE
            }
        });

    }

}

const WINNER = { recipientId: "player-1", address: "EQWINNER____________" };
const OWNER = { recipientId: "owner-collector", address: "EQOWNER_____________" };

// ---------------------------------------------------------------------------
// G1 — currency mapping: Gram <-> nanoton, exact integers only
// ---------------------------------------------------------------------------

{

    const currency = CurrencyMapping.nativeTon({ network: NETWORK });

    check(
        currency.asset === CANONICAL_TON_ASSET && currency.asset === "TON",
        "canonical asset identifier must be TON"
    );

    check(
        currency.symbol === GRAM_DISPLAY_SYMBOL && currency.symbol === "Gram",
        "display denomination must be the Gram symbol (separate from the asset)"
    );

    check(
        currency.atomicUnitsPerUnit === NANOTONS_PER_TON
            && NANOTONS_PER_TON === 1_000_000_000,
        "atomicUnitsPerUnit must be exactly 1_000_000_000"
    );

    // 1 Gram = 1 TON = 1_000_000_000 nanotons (EXACT).
    equal(currency.toAtomicUnits(1), 1_000_000_000, "1 Gram must equal 1_000_000_000 nanotons");

    // 10 Gram = 10_000_000_000 nanotons (EXACT).
    equal(currency.toAtomicUnits(10), 10_000_000_000, "10 Gram must equal 10_000_000_000 nanotons");

    // Round trip is exact for multiples of the denomination.
    equal(currency.toDisplayUnits(1_000_000_000), 1, "nanoton -> display round trip (1 Gram)");
    equal(currency.toDisplayUnits(10_000_000_000), 10, "nanoton -> display round trip (10 Gram)");

    // Named player-facing stake tiers resolve to the exact atomic amounts.
    equal(currency.resolveStakeTier("1 Gram").atomicUnits, ONE_GRAM, "1 Gram tier -> 1_000_000_000");
    equal(currency.resolveStakeTier("10 Gram").atomicUnits, TEN_GRAM, "10 Gram tier -> 10_000_000_000");
    equal(BASE_STAKE_LABELS.length, 2, "exactly two base stake labels");

    // No floating point: fractional display units are rejected.
    expectThrow(
        () => currency.toAtomicUnits(1.5),
        "LedgerEntryError",
        "fractional display units must be rejected (integer only)"
    );

    // A non-multiple atomic amount is not an exact display unit.
    expectThrow(
        () => currency.toDisplayUnits(1_500_000_000),
        "LedgerEntryError",
        "atomic amount that is not an exact multiple must be rejected"
    );

    // Unknown stake labels resolve to null and never invent an amount.
    check(currency.resolveStakeTier("100 Gram") === null, "unknown stake label must resolve to null");

    expectThrow(
        () => currency.requireStakeTierAtomic("100 Gram"),
        "LedgerEntryError",
        "an unknown stake label must fail closed rather than invent an amount"
    );

    // A nativeTon mapping without a network fails closed.
    expectThrow(
        () => CurrencyMapping.nativeTon({}),
        "LedgerEntryError",
        "nativeTon requires an explicit network"
    );

    console.log("[1/14] currency mapping (Gram <-> nanoton): PASS");

}

// ---------------------------------------------------------------------------
// G2 — player stake + sector amount accounting
// ---------------------------------------------------------------------------

{

    const { dataDir, ledger } = makeLedger();

    const roomId = "room-acct";

    // Attribute stakes by label (server resolves to exact atomic units).
    ledger.recordPlayerStake({ idempotencyKey: "s:a:1", roomId, playerId: "p1", stakeLabel: "10 Gram" });
    ledger.recordPlayerStake({ idempotencyKey: "s:a:2", roomId, playerId: "p2", stakeLabel: "1 Gram" });
    ledger.recordPlayerStake({ idempotencyKey: "s:a:3", roomId, playerId: "p1", stakeLabel: "1 Gram" });

    // Sector purchases are individually attributable, with an EXPLICIT amount.
    ledger.recordSectorPurchase({ idempotencyKey: "sp:a:1", roomId, playerId: "p1", amountAtomic: ONE_GRAM, sectorId: "sector_0" });
    ledger.recordSectorPurchase({ idempotencyKey: "sp:a:2", roomId, playerId: "p2", amountAtomic: ONE_GRAM, sectorId: "sector_1" });

    equal(ledger.getPlayerStakeAtomic(roomId, "p1"), TEN_GRAM + ONE_GRAM, "p1 stake must be 10 Gram + 1 Gram");
    equal(ledger.getPlayerStakeAtomic(roomId, "p2"), ONE_GRAM, "p2 stake must be 1 Gram");
    equal(ledger.getTotalStakesAtomic(roomId), TEN_GRAM + ONE_GRAM + ONE_GRAM, "total stakes must be 10+1+1 Gram");

    const view = ledger.getRoomLedgerView(roomId);

    equal(
        view.totalSectorPurchasesAtomic,
        ONE_GRAM + ONE_GRAM,
        "total sector purchases must be 2 Gram"
    );

    check(view.asset === "TON", "ledger view must report the canonical asset TON");

    // A label that contradicts an explicit amount is rejected (never invented).
    expectThrow(
        () => ledger.recordPlayerStake({
            idempotencyKey: "s:a:contra", roomId, playerId: "p3",
            stakeLabel: "10 Gram", amountAtomic: ONE_GRAM
        }),
        "LedgerEntryError",
        "a contradictory stake label + amount must be rejected"
    );

    // A stake with neither a known label nor an amount is rejected.
    expectThrow(
        () => ledger.recordPlayerStake({ idempotencyKey: "s:a:none", roomId, playerId: "p3" }),
        "LedgerEntryError",
        "a stake with no label and no amount must be rejected"
    );

    // Sector purchase requires a positive integer amount.
    expectThrow(
        () => ledger.recordSectorPurchase({ idempotencyKey: "sp:a:bad", roomId, playerId: "p1", amountAtomic: 0 }),
        "LedgerEntryError",
        "a sector purchase amount must be a positive integer"
    );

    rmSync(dataDir, { recursive: true, force: true });

    console.log("[2/14] player stake + sector accounting: PASS");

}

// ---------------------------------------------------------------------------
// G3–G7 — fixed shares, source gas, optional diagnostic quotes.
{
 const planFor=(options={})=>RoomPayoutCalculator.computePlan({payoutId:'policy',roomId:'r',
  asset:'TON',network:NETWORK,principalAtomic:PRINCIPAL,winner:WINNER,owner:OWNER,nowMs:NOW,...options});
 const p=planFor();
 equal(p.transferFor('WINNER').netAtomic,28_500_000_000,'winner receives full 95%');
 equal(p.transferFor('OWNER').netAtomic,1_470_000_000,'owner receives full 4.9%');
 equal(p.gasReserveAtomic,30_000_000,'source reserve allocation is 0.1%');
 equal(p.totalReservedFeeAtomic,0,'recipient amounts have no fee deductions');
 check(p.reconcile(),'shares plus reserve exactly equal principal');
 for(const fee of [undefined,null,NaN,-1,1.5,0,1,PRINCIPAL*2]) {
  const quoted=planFor({networkFees:{winner:{feeAtomic:fee,quotedAtMs:1},owner:{feeAtomic:fee,quotedAtMs:1}},maxQuoteAgeMs:1});
  equal(quoted.transferFor('WINNER').netAtomic,p.transferFor('WINNER').netAtomic,'quotes never gate or reduce winner');
  equal(quoted.transferFor('OWNER').netAtomic,p.transferFor('OWNER').netAtomic,'quotes never reduce owner');
 }
 const override=planFor({safetyMarginAtomic:PRINCIPAL,allocation:{winnerGrossAllocationAtomic:1,numerator:1}});
 equal(override.transferFor('WINNER').netAtomic,28_500_000_000,'caller cannot override winner allocation');
 equal(override.transferFor('OWNER').netAtomic,1_470_000_000,'caller cannot override owner allocation');
 for(const value of [0,-1,1.5,NaN,Number.MAX_SAFE_INTEGER+1]) {
  expectThrow(()=>planFor({principalAtomic:value}),'PayoutValidationError','invalid principal rejected');
 }
 console.log('[3–7/14] fixed allocations and source-paid network costs: PASS');
}

// ---------------------------------------------------------------------------
// G8 — duplicate ledger entry + replay protection
// ---------------------------------------------------------------------------

{

    const { dataDir, store, ledger, intentStore } = makeLedger();

    const roomId = "room-replay";

    // First append books the key.
    const first = ledger.recordPlayerStake({
        idempotencyKey: "stake:dup:1",
        roomId,
        playerId: "p1",
        stakeLabel: "1 Gram",
        paymentReference: "payment-ref-dup-1"
    });

    check(first.replay === false, "first booking must append a new entry");

    // Replaying the SAME key is an idempotent no-op — never booked twice.
    const replay = ledger.recordPlayerStake({
        idempotencyKey: "stake:dup:1",
        roomId,
        playerId: "p1",
        stakeLabel: "1 Gram",
        paymentReference: "payment-ref-dup-1"
    });

    check(replay.replay === true, "replaying a booked idempotency key must be a replay");
    check(replay.entry.entryId === first.entry.entryId, "a replay must return the same immutable entry id");
    equal(store.size, 1, "a replay must not add a second entry");

    // The durable payment reference remains authoritative when a caller changes
    // its idempotency key: return the persisted stake and do not append again.
    const referenceReplay = ledger.recordPlayerStake({
        idempotencyKey: "stake:dup:different-key",
        roomId,
        playerId: "p1",
        stakeLabel: "1 Gram",
        paymentReference: "payment-ref-dup-1"
    });
    check(referenceReplay.replay === true, "same payment reference with another key must be a replay");
    equal(referenceReplay.entry.entryId, first.entry.entryId, "payment-reference replay must return the original persisted entry");
    equal(store.size, 1, "payment-reference replay must not append a duplicate stake");

    for (const [suffix, conflictingFields] of [
        ["player", { playerId: "different-player" }],
        ["room", { roomId: "different-room" }],
        ["amount", { stakeLabel: undefined, amountAtomic: 2_000_000_000 }]
    ]) {
        expectThrow(
            () => ledger.recordPlayerStake({
                idempotencyKey: `stake:dup:conflict:${suffix}`,
                roomId,
                playerId: "p1",
                stakeLabel: "1 Gram",
                ...conflictingFields,
                paymentReference: "payment-ref-dup-1"
            }),
            "LedgerEntryError",
            `same payment reference with conflicting ${suffix} must fail closed`
        );
    }
    equal(store.size, 1, "conflicting payment-reference reuse must not write a ledger entry");

    for (const [suffix, currency] of [
        ["asset", new CurrencyMapping({ asset: "USDT", symbol: "USDT", network: NETWORK })],
        ["network", new CurrencyMapping({ asset: "TON", symbol: "Gram", network: "mainnet" })]
    ]) {
        const mismatchedLedger = new RoomLedger({ store, currency, intentStore });
        mismatchedLedger.initialize();
        expectThrow(
            () => mismatchedLedger.recordPlayerStake({
                idempotencyKey: `stake:dup:conflict:${suffix}`,
                roomId,
                playerId: "p1",
                stakeLabel: "1 Gram",
                paymentReference: "payment-ref-dup-1"
            }),
            "LedgerEntryError",
            `same payment reference with conflicting ${suffix} must fail closed`
        );
    }
    equal(store.size, 1, "asset or network conflicts must not write ledger entries");

    const distinctReference = ledger.recordPlayerStake({
        idempotencyKey: "stake:dup:distinct-reference",
        roomId,
        playerId: "p1",
        stakeLabel: "1 Gram",
        paymentReference: "payment-ref-dup-2"
    });
    check(distinctReference.replay === false, "a different payment reference must append a distinct stake");
    check(distinctReference.entry.entryId !== first.entry.entryId, "distinct payment references must have distinct ledger entry identifiers");
    equal(store.size, 2, "different payment references must create separate ledger entries");

    // On-disk overwrite protection: a hand-crafted second entry file claiming
    // the SAME idempotency key with a DIFFERENT entry id is rejected on load.
    const conflicting = {
        ...first.entry.toRecord(),
        entryId: "ledg_overwrite_probe_0001",
        sequence: 9_999
    };

    const { atomicWriteJson } = await import("../payment/ledger/LedgerStore.js");

    atomicWriteJson(join(store.entriesDir, `${conflicting.entryId}.json`), conflicting);

    const reload = new LedgerStore({ dataDir });

    expectThrow(
        () => reload.initialize(),
        "LedgerReplayError",
        "two persisted entries booking the same idempotency key must be rejected on load"
    );

    // Clean up the probe so the workspace can be removed deterministically.
    rmSync(join(store.entriesDir, `${conflicting.entryId}.json`), { force: true });

    rmSync(dataDir, { recursive: true, force: true });

    console.log("[8/14] duplicate ledger entry + replay protection: PASS");

}

// ---------------------------------------------------------------------------
// G9 — restart-safe ledger persistence
// ---------------------------------------------------------------------------

{

    const dataDir = isolatedWorkspace();

    // --- first run ----------------------------------------------------------
    const first = makeLedger({ dataDir });

    seedConfirmedRoom(first.ledger, "room-restart", first.intentStore);

    first.ledger.planPayout({
        payoutId: "pay-restart", roomId: "room-restart",
        winner: WINNER, owner: OWNER,
        allocation: standardAllocation(),
        networkFees: feeQuotes(),
        nowMs: NOW
    });

    // Settle only the winner; the owner obligation keeps the wallet blocked.
    first.ledger.settlePayout({
        payoutId: "pay-restart", recipientId: WINNER.recipientId,
        executionResult: { transactionId: "tx-win-restart", actualFeeAtomic: WINNER_FEE, settledAtMs: NOW }
    });

    equal(
        first.ledger.getConfirmedPrincipalAtomic("room-restart"),
        PRINCIPAL,
        "confirmed principal must be the sum of confirmed incoming amounts"
    );

    equal(
        first.ledger.countOpenObligations("room-restart"),
        1,
        "the unsettled owner obligation must keep one obligation open"
    );

    // --- simulate a full restart against the SAME data directory -----------
    const restarted = makeLedger({ dataDir });

    equal(
        restarted.ledger.getTotalSettledPrincipalAtomic("room-restart"),
        PRINCIPAL,
        "the total settled principal must survive a restart"
    );

    equal(
        restarted.ledger.getConfirmedPrincipalAtomic("room-restart"),
        PRINCIPAL,
        "confirmed principal must survive a restart"
    );

    equal(
        restarted.ledger.getTotalStakesAtomic("room-restart"),
        PLAYER_STAKE * PLAYER_COUNT,
        "attributable stakes must survive a restart"
    );

    equal(
        restarted.ledger.countOpenObligations("room-restart"),
        1,
        "the open obligation must survive a restart"
    );

    check(
        restarted.ledger.canRecycleWallet("room-restart") === false,
        "a wallet with an open obligation must not be recyclable after a restart"
    );

    // Replaying planPayout after a restart is idempotent (no double booking).
    const replayedPlan = restarted.ledger.planPayout({
        payoutId: "pay-restart", roomId: "room-restart",
        winner: WINNER, owner: OWNER,
        allocation: standardAllocation(),
        networkFees: feeQuotes(),
        nowMs: NOW
    });

    check(replayedPlan.replay === true, "re-planning the same payout after a restart must be a replay");
    check(
        replayedPlan.plan.transfers.length === 2,
        "a replayed plan must still carry both payout transfers"
    );

    equal(
        restarted.ledger.countOpenObligations("room-restart"),
        1,
        "a replayed plan must not change the obligation count"
    );

    // Replay-protected stake key is still guarded after a restart.
    const replayedStake = restarted.ledger.recordPlayerStake({
        idempotencyKey: "stake:room-restart:player-1:base", roomId: "room-restart",
        playerId: "player-1", stakeLabel: "10 Gram"
    });

    check(replayedStake.replay === true, "a stake idempotency key must remain guarded after a restart");

    // Settle the remaining owner obligation after the restart; then the wallet
    // may be recycled.
    restarted.ledger.settlePayout({
        payoutId: "pay-restart", recipientId: OWNER.recipientId,
        executionResult: { transactionId: "tx-owner-restart", actualFeeAtomic: OWNER_FEE, settledAtMs: NOW }
    });

    check(
        restarted.ledger.canRecycleWallet("room-restart") === true,
        "a wallet may be recycled once all payouts are settled (even after a restart)"
    );

    rmSync(dataDir, { recursive: true, force: true });

    console.log("[9/14] restart-safe ledger persistence: PASS");

}

// ---------------------------------------------------------------------------
// G10 — settlement requires an execution result; idempotent fee reconciliation
// ---------------------------------------------------------------------------

{

    const { dataDir, ledger, intentStore } = makeLedger();

    seedConfirmedRoom(ledger, "room-settle", intentStore);

    const planned = ledger.planPayout({
        payoutId: "pay-settle", roomId: "room-settle",
        winner: WINNER, owner: OWNER,
        allocation: standardAllocation(),
        networkFees: feeQuotes(),
        nowMs: NOW
    });

    // Inability to settle a payout WITHOUT an execution result.
    const noResult = expectThrow(
        () => ledger.settlePayout({
            payoutId: "pay-settle", recipientId: WINNER.recipientId,
            executionResult: null
        }),
        "PayoutSettlementError",
        "a payout cannot be settled without an execution result"
    );

    check(noResult.code === "PAYOUT_SETTLEMENT_BLOCKED", "settlement-without-result must use PAYOUT_SETTLEMENT_BLOCKED");

    // The blocked settle must not have resolved the obligation.
    equal(
        ledger.countOpenObligations("room-settle"),
        2,
        "a blocked settle must leave the obligation unresolved"
    );

    // An execution result missing the transaction id is also rejected.
    expectThrow(
        () => ledger.settlePayout({
            payoutId: "pay-settle", recipientId: WINNER.recipientId,
            executionResult: { actualFeeAtomic: WINNER_FEE }
        }),
        "PayoutSettlementError",
        "an execution result without a transaction id must be rejected"
    );

    // A negative actual fee is rejected independently.
    expectThrow(
        () => ledger.settlePayout({
            payoutId: "pay-settle", recipientId: WINNER.recipientId,
            executionResult: { transactionId: "tx-x", actualFeeAtomic: -1 }
        }),
        "PayoutSettlementError",
        "a negative actual network fee must be rejected"
    );

    // Settle with a fee that DIFFERS from the reservation -> explicit,
    // idempotent reconciliation. The variance is recorded for accounting and is
    // never charged to the OTHER recipient.
    const settled = ledger.settlePayout({
        payoutId: "pay-settle", recipientId: WINNER.recipientId,
        executionResult: { transactionId: "tx-settle-win", actualFeeAtomic: 6_000_000, settledAtMs: NOW }
    });

    check(settled.settled === true, "settlement with an execution result must succeed");
    equal(settled.varianceAtomic, 6_000_000, "actual source fee is separate from zero recipient fee reservation");

    // The winner's fee variance must NOT have changed the owner's obligation.
    const ownerObligation = ledger.listPayoutObligations("room-settle")
        .find((o) => o.recipientId === OWNER.recipientId);

    equal(
        ownerObligation.reservedFeeAtomic,
        0,
        "the owner's reserved fee must be untouched by the winner's fee variance"
    );

    equal(
        ownerObligation.netAtomic,
        1_470_000_000,
        "the owner's net obligation must be untouched by the winner's fee variance"
    );

    // Idempotent: settling again with the same key is a replay, no second booking.
    const settledAgain = ledger.settlePayout({
        payoutId: "pay-settle", recipientId: WINNER.recipientId,
        executionResult: { transactionId: "tx-settle-win", actualFeeAtomic: 6_000_000, settledAtMs: NOW }
    });

    check(settledAgain.replay === true, "replaying a settlement must be idempotent");

    // The winner obligation is now resolved; the owner obligation remains.
    const obligations = ledger.listPayoutObligations("room-settle");

    const winnerObligation = obligations.find((o) => o.recipientId === WINNER.recipientId);

    check(winnerObligation.settled === true, "the settled winner obligation must be marked settled");

    equal(
        ledger.countOpenObligations("room-settle"),
        1,
        "one unsettled owner obligation must remain"
    );

    // Principal is unchanged by settlement (accounting only).
    equal(
        ledger.getRoomLedgerView("room-settle").totalSettledPrincipalAtomic,
        PRINCIPAL,
        "settlement must not change the total settled principal"
    );

    // A settlement with no matching planned obligation is rejected.
    expectThrow(
        () => ledger.settlePayout({
            payoutId: "pay-settle", recipientId: "not-a-recipient",
            executionResult: { transactionId: "tx-x", actualFeeAtomic: 1 }
        }),
        "PayoutSettlementError",
        "settling a payout with no planned obligation must be rejected"
    );

    check(planned.replay === false, "the initial plan was newly recorded");

    rmSync(dataDir, { recursive: true, force: true });

    console.log("[10/14] settlement + reconciliation: PASS");

}

// ---------------------------------------------------------------------------
// G11–G12 — exact rounding and ledger reserve/expense reporting.
{
 for(const principalAtomic of [1_000,1_000_000_001,1_234_567_891,PRINCIPAL,Number.MAX_SAFE_INTEGER]) {
  const allocation=RoomPayoutCalculator.allocatePrincipal(principalAtomic);
  const principal=BigInt(principalAtomic);
  equal(allocation.winnerGrossAllocationAtomic,Number(principal*95n/100n),'exact 95% rounding');
  equal(allocation.ownerGrossAllocationAtomic,Number(principal*49n/1000n),'exact 4.9% rounding');
  equal(BigInt(allocation.winnerGrossAllocationAtomic)+BigInt(allocation.ownerGrossAllocationAtomic)+BigInt(allocation.gasReserveAtomic),principal,'all nanoton accounted for');
 }
 const {dataDir,ledger,intentStore}=makeLedger();
 try {
  seedConfirmedRoom(ledger,'room-view',intentStore);
  ledger.planPayout({payoutId:'view',roomId:'room-view',winner:WINNER,owner:OWNER,nowMs:NOW});
  const before=ledger.getRoomLedgerView('room-view');
  equal(before.winnerGrossAtomic,28_500_000_000,'winner obligation');
  equal(before.ownerGrossAtomic,1_470_000_000,'owner obligation');
  equal(before.gasReserveAtomic,30_000_000,'reserve allocation recorded durably');
  equal(before.networkFeesReservedAtomic,0,'no recipient fee reservation');
  ledger.settlePayout({payoutId:'view',recipientId:WINNER.recipientId,
   executionResult:{transactionId:'synthetic-winner',actualFeeAtomic:35_000_000}});
  const after=ledger.getRoomLedgerView('room-view');
  equal(after.actualNetworkFeesAtomic,35_000_000,'actual source fees recorded separately even above allocation');
  equal(after.ownerGrossAtomic,1_470_000_000,'actual fee does not silently rewrite owner allocation');
  equal(after.openObligations,1,'owner remains due until independently settled');
 } finally {rmSync(dataDir,{recursive:true,force:true});}
 console.log('[11–12/14] exact rounding, reserve and actual fees: PASS');
}

// ---------------------------------------------------------------------------
// G13 — observation, client events, a bare confirmation label, and any
// non-settled or mismatched payment intent are never principal
// ---------------------------------------------------------------------------

{

    const { dataDir, ledger, intentStore } = makeLedger();

    const roomId = "room-observe";

    // A ledger WITHOUT the authoritative payment intent store cannot exist, so
    // it can never confirm principal.
    expectThrow(
        () => new RoomLedger({ store: ledger.store, currency: ledger.currency }),
        "LedgerStorageError",
        "a ledger without the authoritative payment intent store must fail closed"
    );

    expectThrow(
        () => ledger.recordIncomingPrincipal({
            idempotencyKey: "principal:observe:1", roomId, amountAtomic: ONE_GRAM,
            confirmation: {
                paymentReference: "pay-observe-1",
                transactionId: "tx-observe-1",
                source: "TONCENTER_OBSERVATION"
            }
        }),
        "PayoutValidationError",
        "an observation-only transaction must never be treated as confirmation"
    );

    expectThrow(
        () => ledger.recordIncomingPrincipal({
            idempotencyKey: "principal:observe:2", roomId, amountAtomic: ONE_GRAM,
            confirmation: {
                paymentReference: "pay-observe-2",
                transactionId: "tx-observe-2",
                source: "CLIENT_EVENT"
            }
        }),
        "PayoutValidationError",
        "a client event must never be treated as confirmation"
    );

    // An unconfirmed payment intent is not settled principal either.
    expectThrow(
        () => ledger.recordIncomingPrincipal({
            idempotencyKey: "principal:observe:3", roomId, amountAtomic: ONE_GRAM,
            confirmation: {
                paymentReference: "pay-observe-3",
                transactionId: "tx-observe-3",
                source: null
            }
        }),
        "PayoutValidationError",
        "a missing confirmation source must never be treated as settled principal"
    );

    // THE trust boundary: the confirmation LABEL is public knowledge. Carrying
    // it without a persisted, authoritative SETTLED intent behind it proves
    // nothing at all.
    expectThrow(
        () => ledger.recordIncomingPrincipal({
            idempotencyKey: "principal:observe:label-only", roomId, amountAtomic: ONE_GRAM,
            confirmation: {
                paymentReference: "pay-observe-label-only",
                transactionId: "tx-observe-label-only",
                source: INCOMING_PRINCIPAL_CONFIRMATION_SOURCE
            }
        }),
        "PayoutValidationError",
        "the confirmation source string alone must never confirm principal"
    );

    equal(
        ledger.getConfirmedPrincipalAtomic(roomId),
        0,
        "no principal may be confirmed from a client event or observation"
    );

    // A PENDING intent (no observation, no settlement) is not principal.
    createIntent({
        intentStore,
        paymentReference: "pay-observe-pending",
        roomId,
        playerId: "player-1",
        amountAtomic: ONE_GRAM
    });

    expectThrow(
        () => ledger.recordIncomingPrincipal({
            idempotencyKey: "principal:observe:pending", roomId, playerId: "player-1",
            amountAtomic: ONE_GRAM,
            confirmation: {
                paymentReference: "pay-observe-pending",
                transactionId: "tx-observe-pending",
                source: INCOMING_PRINCIPAL_CONFIRMATION_SOURCE
            }
        }),
        "PayoutValidationError",
        "a PENDING payment intent must never confirm principal"
    );

    // A MATCHED intent is still only an observation: never principal.
    createMatchedIntent({
        intentStore,
        paymentReference: "pay-observe-matched",
        roomId,
        playerId: "player-1",
        amountAtomic: ONE_GRAM,
        transactionId: "tx-observe-matched"
    });

    expectThrow(
        () => ledger.recordIncomingPrincipal({
            idempotencyKey: "principal:observe:matched", roomId, playerId: "player-1",
            amountAtomic: ONE_GRAM,
            confirmation: {
                paymentReference: "pay-observe-matched",
                transactionId: "tx-observe-matched",
                source: INCOMING_PRINCIPAL_CONFIRMATION_SOURCE
            }
        }),
        "PayoutValidationError",
        "a MATCHED (observation-only) payment intent must never confirm principal"
    );

    // A reference that resolves to a DIFFERENT persisted intent is rejected.
    const crossStore = makeIntentStore();

    createSettledIntent({
        intentStore: crossStore,
        paymentReference: "pay-observed-cross",
        roomId,
        playerId: "player-1",
        amountAtomic: ONE_GRAM,
        transactionId: "tx-observed-cross"
    });

    class CrossReferenceIntentStore extends PaymentIntentStore {

        get() {

            return super.get("pay-observed-cross");

        }

    }

    const crossIntentStore = new CrossReferenceIntentStore({
        dataDir: crossStore.dataDir
    });

    const crossLedger = makeLedger({ intentStore: crossIntentStore }).ledger;

    expectThrow(
        () => crossLedger.recordIncomingPrincipal({
            idempotencyKey: "principal:observe:cross", roomId, playerId: "player-1",
            amountAtomic: ONE_GRAM,
            confirmation: {
                paymentReference: "pay-observe-requested",
                transactionId: "tx-observed-cross",
                source: INCOMING_PRINCIPAL_CONFIRMATION_SOURCE
            }
        }),
        "PayoutValidationError",
        "a persisted intent whose reference differs from the confirmed reference must be rejected"
    );

    const crossLedgerHarness = makeLedger({ intentStore: crossIntentStore });

    rmSync(crossStore.dataDir, { recursive: true, force: true });
    rmSync(crossLedgerHarness.dataDir, { recursive: true, force: true });

    // An unreadable / erroring authoritative store fails closed.
    class UnreadableIntentStore extends PaymentIntentStore {

        get() {

            throw new Error("authoritative payment intent store unavailable");

        }

    }

    const unreadableIntentStore = new UnreadableIntentStore({
        dataDir: isolatedWorkspace()
    });

    const unreadableLedger = makeLedger({ intentStore: unreadableIntentStore }).ledger;

    expectThrow(
        () => unreadableLedger.recordIncomingPrincipal({
            idempotencyKey: "principal:observe:unreadable", roomId, amountAtomic: ONE_GRAM,
            confirmation: {
                paymentReference: "pay-observe-unreadable",
                transactionId: "tx-observe-unreadable",
                source: INCOMING_PRINCIPAL_CONFIRMATION_SOURCE
            }
        }),
        "PayoutValidationError",
        "an unreadable authoritative payment intent store must fail closed"
    );

    // A malformed store response is not a settled intent either.
    class MalformedIntentStore extends PaymentIntentStore {

        get() {

            return { paymentReference: "pay-observe-malformed", state: "SETTLED" };

        }

    }

    const malformedIntentStore = new MalformedIntentStore({
        dataDir: isolatedWorkspace()
    });

    const malformedLedger = makeLedger({ intentStore: malformedIntentStore }).ledger;

    expectThrow(
        () => malformedLedger.recordIncomingPrincipal({
            idempotencyKey: "principal:observe:malformed", roomId, amountAtomic: ONE_GRAM,
            confirmation: {
                paymentReference: "pay-observe-malformed",
                transactionId: "tx-observe-malformed",
                source: INCOMING_PRINCIPAL_CONFIRMATION_SOURCE
            }
        }),
        "PayoutValidationError",
        "a malformed authoritative store response must fail closed"
    );

    rmSync(unreadableIntentStore.dataDir, { recursive: true, force: true });
    rmSync(malformedIntentStore.dataDir, { recursive: true, force: true });

    // Every field of a persisted SETTLED intent must match the ledger entry.
    const mismatchStore = makeIntentStore();

    const mismatchHarness = makeLedger({ intentStore: mismatchStore });

    const mismatchLedger = mismatchHarness.ledger;

    const mismatchRoomId = "room-mismatch";

    const MISMATCH_PLAYER = "player-1";

    createSettledIntent({
        intentStore: mismatchStore,
        paymentReference: "pay-mismatch",
        roomId: mismatchRoomId,
        playerId: MISMATCH_PLAYER,
        amountAtomic: TEN_GRAM,
        transactionId: "tx-mismatch"
    });

    const mismatchAttempt = (key, confirmation, extra = {}) =>
        expectThrow(
            () => mismatchLedger.recordIncomingPrincipal({
                idempotencyKey: key,
                roomId: mismatchRoomId,
                playerId: MISMATCH_PLAYER,
                amountAtomic: TEN_GRAM,
                confirmation: {
                    paymentReference: "pay-mismatch",
                    transactionId: "tx-mismatch",
                    source: INCOMING_PRINCIPAL_CONFIRMATION_SOURCE,
                    ...confirmation
                },
                ...extra
            }),
            "PayoutValidationError",
            "a SETTLED intent that disagrees with the ledger entry must be rejected"
        );

    mismatchAttempt("principal:mismatch:tx", { transactionId: "tx-other" });
    mismatchAttempt("principal:mismatch:amount", {}, { amountAtomic: ONE_GRAM });
    mismatchAttempt("principal:mismatch:room", {}, { roomId: "room-other" });
    mismatchAttempt("principal:mismatch:player", {}, { playerId: "player-9" });

    // Network and asset identity are part of the ledger currency.
    const foreignNetworkStore = makeIntentStore();

    createSettledIntent({
        intentStore: foreignNetworkStore,
        paymentReference: "pay-mismatch-network",
        roomId: mismatchRoomId,
        playerId: MISMATCH_PLAYER,
        amountAtomic: TEN_GRAM,
        transactionId: "tx-mismatch-network",
        network: "other-network"
    });

    const foreignNetworkLedger = makeLedger({ intentStore: foreignNetworkStore });

    expectThrow(
        () => foreignNetworkLedger.ledger.recordIncomingPrincipal({
            idempotencyKey: "principal:mismatch:network",
            roomId: mismatchRoomId, playerId: MISMATCH_PLAYER, amountAtomic: TEN_GRAM,
            confirmation: {
                paymentReference: "pay-mismatch-network",
                transactionId: "tx-mismatch-network",
                source: INCOMING_PRINCIPAL_CONFIRMATION_SOURCE
            }
        }),
        "PayoutValidationError",
        "a SETTLED intent on another network must be rejected"
    );

    const foreignAssetStore = makeIntentStore();

    createSettledIntent({
        intentStore: foreignAssetStore,
        paymentReference: "pay-mismatch-asset",
        roomId: mismatchRoomId,
        playerId: MISMATCH_PLAYER,
        amountAtomic: TEN_GRAM,
        transactionId: "tx-mismatch-asset",
        asset: "OTHER-ASSET"
    });

    const foreignAssetLedger = makeLedger({ intentStore: foreignAssetStore });

    expectThrow(
        () => foreignAssetLedger.ledger.recordIncomingPrincipal({
            idempotencyKey: "principal:mismatch:asset",
            roomId: mismatchRoomId, playerId: MISMATCH_PLAYER, amountAtomic: TEN_GRAM,
            confirmation: {
                paymentReference: "pay-mismatch-asset",
                transactionId: "tx-mismatch-asset",
                source: INCOMING_PRINCIPAL_CONFIRMATION_SOURCE
            }
        }),
        "PayoutValidationError",
        "a SETTLED intent in another asset must be rejected"
    );

    rmSync(mismatchHarness.dataDir, { recursive: true, force: true });
    rmSync(mismatchStore.dataDir, { recursive: true, force: true });
    rmSync(foreignNetworkLedger.dataDir, { recursive: true, force: true });
    rmSync(foreignNetworkStore.dataDir, { recursive: true, force: true });
    rmSync(foreignAssetLedger.dataDir, { recursive: true, force: true });
    rmSync(foreignAssetStore.dataDir, { recursive: true, force: true });

    // A valid, persisted SETTLED intent is recorded EXACTLY ONCE.
    const verifiedRoomId = "room-verified";

    createSettledIntent({
        intentStore,
        paymentReference: "pay-verified-1",
        roomId: verifiedRoomId,
        playerId: "player-1",
        amountAtomic: TEN_GRAM,
        transactionId: "tx-verified-1"
    });

    const recorded = ledger.recordIncomingPrincipal({
        idempotencyKey: "principal:verified:1",
        roomId: verifiedRoomId,
        playerId: "player-1",
        amountAtomic: TEN_GRAM,
        confirmation: {
            paymentReference: "pay-verified-1",
            transactionId: "tx-verified-1",
            source: INCOMING_PRINCIPAL_CONFIRMATION_SOURCE
        }
    });

    check(recorded.replay === false, "a verified SETTLED intent must record a new principal entry");

    equal(
        recorded.entry.metadata.intentState,
        PAYMENT_INTENT_STATE.SETTLED,
        "a recorded principal entry must carry the verified SETTLED intent state"
    );

    const principalEntries = () =>
        ledger.store.listForRoom(verifiedRoomId)
            .filter((entry) => entry.kind === LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL);

    equal(principalEntries().length, 1, "a verified SETTLED intent must produce exactly one principal entry");
    equal(
        ledger.getConfirmedPrincipalAtomic(verifiedRoomId),
        TEN_GRAM,
        "a verified SETTLED intent must confirm exactly its own settled amount"
    );

    // Replaying the same idempotency key stays idempotent.
    const replayed = ledger.recordIncomingPrincipal({
        idempotencyKey: "principal:verified:1",
        roomId: verifiedRoomId,
        playerId: "player-1",
        amountAtomic: TEN_GRAM,
        confirmation: {
            paymentReference: "pay-verified-1",
            transactionId: "tx-verified-1",
            source: INCOMING_PRINCIPAL_CONFIRMATION_SOURCE
        }
    });

    check(replayed.replay === true, "replaying a verified principal entry must be idempotent");
    equal(principalEntries().length, 1, "a replay must not book the settled intent twice");
    equal(
        ledger.getConfirmedPrincipalAtomic(verifiedRoomId),
        TEN_GRAM,
        "a replay must not change the confirmed principal"
    );

    // The SAME settled intent under a DIFFERENT key is still rejected: one
    // settled payment can only ever become ledger principal once.
    expectThrow(
        () => ledger.recordIncomingPrincipal({
            idempotencyKey: "principal:verified:1:second-key",
            roomId: verifiedRoomId,
            playerId: "player-1",
            amountAtomic: TEN_GRAM,
            confirmation: {
                paymentReference: "pay-verified-1",
                transactionId: "tx-verified-1",
                source: INCOMING_PRINCIPAL_CONFIRMATION_SOURCE
            }
        }),
        "PayoutValidationError",
        "one settled payment intent must never be recorded as principal twice"
    );

    equal(
        ledger.getConfirmedPrincipalAtomic(verifiedRoomId),
        TEN_GRAM,
        "a rejected re-book must not change the confirmed principal"
    );

    equal(
        ledger.getConfirmedPrincipalAtomic(roomId),
        0,
        "every failed verification in this section must leave the confirmed principal untouched"
    );

    equal(
        ledger.store.listForRoom(roomId)
            .filter((entry) => entry.kind === LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL).length,
        0,
        "every failed verification must leave no ledger principal entry behind"
    );

    // With no settled principal, no payout can be planned at all.
    expectThrow(
        () => ledger.planPayout({
            payoutId: "pay-observe", roomId,
            winner: WINNER, owner: OWNER,
            allocation: standardAllocation(),
            networkFees: feeQuotes(),
            nowMs: NOW
        }),
        "PayoutValidationError",
        "a payout cannot be planned without settled principal"
    );

    rmSync(dataDir, { recursive: true, force: true });

    console.log("[13/14] observation is never confirmation: PASS");

}

// ---------------------------------------------------------------------------
// G14 — no execution, broadcast, signing, provider access, and no legacy rule
// ---------------------------------------------------------------------------

{

    // 14a — capability descriptor: everything is explicitly disabled.
    check(LEDGER_CAPABILITIES.transfersEnabled === false, "transfers must be disabled");
    check(LEDGER_CAPABILITIES.broadcastsEnabled === false, "broadcasts must be disabled");
    check(LEDGER_CAPABILITIES.walletSigningEnabled === false, "wallet signing must be disabled");
    check(LEDGER_CAPABILITIES.smartContractsEnabled === false, "smart contracts must be disabled");
    check(LEDGER_CAPABILITIES.providerAccessEnabled === false, "provider access must be disabled");
    check(LEDGER_CAPABILITIES.realPaymentCollectionEnabled === false, "real payment collection must be disabled");
    check(LEDGER_CAPABILITIES.storesWalletSecrets === false, "the ledger must not store wallet secrets");

    // 14b — module surface exposes no forbidden operation / contract.
    const surface = Object.keys(await import("../payment/ledger/index.js"));

    for (const forbidden of LEDGER_FORBIDDEN_OPERATIONS) {

        check(
            surface.includes(forbidden) === false,
            `ledger module surface must not expose ${forbidden}`
        );

    }

    for (const contract of ["GameEscrow", "DepositContract"]) {

        check(
            surface.includes(contract) === false,
            `ledger module surface must not expose ${contract}`
        );

    }

    // 14c — no percentage / reserve surface is exported any more.
    for (const removed of [
        "ROUNDING_POLICY", "ROUNDING_POLICIES", "BASIS_POINTS_PER_UNIT",
        "isRoundingPolicy"
    ]) {

        check(
            surface.includes(removed) === false,
            `the ledger surface must not export ${removed} any more`
        );

    }

    // 14d — source scan: no network / provider / contract / secret access.
    const ledgerDir = dirname(fileURLToPath(import.meta.url));

    const ledgerModuleDir = join(ledgerDir, "..", "payment", "ledger");

    const sourceFiles = readdirSync(ledgerModuleDir).filter((name) => name.endsWith(".js"));

    check(sourceFiles.length >= 9, `expected the isolated ledger module files, got ${sourceFiles.length}`);

    // Tokens that must NEVER appear in ANY ledger source file.
    const networkAndSecretTokens = [
        "fetch(",
        "XMLHttpRequest",
        "WebSocket",
        "node:https",
        "node:http2",
        "node:dgram",
        "\"node:net\"",
        "Toncenter",
        "TonClient",
        "TonConnect",
        "process.env",
        "mnemonic",
        "privateKey",
        "secretKey",
        "passphrase",
        ".env"
    ];

    // Contract names appear ONLY as declared prohibitions in the single
    // forbidden-operations declaration file (LedgerConstants.js); every other
    // ledger source file must be free of them.
    const DECLARATION_FILE = "LedgerConstants.js";

    const contractNameTokens = ["GameEscrow", "DepositContract"];

    // Percentage / reserve tokens must NOT define any payout rule. They may
    // only appear inside explanatory comments that forbid them.
    const forbiddenPayoutTokens = [
        "BASIS_POINTS_PER_UNIT",
        "ROUNDING_POLICY"
    ];

    for (const fileName of sourceFiles) {

        const source = readFileSync(join(ledgerModuleDir, fileName), "utf8");

        for (const token of networkAndSecretTokens) {

            check(
                source.includes(token) === false,
                `ledger source ${fileName} must not reference forbidden token: ${token}`
            );

        }

        for (const token of forbiddenPayoutTokens) {

            check(
                source.includes(token) === false,
                `ledger source ${fileName} must not define any ${token} payout rule`
            );

        }

        if (fileName === DECLARATION_FILE) {

            continue;

        }

        for (const token of contractNameTokens) {

            check(
                source.includes(token) === false,
                `ledger source ${fileName} must not reference forbidden contract: ${token}`
            );

        }

    }

    // 14e — the payout plan itself declares that it executes nothing.
    const plan = RoomPayoutCalculator.computePlan({
        payoutId: "p-cap", roomId: "r", asset: "TON", network: NETWORK,
        principalAtomic: PRINCIPAL, allocation: standardAllocation(),
        winner: WINNER, owner: OWNER,
        networkFees: feeQuotes(), nowMs: NOW
    });

    check(
        plan.capabilities.transfersEnabled === false
            && plan.capabilities.broadcastsEnabled === false
            && plan.capabilities.walletSigningEnabled === false,
        "a payout plan must declare that it executes nothing"
    );

    console.log("[14/14] no execution / broadcast / signing / provider access: PASS");

}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(
    `\nIsolated Phase 4 ledger + payout tests passed | assertions=${checksPassed}`
        + ` | asset=TON | 1Gram=${ONE_GRAM} | 10Gram=${TEN_GRAM}`
        + ` | transfersEnabled=false`
        + ` | sendsAnything=false`
        + ` | reserve=0.1% plus rounding`
);

export { checksPassed };
