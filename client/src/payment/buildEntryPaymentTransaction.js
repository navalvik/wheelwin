/**
 * R18-S16 — One TonConnect sendTransaction for full game entry.
 *
 * Assembles server-authoritative component messages. Does not invent
 * amounts, seats, addresses, or StateInit. Does not call TonConnect.
 */

import { buildTonConnectPaymentTransaction } from "./buildTonConnectPaymentTransaction.js";

const DEFAULT_VALID_UNTIL_SECONDS = 600;

/**
 * Display helper. Does not compute stake or fees — only formats a nano total
 * already assembled from authoritative components.
 */
export function nanotonsToTonDisplay(nanotons) {

    if (nanotons == null || nanotons === "") {

        throw new Error("nanotons is required");

    }

    const value = BigInt(nanotons);

    if (value < 0n) {

        throw new Error("nanotons must not be negative");

    }

    const whole = value / 1000000000n;
    const frac = (value % 1000000000n).toString().padStart(9, "0").replace(/0+$/, "");

    return frac.length === 0 ? whole.toString() : `${whole.toString()}.${frac}`;

}

export function sumAuthoritativeEntryNanotons({
    deployValueNanotons = null,
    fundSeatNanotons = null,
    stakeNanotons = null
} = {}) {

    let total = 0n;

    for (const part of [deployValueNanotons, fundSeatNanotons, stakeNanotons]) {

        if (part == null || part === "") {

            continue;

        }

        const asBig = BigInt(part);

        if (asBig <= 0n) {

            throw new Error("entry payment component amounts must be positive");

        }

        total += asBig;

    }

    if (total <= 0n) {

        throw new Error("entry payment total must be a positive amount");

    }

    return total.toString();

}

/**
 * @returns {{ validUntil: number, messages: object[], totalNanotons: string }}
 */
export function buildEntryPaymentTransaction({
    isCreator = false,
    includeDeploy = false,
    includeFund = false,
    includeStake = false,
    depositPackage = null,
    depositAddress = null,
    mySeatIndex = null,
    myExpectedAmountNanotons = null,
    network = null,
    legacyPaymentDestination = null,
    paymentDestination = null,
    requiredGram = null,
    playerIndex = null,
    validUntilSeconds = DEFAULT_VALID_UNTIL_SECONDS,
    nowMs = Date.now()
} = {}) {

    void isCreator;
    void depositPackage;
    void depositAddress;
    void mySeatIndex;
    void myExpectedAmountNanotons;
    void network;
    void legacyPaymentDestination;

    if (includeStake !== true || includeDeploy === true || includeFund === true) {
        throw new Error("Room Wallet entry payment requires the stake component only");
    }

    const stakeTx = buildTonConnectPaymentTransaction({
        paymentDestination,
        requiredGram,
        validUntilSeconds,
        nowMs
    });

    const totalNanotons = stakeTx.messages[0].amount;

    return {
        validUntil: stakeTx.validUntil,
        messages: stakeTx.messages,
        totalNanotons
    };

}
