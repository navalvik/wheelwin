/**
 * Phase 4 — Internal ledger + payout accounting (ISOLATED synthetic tests).
 *
 * Fully self-contained: durable state lives only inside a temporary workspace,
 * all amounts and recipients are synthetic, no `.env` / wallet-secret / repo
 * config file is read or mutated, no blockchain node, provider, endpoint or
 * wallet is ever contacted, and nothing is sent, broadcast or signed.
 *
 * Covered scenarios (per the APPROVED Phase 4 payout rules):
 *   G1  Gram <-> nanoton conversion with EXACT integer values (1 Gram = 1 TON
 *       = 1_000_000_000 nanotons; 10 Gram = 10_000_000_000 nanotons), display
 *       denomination kept separate from the canonical asset identifier.
 *   G2  Player stake + sector-amount accounting (individually attributable),
 *       unknown/contradictory stake labels rejected (never invented).
 *   G3  Missing or invalid winner-allocation configuration -> FAIL CLOSED with
 *       the EXACT missing fields reported. No winner percentage, owner
 *       percentage, reserve percentage or rounding policy exists anywhere.
 *   G4  Residual owner allocation: ownerGrossAllocationAtomic
 *       = totalSettledPrincipalAtomic - winnerGrossAllocationAtomic, computed
 *       exactly, with the zero-reserve accounting invariant.
 *   G5  Winner gas charged ONLY to the winner allocation.
 *   G6  Owner payout gas charged ONLY to the owner residual allocation.
 *   G7  Fee exceeding (or equal to) the gross allocation -> rejected; each fee
 *       validated independently (missing / non-integer / negative / zero fee).
 *   G8  Duplicate ledger entry + replay protection (idempotency + on-disk
 *       overwrite protection).
 *   G9  Restart-safe ledger persistence.
 *   G10 Settlement requires an execution result; explicit idempotent fee
 *       reconciliation; neither party's fee charged to the other.
 *   G11 Boundary winner allocations (0, exact principal, principal + 1,
 *       non-integer, negative) and the final reconciliation invariant.
 *   G12 Exact atomic-unit reconciliation of the ledger view.
 *   G13 Observation / client event / a bare confirmation label / an
 *       unconfirmed or mismatched payment intent is never confirmed
 *       principal: incoming principal is authorized ONLY by a persisted,
 *       SETTLED payment intent resolved from the authoritative
 *       PaymentIntentStore and verified field-by-field.
 *   G14 No transaction execution, broadcast, wallet signing, or provider
 *       access (module surface, capabilities, and a source scan).
 *
 * Project convention: plain ESM + a manual `assert` harness; no test framework
 * and no external dependencies are required.
 */

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
// G3 — the APPROVED, FIXED 95% winner rule (nothing is configurable)
// ---------------------------------------------------------------------------

{

    const approvedRule = PayoutAllocationConfig.approved();

    // The rule carries its provenance, so an auditor can prove which rule
    // produced the allocation.
    equal(approvedRule.numerator, 95n, "the approved winner share numerator must be 95");
    equal(approvedRule.denominator, 100n, "the approved winner share denominator must be 100");

    const provenance = approvedRule.toJSON();

    check(
        typeof provenance.ruleId === "string" && provenance.ruleId !== "",
        "the approved rule must expose a stable provenance rule id"
    );

    // An odd, non-round principal keeps the rounding remainder observable: the
    // truncated nanotons must land in the owner residual, never disappear.
    const ODD_PRINCIPAL = 1_234_567_891;

    for (const principalAtomic of [ONE_GRAM, TEN_GRAM, ODD_PRINCIPAL]) {

        const allocated = RoomPayoutCalculator.allocatePrincipal(principalAtomic);

        // winnerGrossAllocationAtomic = floor(principal * 95 / 100), evaluated
        // independently in BigInt so the expectation is exact.
        const expectedWinner = Number((BigInt(principalAtomic) * 95n) / 100n);
        const expectedOwner = principalAtomic - expectedWinner;

        equal(
            allocated.principalAtomic,
            principalAtomic,
            `allocation for ${principalAtomic} must echo the settled principal`
        );

        equal(
            allocated.winnerGrossAllocationAtomic,
            expectedWinner,
            `winner gross for ${principalAtomic} must be floor(principal * 95 / 100)`
        );

        equal(
            allocated.ownerGrossAllocationAtomic,
            expectedOwner,
            `owner gross for ${principalAtomic} must be the exact remainder`
        );

        equal(
            allocated.winnerGrossAllocationAtomic + allocated.ownerGrossAllocationAtomic,
            principalAtomic,
            `winner gross + owner residual for ${principalAtomic} must exactly equal the principal`
        );

        equal(
            allocated.safetyMarginAtomic,
            0,
            `the safety margin for ${principalAtomic} must stay permanently zero`
        );

        equal(
            allocated.allocationRuleId,
            provenance.ruleId,
            `allocation provenance for ${principalAtomic} must identify the approved rule`
        );

    }

    // Exact expected values: 1 TON.
    const oneTon = RoomPayoutCalculator.allocatePrincipal(ONE_GRAM);

    equal(oneTon.winnerGrossAllocationAtomic, 950_000_000, "1 TON: winner gross must be exactly 0.95 TON");
    equal(oneTon.ownerGrossAllocationAtomic, 50_000_000, "1 TON: owner residual must be exactly 0.05 TON");

    // Exact expected values: 10 TON.
    const tenTon = RoomPayoutCalculator.allocatePrincipal(TEN_GRAM);

    equal(tenTon.winnerGrossAllocationAtomic, 9_500_000_000, "10 TON: winner gross must be exactly 9.5 TON");
    equal(tenTon.ownerGrossAllocationAtomic, 500_000_000, "10 TON: owner residual must be exactly 0.5 TON");

    // Exact expected values: an odd nanaton principal (remainder is 45 nanotons).
    const odd = RoomPayoutCalculator.allocatePrincipal(ODD_PRINCIPAL);

    equal(odd.winnerGrossAllocationAtomic, 1_172_839_496, "odd principal: winner gross must be floor(1_234_567_891 * 95 / 100)");
    equal(odd.ownerGrossAllocationAtomic, 61_728_395, "odd principal: owner residual must keep the rounding remainder");

    // The rule is NOT configurable: a caller-supplied winner amount, percentage,
    // rounding policy or commission is ignored and never changes the allocation.
    const oddWinner = odd.winnerGrossAllocationAtomic;

    const overridden = RoomPayoutCalculator.allocatePrincipal(ODD_PRINCIPAL, {
        winnerGrossAllocationAtomic: 1,
        winnerPercent: 1,
        ownerCommissionPercent: 99,
        roundingPolicy: "CEIL",
        allocationSource: "caller-supplied"
    });

    equal(
        overridden.winnerGrossAllocationAtomic,
        oddWinner,
        "no caller-supplied percentage, winner amount or rounding policy may override the fixed rule"
    );

    equal(
        overridden.ownerGrossAllocationAtomic,
        ODD_PRINCIPAL - oddWinner,
        "the owner residual must stay the exact remainder after the fixed rule"
    );

    equal(
        overridden.allocationRuleId,
        provenance.ruleId,
        "an overridden allocation must still be identified as the approved rule"
    );

    // The same provenance is carried on every computed payout plan.
    const plan = RoomPayoutCalculator.computePlan({
        payoutId: "p-rule", roomId: "r", asset: "TON", network: NETWORK,
        principalAtomic: ONE_GRAM,
        winner: WINNER, owner: OWNER,
        networkFees: feeQuotes(), nowMs: NOW
    });

    equal(
        plan.allocation.ruleId,
        provenance.ruleId,
        "a payout plan must identify the approved allocation rule"
    );

    equal(
        plan.transferFor("WINNER").grossAtomic,
        950_000_000,
        "the winner payout must carry the fixed 95% gross allocation"
    );

    equal(
        plan.transferFor("OWNER").grossAtomic,
        50_000_000,
        "the owner payout must carry the exact remainder"
    );

    console.log("[3/14] approved fixed 95% winner allocation rule: PASS");

}

// ---------------------------------------------------------------------------
// G4 — residual owner allocation + the zero-reserve accounting invariant
// ---------------------------------------------------------------------------

{

    const allocation = new PayoutAllocationConfig(standardAllocation());

    // DETERMINISTIC: identical inputs -> byte-identical net amounts.
    const buildPlan = () => RoomPayoutCalculator.computePlan({
        payoutId: "p-net", roomId: "r", asset: "TON", network: NETWORK,
        principalAtomic: PRINCIPAL, allocation,
        winner: WINNER, owner: OWNER,
        networkFees: feeQuotes(), nowMs: NOW
    });

    const plan = buildPlan();

    const winner = plan.transferFor("WINNER");
    const owner = plan.transferFor("OWNER");

    // Winner gross is the EXACT authoritative allocation (28.5 TON).
    equal(winner.grossAtomic, WINNER_ALLOCATION, "winner gross must equal the authoritative allocation");
    equal(winner.grossAtomic, 28_500_000_000, "winner gross must be 28.5 TON");

    // Owner gross is the EXACT RESIDUAL: 30 TON - 28.5 TON = 1.5 TON.
    equal(
        owner.grossAtomic,
        PRINCIPAL - WINNER_ALLOCATION,
        "owner gross must be the exact residual of the settled principal"
    );
    equal(owner.grossAtomic, 1_500_000_000, "owner residual gross must be 1.5 TON");

    // The residual is exact subtraction, not a percentage: the two gross
    // allocations always sum to the principal with no leftover and no
    // over-allocation.
    equal(
        winner.grossAtomic + owner.grossAtomic,
        PRINCIPAL,
        "winner gross + owner residual gross must exactly equal settled principal"
    );

    // net = gross - the fee allocated to that recipient.
    equal(winner.netAtomic, winner.grossAtomic - WINNER_FEE, "winner net = gross - winner fee");
    equal(owner.netAtomic, owner.grossAtomic - OWNER_FEE, "owner net = gross - owner fee");
    equal(winner.netAtomic, 28_495_000_000, "winner net must be 28.495 TON");
    equal(owner.netAtomic, 1_499_000_000, "owner net must be 1.499 TON");

    // THE final reconciliation invariant, with NO reserve term:
    //   winnerNetPayoutAtomic + ownerNetPayoutAtomic
    //       + winnerNetworkFeeAtomic + ownerNetworkFeeAtomic
    //       === totalSettledPrincipalAtomic
    equal(
        winner.netAtomic + owner.netAtomic
            + winner.reservedFeeAtomic + owner.reservedFeeAtomic,
        PRINCIPAL,
        "the final reconciliation invariant must hold exactly (no reserve term)"
    );

    equal(
        plan.totalNetAtomic + plan.totalReservedFeeAtomic,
        PRINCIPAL,
        "plan totals must account for the settled principal with no reserve"
    );

    check(plan.reconcile() === true, "plan.reconcile() must be true for a valid plan");

    // Zero reserve, PERMANENTLY: the plan has no reserve surface at all.
    check(
        "reserveAtomic" in plan === false && plan.reserveAtomic === undefined,
        "a payout plan must not expose any reserve amount"
    );

    check(
        Object.prototype.hasOwnProperty.call(plan.toJSON(), "reserveAtomic") === false,
        "a serialized payout plan must not contain a reserve"
    );

    check(
        JSON.stringify(plan.toJSON()).includes("reserveAtomic") === false
            && JSON.stringify(plan.toJSON()).includes("safetyMargin") === false
            && JSON.stringify(plan.toJSON()).includes("reservePercent") === false,
        "a serialized payout plan must not mention any reserve or safety margin"
    );

    // Determinism.
    const plan2 = buildPlan();

    check(
        plan2.transferFor("WINNER").netAtomic === winner.netAtomic
            && plan2.transferFor("OWNER").netAtomic === owner.netAtomic,
        "identical inputs must produce identical net amounts (pure + deterministic)"
    );

    // Zero fees on BOTH transfers: the invariant still holds exactly.
    const zeroFeePlan = RoomPayoutCalculator.computePlan({
        payoutId: "p-zero-fee", roomId: "r", asset: "TON", network: NETWORK,
        principalAtomic: PRINCIPAL, allocation,
        winner: WINNER, owner: OWNER,
        networkFees: feeQuotes({ winnerFee: 0, ownerFee: 0 }), nowMs: NOW
    });

    equal(
        zeroFeePlan.transferFor("WINNER").reservedFeeAtomic, 0,
        "a zero network fee must be accepted"
    );

    equal(
        zeroFeePlan.transferFor("OWNER").reservedFeeAtomic, 0,
        "a zero owner network fee must be accepted"
    );

    equal(
        zeroFeePlan.transferFor("WINNER").netAtomic, WINNER_ALLOCATION,
        "a zero fee must leave the winner gross fully intact"
    );

    equal(
        zeroFeePlan.transferFor("OWNER").netAtomic,
        PRINCIPAL - WINNER_ALLOCATION,
        "a zero fee must leave the owner residual fully intact"
    );

    equal(
        zeroFeePlan.transferFor("WINNER").netAtomic
            + zeroFeePlan.transferFor("OWNER").netAtomic,
        PRINCIPAL,
        "zero fees must reconcile exactly to the settled principal"
    );

    check(zeroFeePlan.reconcile() === true, "a zero-fee plan must reconcile exactly");

    console.log("[4/14] residual owner allocation + zero-reserve invariant: PASS");

}

// ---------------------------------------------------------------------------
// G5 — winner gas charged ONLY to the winner allocation
// ---------------------------------------------------------------------------

{

    const allocation = new PayoutAllocationConfig(standardAllocation());

    const ownerNet = ownerFee => RoomPayoutCalculator.computePlan({
        payoutId: "p-w5", roomId: "r", asset: "TON", network: NETWORK,
        principalAtomic: PRINCIPAL, allocation,
        winner: WINNER, owner: OWNER,
        networkFees: feeQuotes({ ownerFee }), nowMs: NOW
    }).transferFor("OWNER").netAtomic;

    const winnerNet = winnerFee => RoomPayoutCalculator.computePlan({
        payoutId: "p-w5b", roomId: "r", asset: "TON", network: NETWORK,
        principalAtomic: PRINCIPAL, allocation,
        winner: WINNER, owner: OWNER,
        networkFees: feeQuotes({ winnerFee }), nowMs: NOW
    }).transferFor("WINNER").netAtomic;

    // Vary the WINNER fee. The OWNER net must be completely unaffected — the
    // winner's network fee is never charged to the owner's funds.
    const ownerAtWinnerFee5 = ownerNet(OWNER_FEE);

    const planWinnerFeeHigh = RoomPayoutCalculator.computePlan({
        payoutId: "p-w5c", roomId: "r", asset: "TON", network: NETWORK,
        principalAtomic: PRINCIPAL, allocation,
        winner: WINNER, owner: OWNER,
        networkFees: feeQuotes({ winnerFee: 9_000_000 }), nowMs: NOW
    });

    equal(
        planWinnerFeeHigh.transferFor("OWNER").netAtomic,
        ownerAtWinnerFee5,
        "the owner net must not change when the winner fee changes (no cross-charging)"
    );

    equal(
        planWinnerFeeHigh.transferFor("OWNER").reservedFeeAtomic,
        OWNER_FEE,
        "the owner reserved fee must remain its own quote regardless of the winner fee"
    );

    equal(
        planWinnerFeeHigh.transferFor("OWNER").grossAtomic,
        PRINCIPAL - WINNER_ALLOCATION,
        "the owner residual gross must not change when the winner fee changes"
    );

    // The winner net moves exactly by the change in the winner fee.
    equal(
        winnerNet(5_000_000) - winnerNet(9_000_000),
        4_000_000,
        "the winner net must move exactly by the change in the winner fee"
    );

    console.log("[5/14] winner gas charged only to the winner: PASS");

}

// ---------------------------------------------------------------------------
// G6 — owner payout gas charged ONLY to the owner residual allocation
// ---------------------------------------------------------------------------

{

    const allocation = new PayoutAllocationConfig(standardAllocation());

    const winnerNetFor = ownerFee => RoomPayoutCalculator.computePlan({
        payoutId: "p-w6", roomId: "r", asset: "TON", network: NETWORK,
        principalAtomic: PRINCIPAL, allocation,
        winner: WINNER, owner: OWNER,
        networkFees: feeQuotes({ ownerFee }), nowMs: NOW
    }).transferFor("WINNER").netAtomic;

    // Vary the OWNER fee. The WINNER net must be completely unaffected.
    equal(
        winnerNetFor(OWNER_FEE),
        winnerNetFor(4_000_000),
        "the winner net must not change when the owner fee changes"
    );

    const plan = RoomPayoutCalculator.computePlan({
        payoutId: "p-w6b", roomId: "r", asset: "TON", network: NETWORK,
        principalAtomic: PRINCIPAL, allocation,
        winner: WINNER, owner: OWNER,
        networkFees: feeQuotes(), nowMs: NOW
    });

    equal(
        plan.transferFor("OWNER").reservedFeeAtomic,
        OWNER_FEE,
        "the owner fee must be charged to the owner residual only"
    );

    equal(
        plan.transferFor("OWNER").netAtomic,
        plan.transferFor("OWNER").grossAtomic - OWNER_FEE,
        "the owner net must be the owner residual gross minus the owner fee only"
    );

    console.log("[6/14] owner payout gas charged only to the owner residual: PASS");

}

// ---------------------------------------------------------------------------
// G7 — fee exceeding / missing / invalid -> reject (validated independently)
// ---------------------------------------------------------------------------

{

    const allocation = new PayoutAllocationConfig(standardAllocation());

    const base = {
        payoutId: "p-fee", roomId: "r", asset: "TON", network: NETWORK,
        principalAtomic: PRINCIPAL, allocation,
        winner: WINNER, owner: OWNER,
        nowMs: NOW
    };

    // Winner fee == winner gross -> reject.
    const equalWinner = expectThrow(
        () => RoomPayoutCalculator.computePlan({
            ...base,
            networkFees: feeQuotes({ winnerFee: 28_500_000_000 })
        }),
        "PayoutFeeError",
        "a winner fee equal to the winner gross must be rejected"
    );

    check(equalWinner.code === "PAYOUT_FEE_EXCEEDS_GROSS", "equal-to-gross winner fee must use PAYOUT_FEE_EXCEEDS_GROSS");

    // Winner fee > winner gross -> reject.
    expectThrow(
        () => RoomPayoutCalculator.computePlan({
            ...base,
            networkFees: feeQuotes({ winnerFee: 28_500_000_001 })
        }),
        "PayoutFeeError",
        "a winner fee greater than the winner gross must be rejected"
    );

    // Owner fee >= owner residual gross -> reject.
    expectThrow(
        () => RoomPayoutCalculator.computePlan({
            ...base,
            networkFees: feeQuotes({ ownerFee: 1_500_000_000 })
        }),
        "PayoutFeeError",
        "an owner fee equal to the owner residual gross must be rejected"
    );

    expectThrow(
        () => RoomPayoutCalculator.computePlan({
            ...base,
            networkFees: feeQuotes({ ownerFee: 1_500_000_001 })
        }),
        "PayoutFeeError",
        "an owner fee greater than the owner residual gross must be rejected"
    );

    // Missing winner fee quote -> reject.
    const missing = expectThrow(
        () => RoomPayoutCalculator.computePlan({
            ...base,
            networkFees: { owner: { feeAtomic: OWNER_FEE, quotedAtMs: NOW } }
        }),
        "PayoutFeeError",
        "a missing winner fee quote must be rejected"
    );

    check(missing.code === "PAYOUT_FEE_MISSING", "missing fee quote must use PAYOUT_FEE_MISSING");

    // Missing owner fee quote -> reject independently of the winner fee.
    const missingOwner = expectThrow(
        () => RoomPayoutCalculator.computePlan({
            ...base,
            networkFees: { winner: { feeAtomic: WINNER_FEE, quotedAtMs: NOW } }
        }),
        "PayoutFeeError",
        "a missing owner fee quote must be rejected independently"
    );

    check(
        missingOwner.details?.recipientRole === "OWNER",
        "the missing owner fee quote must be reported for the OWNER role"
    );

    // A completely absent fee map -> reject.
    expectThrow(
        () => RoomPayoutCalculator.computePlan({ ...base, networkFees: undefined }),
        "PayoutFeeError",
        "absent network fees must be rejected"
    );

    // Non-integer fee -> reject (INVALID).
    expectThrow(
        () => RoomPayoutCalculator.computePlan({
            ...base,
            networkFees: feeQuotes({ winnerFee: 1.5 })
        }),
        "PayoutFeeError",
        "a floating-point fee must be rejected as invalid"
    );

    // Negative fee -> reject (INVALID).
    const negative = expectThrow(
        () => RoomPayoutCalculator.computePlan({
            ...base,
            networkFees: feeQuotes({ winnerFee: -1 })
        }),
        "PayoutFeeError",
        "a negative fee must be rejected as invalid"
    );

    check(negative.code === "PAYOUT_FEE_INVALID", "a negative fee must use PAYOUT_FEE_INVALID");

    // Negative owner fee -> reject independently.
    expectThrow(
        () => RoomPayoutCalculator.computePlan({
            ...base,
            networkFees: feeQuotes({ ownerFee: -1 })
        }),
        "PayoutFeeError",
        "a negative owner fee must be rejected independently"
    );

    // Stale fee quote -> reject (STALE).
    const stale = expectThrow(
        () => RoomPayoutCalculator.computePlan({
            ...base,
            maxQuoteAgeMs: 1_800_000,
            networkFees: {
                winner: { feeAtomic: WINNER_FEE, quotedAtMs: NOW - 2_000_000 },
                owner: { feeAtomic: OWNER_FEE, quotedAtMs: NOW }
            },
            nowMs: NOW
        }),
        "PayoutFeeError",
        "a stale fee quote must be rejected"
    );

    check(stale.code === "PAYOUT_FEE_STALE", "a stale fee quote must use PAYOUT_FEE_STALE");

    // A missing quote time with a freshness requirement is stale, never a
    // free-form default.
    expectThrow(
        () => RoomPayoutCalculator.computePlan({
            ...base,
            maxQuoteAgeMs: 1_800_000,
            networkFees: {
                winner: { feeAtomic: WINNER_FEE },
                owner: { feeAtomic: OWNER_FEE, quotedAtMs: NOW }
            },
            nowMs: NOW
        }),
        "PayoutFeeError",
        "a missing quote time under a freshness requirement must be rejected"
    );

    // A fee is never hardcoded by this phase: no fee quote -> rejection, so a
    // plan can only exist when an external fee-estimation layer supplies one.
    console.log("[7/14] fee exceeding / missing / invalid -> reject: PASS");

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
    equal(settled.varianceAtomic, 1_000_000, "an actual fee 1e6 above the reserved fee is a +1e6 variance");

    // The winner's fee variance must NOT have changed the owner's obligation.
    const ownerObligation = ledger.listPayoutObligations("room-settle")
        .find((o) => o.recipientId === OWNER.recipientId);

    equal(
        ownerObligation.reservedFeeAtomic,
        OWNER_FEE,
        "the owner's reserved fee must be untouched by the winner's fee variance"
    );

    equal(
        ownerObligation.netAtomic,
        (PRINCIPAL - WINNER_ALLOCATION) - OWNER_FEE,
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
// G11 — approved-rule principal boundaries + exact atomic reconciliation
// ---------------------------------------------------------------------------

{

    const base = {
        payoutId: "p-boundary", roomId: "r", asset: "TON", network: NETWORK,
        winner: WINNER, owner: OWNER, nowMs: NOW
    };

    // The FIXED, approved rule, in exact BigInt integer arithmetic:
    //   winnerGrossAllocationAtomic = floor(principalAtomic * 95 / 100)
    //   ownerGrossAllocationAtomic  = principalAtomic - winnerGrossAllocationAtomic
    const approvedSplit = (principalAtomic) => {

        const principal = BigInt(principalAtomic);
        const winner = (principal * 95n) / 100n;

        return {
            winnerGrossAllocationAtomic: Number(winner),
            ownerGrossAllocationAtomic: Number(principal - winner)
        };

    };

    // NO allocation configuration is passed: the fixed rule is the only
    // authority and no caller value can ever override it.
    const planFor = (principalAtomic, fees = feeQuotes()) =>
        RoomPayoutCalculator.computePlan({
            ...base,
            principalAtomic,
            networkFees: fees
        });

    // A fee must be strictly below its own recipient's gross allocation, so a
    // tiny principal can only be planned as a genuinely free transfer.
    const freeFees = feeQuotes({ winnerFee: 0, ownerFee: 0 });

    /**
     * Build a plan for one principal and assert the complete approved-rule
     * accounting: the exact floored 95% winner gross, the exact owner remainder,
     * each fee charged only to its own recipient, no winner transfer whenever
     * the computed winner gross is zero, and the final exact reconciliation.
     */
    const assertApprovedPlan = (label, principalAtomic, fees = feeQuotes()) => {

        const plan = planFor(principalAtomic, fees);

        const expected = approvedSplit(principalAtomic);

        const winner = plan.transferFor("WINNER");
        const owner = plan.transferFor("OWNER");

        // winnerGrossAllocationAtomic = floor(principalAtomic * 95 / 100)
        equal(
            winner === null ? 0 : winner.grossAtomic,
            expected.winnerGrossAllocationAtomic,
            `${label}: winner gross must be floor(principal * 95 / 100)`
        );

        // ownerGrossAllocationAtomic = principalAtomic - winner (exact remainder)
        equal(
            owner === null ? 0 : owner.grossAtomic,
            expected.ownerGrossAllocationAtomic,
            `${label}: owner gross must be the exact remainder of the settled principal`
        );

        // A zero computed winner gross produces NO winner transfer at all.
        if (expected.winnerGrossAllocationAtomic === 0) {

            check(
                winner === null,
                `${label}: a zero computed winner gross must produce no winner transfer`
            );

        } else {

            check(
                winner !== null,
                `${label}: a positive computed winner gross must produce a winner transfer`
            );

        }

        // The winner share is strictly below 100%, so the owner residual is
        // always positive and always planned as a transfer.
        check(
            expected.ownerGrossAllocationAtomic > 0,
            `${label}: the owner residual must always be positive`
        );

        check(
            owner !== null,
            `${label}: the positive owner residual must always produce an owner transfer`
        );

        // Each fee is charged ONLY to its own recipient's gross allocation.
        const winnerFee = winner === null ? 0 : winner.reservedFeeAtomic;
        const ownerFee = owner.reservedFeeAtomic;

        equal(
            winner === null ? 0 : winner.netAtomic,
            expected.winnerGrossAllocationAtomic - winnerFee,
            `${label}: winner net must be the winner gross minus its own fee`
        );

        equal(
            owner.netAtomic,
            expected.ownerGrossAllocationAtomic - ownerFee,
            `${label}: owner net must be the owner residual minus its own fee`
        );

        // THE final reconciliation invariant, exactly, in nanotons:
        //   winnerNet + ownerNet + winnerFee + ownerFee === principalAtomic
        equal(
            (winner === null ? 0 : winner.netAtomic)
                + owner.netAtomic
                + winnerFee
                + ownerFee,
            principalAtomic,
            `${label}: winner net + owner net + winner fee + owner fee === principal`
        );

        check(
            plan.reconcile() === true,
            `${label}: the payout plan must reconcile exactly`
        );

        return plan;

    };

    // --- BOUNDARY 1: invalid / unsafe principals -> REJECTED (fail closed) ---
    for (const invalidPrincipal of [
        0,
        -1,
        1.5,
        NaN,
        "1000000",
        Number.MAX_SAFE_INTEGER + 1
    ]) {

        expectThrow(
            () => planFor(invalidPrincipal),
            "PayoutValidationError",
            `an invalid principal (${String(invalidPrincipal)}) must be rejected`
        );

        expectThrow(
            () => RoomPayoutCalculator.allocatePrincipal(invalidPrincipal),
            "PayoutValidationError",
            `an invalid principal (${String(invalidPrincipal)}) must be rejected by the allocation primitive`
        );

    }

    // --- BOUNDARY 2: tiny positive principals; the winner share is rounded
    // DOWN and the truncated nanotons always stay in the owner remainder.
    for (const tinyPrincipal of [1, 2, 3, 5, 19, 99, 100, 101, 105]) {

        assertApprovedPlan(`${tinyPrincipal}-nanoton principal`, tinyPrincipal, freeFees);

    }

    // 1 nanaton is the only principal whose winner share floors to zero.
    equal(
        approvedSplit(1).winnerGrossAllocationAtomic,
        0,
        "a 1-nanoton principal must floor the winner share to zero"
    );

    // 2 nanotons is the first principal with a positive winner allocation.
    equal(
        approvedSplit(2).winnerGrossAllocationAtomic,
        1,
        "a 2-nanoton principal must be the first positive winner allocation"
    );

    equal(
        approvedSplit(2).ownerGrossAllocationAtomic,
        1,
        "the truncation remainder must stay in the owner residual"
    );

    // --- BOUNDARY 3: the standard room principal + principal + 1 nanaton -----
    const normal = assertApprovedPlan("30 TON principal", PRINCIPAL);

    equal(
        normal.transferFor("WINNER").grossAtomic,
        28_500_000_000,
        "30 TON: winner gross must be exactly 28.5 TON"
    );

    equal(
        normal.transferFor("OWNER").grossAtomic,
        1_500_000_000,
        "30 TON: owner residual must be exactly 1.5 TON"
    );

    const plusOne = assertApprovedPlan("30 TON + 1 nanaton principal", PRINCIPAL + 1);

    equal(
        plusOne.transferFor("WINNER").grossAtomic,
        28_500_000_000,
        "30 TON + 1 nanaton: the winner share stays floored at 28.5 TON"
    );

    equal(
        plusOne.transferFor("OWNER").grossAtomic,
        1_500_000_001,
        "30 TON + 1 nanaton: the truncated 95 nanotons must stay in the owner residual"
    );

    // A caller-supplied winner allocation in the (provenance-only) allocation
    // record can NEVER override the fixed rule.
    const overridden = RoomPayoutCalculator.computePlan({
        ...base,
        principalAtomic: PRINCIPAL,
        allocation: allocFor({ winnerGrossAllocationAtomic: 1 }),
        networkFees: feeQuotes()
    });

    equal(
        overridden.transferFor("WINNER").grossAtomic,
        28_500_000_000,
        "a caller-supplied winner allocation must never override the fixed 95% rule"
    );

    // --- EXACT ATOMIC RECONCILIATION via the allocation primitive ------------
    for (const principalAtomic of [
        1,
        2,
        999_999_999,
        15_000_000_000,
        PRINCIPAL,
        PRINCIPAL + 1
    ]) {

        const allocated = RoomPayoutCalculator.allocatePrincipal(principalAtomic);

        const expected = approvedSplit(principalAtomic);

        equal(
            allocated.principalAtomic,
            principalAtomic,
            `allocatePrincipal for ${principalAtomic} must echo the settled principal`
        );

        equal(
            allocated.winnerGrossAllocationAtomic,
            expected.winnerGrossAllocationAtomic,
            `allocatePrincipal for ${principalAtomic} must floor the 95% winner share`
        );

        equal(
            allocated.ownerGrossAllocationAtomic,
            expected.ownerGrossAllocationAtomic,
            `allocatePrincipal for ${principalAtomic} must return the exact owner residual`
        );

        equal(
            allocated.safetyMarginAtomic,
            0,
            `the Safety Margin for ${principalAtomic} must be permanently zero`
        );

        equal(
            allocated.winnerGrossAllocationAtomic
                + allocated.ownerGrossAllocationAtomic
                + allocated.safetyMarginAtomic,
            principalAtomic,
            `winner + owner + safety margin must exactly equal ${principalAtomic}`
        );

    }

    // A plan serialization round trip preserves the exact reconciliation AND
    // the provenance of the fixed rule that produced it.
    const { PayoutPlan } = await import("../payment/ledger/PayoutPlan.js");

    const roundTrip = PayoutPlan.fromJSON(normal.toJSON());

    check(roundTrip.reconcile() === true, "a deserialized plan must reconcile exactly");

    equal(
        roundTrip.allocation.ruleId,
        PayoutAllocationConfig.approved().ruleId,
        "a deserialized plan must still identify the approved fixed rule"
    );

    equal(
        roundTrip.transferFor("WINNER").netAtomic,
        28_500_000_000 - WINNER_FEE,
        "a deserialized plan must preserve the winner net exactly"
    );

    equal(
        roundTrip.transferFor("OWNER").netAtomic,
        1_500_000_000 - OWNER_FEE,
        "a deserialized plan must preserve the owner residual net exactly"
    );

    console.log("[11/14] approved-rule boundaries + exact atomic reconciliation: PASS");

}

// ---------------------------------------------------------------------------
// G12 — ledger view: zero reserve, residual owner allocation, exact totals
// ---------------------------------------------------------------------------

{

    const { dataDir, ledger, intentStore } = makeLedger();

    seedConfirmedRoom(ledger, "room-view", intentStore);

    ledger.planPayout({
        payoutId: "pay-view", roomId: "room-view",
        winner: WINNER, owner: OWNER,
        allocation: standardAllocation(),
        networkFees: feeQuotes(),
        nowMs: NOW
    });

    const view = ledger.getRoomLedgerView("room-view");

    equal(view.totalSettledPrincipalAtomic, PRINCIPAL, "the view must report the total settled principal");
    equal(view.winnerGrossAtomic, WINNER_ALLOCATION, "the view must report the authoritative winner gross allocation");
    equal(view.ownerGrossAtomic, PRINCIPAL - WINNER_ALLOCATION, "the view must report the exact owner residual gross");
    equal(
        view.winnerGrossAtomic + view.ownerGrossAtomic,
        PRINCIPAL,
        "the ledger gross allocations must sum exactly to the settled principal"
    );

    equal(view.networkFeesReservedAtomic, WINNER_FEE + OWNER_FEE, "the view must report both reserved fees");
    equal(
        view.netPayoutsAtomic,
        (WINNER_ALLOCATION - WINNER_FEE) + ((PRINCIPAL - WINNER_ALLOCATION) - OWNER_FEE),
        "the view must report both net payouts"
    );

    // THE final reconciliation invariant, evaluated from the ledger:
    //   winnerNetPayoutAtomic + ownerNetPayoutAtomic
    //       + winnerNetworkFeeAtomic + ownerNetworkFeeAtomic
    //       === totalSettledPrincipalAtomic
    equal(
        view.netPayoutsAtomic + view.networkFeesReservedAtomic,
        view.totalSettledPrincipalAtomic,
        "net payouts + network fees must exactly equal the total settled principal"
    );

    // Zero reserve, permanently — and no reserve surface at all.
    equal(view.safetyMarginAtomic, 0, "the Safety Margin must be permanently zero");
    check(
        "reserveAtomic" in view === false
            && "reservePercent" in view === false,
        "the ledger view must not expose any reserve amount"
    );

    const serializedView = JSON.stringify(view);

    check(
        serializedView.includes("reserveAtomic") === false
            && serializedView.includes("reservePercent") === false,
        "a serialized ledger view must never mention a reserve"
    );

    // No RESERVE_ALLOCATION entry kind may exist any more.
    check(
        LEDGER_ENTRY_KIND.RESERVE_ALLOCATION === undefined
            && LEDGER_ENTRY_KIND.OWNER_GROSS_ALLOCATION === "OWNER_GROSS_ALLOCATION",
        "the reserve entry kind must be gone and the owner gross kind must exist"
    );

    rmSync(dataDir, { recursive: true, force: true });

    console.log("[12/14] ledger view: zero reserve + residual owner allocation: PASS");

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
        "ROUNDING_POLICY",
        "RESERVE_ALLOCATION"
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
        + ` | reserve=none`
);

export { checksPassed };
