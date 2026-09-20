/**
 * Page4 payment-phase coordinator (pure).
 * Player entry payment is a plain TON transfer to the server-selected
 * Room Wallet for the current room. Smart-contract payment destinations
 * are not valid player-payment fallbacks.
 */

import {
    canConfirmLocalPayment,
    hasPaymentSession
} from "./authoritativePaymentSessionView.js";

export const PAGE4_PAYMENT_PHASE = Object.freeze({
    WALLET: "WALLET",
    DEPOSIT_DEPLOY: "DEPOSIT_DEPLOY",
    DEPOSIT_ACTIVATION: "DEPOSIT_ACTIVATION",
    FUND_SEAT: "FUND_SEAT",
    DEPOSIT_WAIT_FULL: "DEPOSIT_WAIT_FULL",
    DEPOSIT_FULL: "DEPOSIT_FULL",
    GAMEESCROW_STAKE: "GAMEESCROW_STAKE",
    ENTRY_PAYMENT: "ENTRY_PAYMENT",
    WAITING_PAGE5: "WAITING_PAGE5"
});

export const DEPOSIT_ACTIVATION_VERIFIED_STATUSES = Object.freeze([
    "VERIFIED",
    "ALREADY_VERIFIED"
]);

function hasLegacyDepositPackage(deposit = null) {

    if (!deposit || typeof deposit !== "object") {

        return false;

    }

    const depositId = String(deposit.depositId ?? "").trim();
    const depositAddress = String(deposit.depositAddress ?? "").trim();
    const pkg = deposit.package && typeof deposit.package === "object"
        ? deposit.package
        : null;
    const hasStateInit = Boolean(
        pkg?.stateInit?.codeBoc
        || pkg?.stateInit?.dataBoc
        || pkg?.stateInitBocB64
        || pkg?.codeBocB64
        || pkg?.dataBocB64
    );
    const deployValue = Number(pkg?.deployValueNanotons);

    return Boolean(depositId)
        || Boolean(depositAddress)
        || hasStateInit
        || (Number.isFinite(deployValue) && deployValue > 0);

}

function paymentSessionRoomWalletTarget(paymentSession = null) {
    return String(paymentSession?.roomWalletAddress ?? "").trim();
}

export function resolvePlayerPaymentDestination({
    paymentSession = null,
    localPlayerId = null
} = {}) {

    void localPlayerId;

    const sessionAddress = paymentSessionRoomWalletTarget(paymentSession);

    return sessionAddress || null;

}

function depositOwnedByCurrentSession(deposit, context = null, gameContract = null) {

    if (!deposit) {

        return null;

    }

    const roomId = context?.roomId
        ?? context?.paymentSession?.roomId
        ?? gameContract?.roomId
        ?? null;
    const gameId = context?.gameId
        ?? context?.paymentSession?.gameId
        ?? gameContract?.gameId
        ?? null;

    if (
        deposit.roomId
        && roomId
        && String(deposit.roomId) !== String(roomId)
    ) {

        return null;

    }

    if (
        deposit.gameId
        && gameId
        && String(deposit.gameId) !== String(gameId)
    ) {

        return null;

    }

    return deposit;

}

/**
 * Room-Wallet-only player payment.
 * The server must publish `paymentSession.roomWalletAddress`.
 * A participant `contractAddress` is never a payment fallback.
 */
export function isGameEscrowOnlyPlayerPayment(gameContract = null, context = null) {

    void gameContract;
    void context;

    // Smart-contract player-payment modes are disabled. Room Wallet is the
    // only accepted financial path on both Testnet and Mainnet.
    return true;

}

export function shouldShowWaitingCreatorDeposit() {

    return false;

}

export function isDepositActivationVerified() {

    return false;

}

export function isDepositFull() {

    return false;

}

export function canDeployDeposit() {

    return false;

}

export function canFundSeat() {

    return false;

}

export function canStakeGameEscrow({
    paymentSession = null,
    gameContract = null,
    localPlayerId = null
} = {}) {

    void gameContract;

    return canConfirmLocalPayment(paymentSession, localPlayerId)
        && Boolean(resolvePlayerPaymentDestination({
            paymentSession,
            localPlayerId
        }));

}


export function canIncludeFundSeatInEntry() {

    return false;

}

export function resolveEntryPaymentComponents({
    paymentSession = null,
    gameContract = null,
    localPlayerId = null
} = {}) {

    return Object.freeze({
        includeDeploy: false,
        includeFund: false,
        includeStake: canStakeGameEscrow({
            paymentSession,
            gameContract,
            localPlayerId
        })
    });

}

export function canSubmitEntryPayment({
    paymentSession = null,
    gameContract = null,
    localPlayerId = null
} = {}) {

    return canStakeGameEscrow({
        paymentSession,
        gameContract,
        localPlayerId
    });

}

/**
 * PAYMENT_CONNECTION_READY must not select GAMEESCROW_STAKE / ENTRY_PAYMENT
 * on the legacy Deposit path. Game Escrow-only waits for server deploy, then
 * every player with a STAKE obligation gets the same payment action.
 */
export function resolvePage4PaymentPhase({
    paymentSession = null,
    gameContract = null,
    paymentConnectionReady = false,
    localPlayerId = null
} = {}) {

    if (paymentSession?.status === "COMPLETED") {

        return PAGE4_PAYMENT_PHASE.WAITING_PAGE5;

    }

    if (canSubmitEntryPayment({ paymentSession, gameContract, localPlayerId })) {

        return PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT;

    }

    if (
        Boolean(resolvePlayerPaymentDestination({ paymentSession, localPlayerId }))
        || hasPaymentSession(paymentSession)
        || paymentConnectionReady
    ) {

        return PAGE4_PAYMENT_PHASE.GAMEESCROW_STAKE;

    }

    return PAGE4_PAYMENT_PHASE.WALLET;

}

export function shouldShowWalletActions(phase) {

    return phase === PAGE4_PAYMENT_PHASE.WALLET;

}

export function shouldShowPaymentSessionRows(phase) {

    return phase === PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT
        || phase === PAGE4_PAYMENT_PHASE.GAMEESCROW_STAKE
        || phase === PAGE4_PAYMENT_PHASE.WAITING_PAGE5;

}

export function shouldShowDepositAction() {

    return false;

}

export function shouldShowStakeAction(phase) {

    return phase === PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT;

}

export function shouldShowEntryAction(phase) {

    return phase === PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT;

}
