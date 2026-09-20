/**
 * WheelWin player entry payment.
 *
 * The only player-payment message is a plain TON transfer to the
 * server-authoritative Room Wallet for the current game room.
 * Smart-contract deployment/funding/staking is not a player-payment path.
 */

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
 * TonConnect sendTransaction payload: only SDK-legal keys.
 * `totalNanotons` is display-only and must never be sent to the wallet.
 */
export function toTonConnectSendTransactionRequest(transactionObject = {}) {

    const rawMessages = Array.isArray(transactionObject.messages)
        ? transactionObject.messages
        : [];

    return {
        validUntil: transactionObject.validUntil,
        messages: rawMessages.map((message) => {

            const next = {
                address: message.address,
                amount: message.amount
            };

            if (message.payload != null && message.payload !== "") {

                next.payload = message.payload;

            }

            if (message.stateInit != null && message.stateInit !== "") {

                next.stateInit = message.stateInit;

            }

            return next;

        })
    };

}

/**
 * @returns {{ validUntil: number, messages: object[], totalNanotons: string }}
 */
export function buildEntryPaymentTransaction({
    isCreator = false,
    includeDeploy = false,
    includeFund = false,
    includeStake = false,
    gameEscrowOnly = false,
    depositPackage = null,
    depositAddress = null,
    mySeatIndex = null,
    myExpectedAmountNanotons = null,
    network = null,
    gameEscrowAddress = null,
    paymentDestination = null,
    roomWalletAddress = null,
    requiredGram = null,
    playerIndex = null,
    validUntilSeconds = DEFAULT_VALID_UNTIL_SECONDS,
    nowMs = Date.now()
} = {}) {

    // WheelWin player finance is Room-Wallet-only.
    // DepositContract/GameEscrow payment components are intentionally disabled.
    void gameEscrowOnly;
    void includeDeploy;
    void includeFund;
    void gameEscrowAddress;
    void playerIndex;

    const allowDeploy = false;
    const allowFund = false;
    const allowStake = includeStake === true;

    if (allowDeploy !== true && allowFund !== true && allowStake !== true) {

        throw new Error("entry payment requires at least one authoritative component");

    }

    if (allowDeploy === true && isCreator !== true) {

        throw new Error("Only the Room Creator may include DepositContract deployment");

    }

    const destination = String(paymentDestination ?? roomWalletAddress ?? "").trim();

    if (!destination) {

        throw new Error("Room Wallet address is required for player payment");

    }

    const amount = buildTonConnectPaymentTransaction({
        contractAddress: destination,
        requiredGram,
        plainTransfer: true,
        validUntilSeconds,
        nowMs
    });

    const messages = amount.messages;
    const totalNanotons = amount.messages[0]?.amount ?? "0";

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
