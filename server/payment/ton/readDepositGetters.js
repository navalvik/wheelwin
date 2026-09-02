/**
 * R17.9L.14 — Full Deposit Contract getter read (testnet verification).
 */
import { Address } from "@ton/core";

import { canonicalizeTonWalletAddress } from "../../models/TonWalletAddress.js";
import { InvalidResponseError } from "../../services/ton/TonServiceErrors.js";

function toFriendly(value) {

    if (value instanceof Address) {

        return value.toString({ bounceable: true, urlSafe: true });

    }

    if (typeof value === "string" && value.trim()) {

        return canonicalizeTonWalletAddress(value.trim()) ?? value.trim();

    }

    return null;

}

function readInt(result, method) {

    if (result && typeof result.exit_code === "number" && result.exit_code !== 0) {

        throw new InvalidResponseError(
            `Deposit getter ${method} failed | exit_code=${result.exit_code}`
        );

    }

    const stack = result?.stack;

    if (stack && typeof stack.readBigNumber === "function") {

        return stack.readBigNumber();

    }

    throw new InvalidResponseError(`Deposit getter ${method} returned invalid integer`);

}

function readAddress(result, method) {

    if (result && typeof result.exit_code === "number" && result.exit_code !== 0) {

        throw new InvalidResponseError(
            `Deposit getter ${method} failed | exit_code=${result.exit_code}`
        );

    }

    const stack = result?.stack;

    if (stack && typeof stack.readAddress === "function") {

        return toFriendly(stack.readAddress());

    }

    throw new InvalidResponseError(`Deposit getter ${method} returned invalid address`);

}

const INT_GETTERS = Object.freeze([
    "get_version",
    "get_deposit_id",
    "get_room_id_hash",
    "get_game_id_hash",
    "get_expected_stake0",
    "get_expected_stake1",
    "get_expected_stake2",
    "get_creation_fee_per_seat",
    "get_expected_amount0",
    "get_expected_amount1",
    "get_expected_amount2",
    "get_paid_mask",
    "get_status",
    "get_credited_amount0",
    "get_credited_amount1",
    "get_credited_amount2",
    "get_surplus_nano",
    "get_expires_at",
    "get_network_tag",
    "get_refund_mask",
    "get_total_credited"
]);

const ADDRESS_GETTERS = Object.freeze([
    "get_player0",
    "get_player1",
    "get_player2",
    "get_release_authority",
    "get_released_to"
]);

export async function readFullDepositGetters(tonService, address) {

    const ints = {};
    const addresses = {};

    for (const method of INT_GETTERS) {

        ints[method] = readInt(
            await tonService.runGetMethod(address, method, []),
            method
        );

    }

    for (const method of ADDRESS_GETTERS) {

        addresses[method] = readAddress(
            await tonService.runGetMethod(address, method, []),
            method
        );

    }

    return Object.freeze({
        contractVersion: ints.get_version,
        depositIdHash: ints.get_deposit_id,
        roomIdHash: ints.get_room_id_hash,
        gameIdHash: ints.get_game_id_hash,
        player0: addresses.get_player0,
        player1: addresses.get_player1,
        player2: addresses.get_player2,
        expectedStake0: ints.get_expected_stake0,
        expectedStake1: ints.get_expected_stake1,
        expectedStake2: ints.get_expected_stake2,
        creationFeePerSeat: ints.get_creation_fee_per_seat,
        expectedAmount0: ints.get_expected_amount0,
        expectedAmount1: ints.get_expected_amount1,
        expectedAmount2: ints.get_expected_amount2,
        paidMask: ints.get_paid_mask,
        status: ints.get_status,
        creditedAmount0: ints.get_credited_amount0,
        creditedAmount1: ints.get_credited_amount1,
        creditedAmount2: ints.get_credited_amount2,
        surplusNano: ints.get_surplus_nano,
        expiresAt: ints.get_expires_at,
        releaseAuthority: addresses.get_release_authority,
        networkTag: ints.get_network_tag,
        releasedTo: addresses.get_released_to,
        refundMask: ints.get_refund_mask,
        totalCredited: ints.get_total_credited
    });

}

/**
 * First bound Deposit seat is the Room Creator (projectDepositForPlayer).
 * paidMask bit 0 is that seat. Not a player nickname or wallet.
 */
export const CREATOR_SEAT_INDEX = 0;
export const CREATOR_SEAT_PAID_MASK = 1 << CREATOR_SEAT_INDEX;

function toNanoBigInt(value) {

    if (value == null || value === "") {

        return null;

    }

    if (typeof value === "bigint") {

        return value;

    }

    if (typeof value === "number") {

        if (!Number.isFinite(value) || !Number.isInteger(value)) {

            return null;

        }

        return BigInt(value);

    }

    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {

        return BigInt(value.trim());

    }

    return null;

}

/**
 * Creator FundSeat nanotons from the authoritative activation plan:
 * expectedStake of seat 0 + creationFeePerSeat. Not a hardcoded amount.
 */
export function creatorFundSeatNanotonsFromPlan(plan) {

    if (!plan || typeof plan !== "object") {

        throw new Error("activation plan is required for creator FundSeat amount");

    }

    const fee = toNanoBigInt(plan.creationFeePerSeat);

    if (fee == null || fee <= 0n) {

        throw new Error("creationFeePerSeat is required for creator FundSeat amount");

    }

    const stake0 = toNanoBigInt(
        plan.bindings?.[CREATOR_SEAT_INDEX]?.expectedStake
            ?? plan.bindings?.[CREATOR_SEAT_INDEX]?.expectedAmount
            ?? plan.expectedStake0
    );

    if (stake0 == null || stake0 <= 0n) {

        throw new Error("creator expectedStake is required for creator FundSeat amount");

    }

    return stake0 + fee;

}

function isReleasedToZero(releasedTo) {

    if (!releasedTo) {

        return true;

    }

    return releasedTo === getZeroFriendly();

}

export function assertInitialMutableState(getters) {

    const failures = [];

    if (Number(getters.status) !== 1) {

        failures.push(`status=${getters.status}`);

    }

    if (Number(getters.paidMask) !== 0) {

        failures.push(`paidMask=${getters.paidMask}`);

    }

    for (const field of [
        "creditedAmount0",
        "creditedAmount1",
        "creditedAmount2",
        "surplusNano",
        "refundMask",
        "totalCredited"
    ]) {

        if (getters[field] !== 0n && Number(getters[field]) !== 0) {

            failures.push(`${field}=${getters[field]}`);

        }

    }

    if (!isReleasedToZero(getters.releasedTo)) {

        failures.push(`releasedTo=${getters.releasedTo}`);

    }

    if (failures.length) {

        throw new Error(`Initial mutable state mismatch | ${failures.join(", ")}`);

    }

    return true;

}

/**
 * Legitimate creator one-wallet FundSeat after deploy:
 * PARTIALLY_FUNDED, only creator seat paid, creditedAmount0 == plan FundSeat.
 * Other partial/funded shapes remain invalid.
 */
export function isCreatorOneWalletFundSeatMutableState(getters, plan) {

    if (!getters || typeof getters !== "object" || !plan) {

        return false;

    }

    let expectedCredit;

    try {

        expectedCredit = creatorFundSeatNanotonsFromPlan(plan);

    } catch {

        return false;

    }

    if (Number(getters.status) !== 2) {

        return false;

    }

    if (Number(getters.paidMask) !== CREATOR_SEAT_PAID_MASK) {

        return false;

    }

    const credited0 = toNanoBigInt(getters.creditedAmount0);
    const credited1 = toNanoBigInt(getters.creditedAmount1) ?? 0n;
    const credited2 = toNanoBigInt(getters.creditedAmount2) ?? 0n;
    const total = toNanoBigInt(getters.totalCredited);
    const surplus = toNanoBigInt(getters.surplusNano) ?? 0n;
    const refundMask = Number(getters.refundMask);

    if (credited0 !== expectedCredit) {

        return false;

    }

    if (credited1 !== 0n || credited2 !== 0n) {

        return false;

    }

    if (total !== expectedCredit) {

        return false;

    }

    if (surplus !== 0n || refundMask !== 0) {

        return false;

    }

    return isReleasedToZero(getters.releasedTo);

}

/**
 * Mutable state that may become VERIFIED: empty AWAITING_FUNDS, or the
 * creator one-wallet FundSeat shape derived from the activation plan.
 */
export function assertActivableMutableState(getters, plan) {

    try {

        return assertInitialMutableState(getters);

    } catch (emptyError) {

        if (isCreatorOneWalletFundSeatMutableState(getters, plan)) {

            return true;

        }

        throw emptyError;

    }

}

function hexToBigInt(hex) {

    return BigInt(`0x${String(hex).replace(/^0x/i, "")}`);

}

function sameAddress(left, right) {

    const a = canonicalizeTonWalletAddress(left) || String(left ?? "").trim();
    const b = canonicalizeTonWalletAddress(right) || String(right ?? "").trim();

    return Boolean(a) && a === b;

}

export function assertImmutableGettersMatchPlan(getters, plan) {

    const failures = [];
    const fee = BigInt(plan.creationFeePerSeat);
    const stake0 = BigInt(plan.expectedStake0);
    const stake1 = BigInt(plan.expectedStake1);
    const stake2 = BigInt(plan.expectedStake2);

    const expected = {
        contractVersion: BigInt(plan.contractVersion),
        depositIdHash: hexToBigInt(plan.depositIdHash),
        roomIdHash: hexToBigInt(plan.roomIdHash),
        gameIdHash: hexToBigInt(plan.gameIdHash),
        expectedStake0: stake0,
        expectedStake1: stake1,
        expectedStake2: stake2,
        creationFeePerSeat: fee,
        expectedAmount0: stake0 + fee,
        expectedAmount1: stake1 + fee,
        expectedAmount2: stake2 + fee,
        expiresAt: BigInt(plan.expiresAt),
        networkTag: BigInt(plan.networkTag)
    };

    for (const [field, value] of Object.entries(expected)) {

        if (BigInt(getters[field]) !== value) {

            failures.push(`${field}`);

        }

    }

    if (!sameAddress(getters.player0, plan.player0)) {

        failures.push("player0");

    }

    if (!sameAddress(getters.player1, plan.player1)) {

        failures.push("player1");

    }

    if (!sameAddress(getters.player2, plan.player2)) {

        failures.push("player2");

    }

    if (!sameAddress(getters.releaseAuthority, plan.releaseAuthority)) {

        failures.push("releaseAuthority");

    }

    if (failures.length) {

        throw new Error(`Immutable getter mismatch | ${failures.join(", ")}`);

    }

    return true;

}

function getZeroFriendly() {

    return new Address(0, Buffer.alloc(32)).toString({
        bounceable: true,
        urlSafe: true
    });

}
