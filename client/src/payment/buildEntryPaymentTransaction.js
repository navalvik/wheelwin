/**
 * R18-S16 — One TonConnect sendTransaction for full game entry.
 *
 * Assembles server-authoritative component messages. Does not invent
 * amounts, seats, addresses, or StateInit. Does not call TonConnect.
 */

import { buildDepositDeploymentTransaction } from "./buildDepositDeploymentTransaction.js";
import { buildFundDepositTransaction } from "./buildFundDepositTransaction.js";
import { buildTonConnectPaymentTransaction } from "./buildTonConnectPaymentTransaction.js";

const DEFAULT_VALID_UNTIL_SECONDS = 600;

function addNanotons(left, right) {

    return (BigInt(left) + BigInt(right)).toString();

}

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
    gameEscrowAddress = null,
    requiredGram = null,
    playerIndex = null,
    validUntilSeconds = DEFAULT_VALID_UNTIL_SECONDS,
    nowMs = Date.now()
} = {}) {

    if (includeDeploy !== true && includeFund !== true && includeStake !== true) {

        throw new Error("entry payment requires at least one authoritative component");

    }

    if (includeDeploy === true && isCreator !== true) {

        throw new Error("Only the Room Creator may include DepositContract deployment");

    }

    const messages = [];
    let totalNanotons = "0";

    if (includeDeploy === true) {

        const deployTx = buildDepositDeploymentTransaction({
            depositPackage,
            depositAddress,
            isCreator: true,
            network,
            validUntilSeconds,
            nowMs
        });

        messages.push(...deployTx.messages);
        totalNanotons = addNanotons(
            totalNanotons,
            deployTx.messages[0].amount
        );

    }

    if (includeFund === true) {

        const fundTx = buildFundDepositTransaction({
            depositAddress,
            mySeatIndex,
            myExpectedAmountNanotons,
            network,
            validUntilSeconds,
            nowMs
        });

        messages.push(...fundTx.messages);
        totalNanotons = addNanotons(
            totalNanotons,
            fundTx.messages[0].amount
        );

    }

    if (includeStake === true) {

        if (playerIndex == null || playerIndex === "") {

            throw new Error("playerIndex is required for GameEscrow STAKE payment");

        }

        const stakeTx = buildTonConnectPaymentTransaction({
            contractAddress: gameEscrowAddress,
            requiredGram,
            playerIndex,
            validUntilSeconds,
            nowMs
        });

        messages.push(...stakeTx.messages);
        totalNanotons = addNanotons(
            totalNanotons,
            stakeTx.messages[0].amount
        );

    }

    const ttl = Number(validUntilSeconds);

    if (!Number.isFinite(ttl) || ttl <= 0) {

        throw new Error("validUntilSeconds must be a positive number");

    }

    return {
        validUntil: Math.floor(Number(nowMs) / 1000) + ttl,
        messages,
        totalNanotons
    };

}
