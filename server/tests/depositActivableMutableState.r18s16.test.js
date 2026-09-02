/**
 * R18-S16 — Activable Deposit mutable state after creator one-wallet FundSeat.
 * Stub getters only. No live TON, no hardcoded FundSeat amount.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    assertActivableMutableState,
    assertInitialMutableState,
    creatorFundSeatNanotonsFromPlan,
    CREATOR_SEAT_PAID_MASK,
    isCreatorOneWalletFundSeatMutableState
} from "../payment/ton/readDepositGetters.js";

const STAKE_NANO = 10_000_000n;
const FEE_NANO = 1_000_000n;

function planFromConfig({
    stake0 = STAKE_NANO,
    fee = FEE_NANO
} = {}) {

    return {
        creationFeePerSeat: fee,
        bindings: [
            { expectedStake: stake0, expectedAmount: Number(stake0) }
        ]
    };

}

function emptyGetters() {

    return {
        status: 1,
        paidMask: 0,
        creditedAmount0: 0n,
        creditedAmount1: 0n,
        creditedAmount2: 0n,
        surplusNano: 0n,
        refundMask: 0,
        totalCredited: 0n,
        releasedTo: null
    };

}

function creatorFundSeatGetters(plan, overrides = {}) {

    const credit = creatorFundSeatNanotonsFromPlan(plan);

    return {
        status: 2,
        paidMask: CREATOR_SEAT_PAID_MASK,
        creditedAmount0: credit,
        creditedAmount1: 0n,
        creditedAmount2: 0n,
        surplusNano: 0n,
        refundMask: 0,
        totalCredited: credit,
        releasedTo: null,
        ...overrides
    };

}

test("R18-S16: creator FundSeat nanotons come from plan stake + fee", () => {

    const plan = planFromConfig({ stake0: 25_000_000n, fee: 2_000_000n });

    assert.equal(creatorFundSeatNanotonsFromPlan(plan), 27_000_000n);

});

test("R18-S16: empty AWAITING_FUNDS remains activable", () => {

    const plan = planFromConfig();

    assert.equal(assertInitialMutableState(emptyGetters()), true);
    assert.equal(assertActivableMutableState(emptyGetters(), plan), true);

});

test("R18-S16: creator one-wallet FundSeat mutable state is activable", () => {

    const plan = planFromConfig();
    const getters = creatorFundSeatGetters(plan);

    assert.equal(isCreatorOneWalletFundSeatMutableState(getters, plan), true);
    assert.equal(assertActivableMutableState(getters, plan), true);
    assert.throws(() => assertInitialMutableState(getters), /status=2|paidMask=1/);

});

test("R18-S16: wrong credited amount is not creator one-wallet state", () => {

    const plan = planFromConfig();
    const getters = creatorFundSeatGetters(plan, {
        creditedAmount0: STAKE_NANO,
        totalCredited: STAKE_NANO
    });

    assert.equal(isCreatorOneWalletFundSeatMutableState(getters, plan), false);
    assert.throws(() => assertActivableMutableState(getters, plan), /Initial mutable state mismatch/);

});

test("R18-S16: non-creator paidMask is not creator one-wallet state", () => {

    const plan = planFromConfig();
    const getters = creatorFundSeatGetters(plan, { paidMask: 2 });

    assert.equal(isCreatorOneWalletFundSeatMutableState(getters, plan), false);
    assert.throws(() => assertActivableMutableState(getters, plan), /paidMask=2/);

});

test("R18-S16: second-seat credit is not creator one-wallet state", () => {

    const plan = planFromConfig();
    const credit = creatorFundSeatNanotonsFromPlan(plan);
    const getters = creatorFundSeatGetters(plan, {
        creditedAmount1: credit,
        totalCredited: credit + credit
    });

    assert.equal(isCreatorOneWalletFundSeatMutableState(getters, plan), false);
    assert.throws(() => assertActivableMutableState(getters, plan), /Initial mutable state mismatch/);

});
