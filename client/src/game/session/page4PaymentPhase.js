/**
 * R18-S16 — Page4 payment-phase coordinator (pure).
 * Mirrors server-authoritative Deposit / GameEscrow state. Does not invent
 * funding, activation, or Page5 navigation.
 */

import {
    canConfirmLocalPayment,
    hasPaymentSession
} from "./authoritativePaymentSessionView.js";
import { isGameContractDeployed } from "./authoritativeGameContractView.js";
import { DEPOSIT_SESSION_STATUS } from "./depositSessionStatus.js";

export const PAGE4_PAYMENT_PHASE = Object.freeze({
    WALLET: "WALLET",
    DEPOSIT_DEPLOY: "DEPOSIT_DEPLOY",
    DEPOSIT_ACTIVATION: "DEPOSIT_ACTIVATION",
    FUND_SEAT: "FUND_SEAT",
    DEPOSIT_WAIT_FULL: "DEPOSIT_WAIT_FULL",
    DEPOSIT_FULL: "DEPOSIT_FULL",
    GAMEESCROW_STAKE: "GAMEESCROW_STAKE",
    WAITING_PAGE5: "WAITING_PAGE5"
});

export const DEPOSIT_ACTIVATION_VERIFIED_STATUSES = Object.freeze([
    "VERIFIED",
    "ALREADY_VERIFIED"
]);

export function isDepositActivationVerified(deposit = null, lifecycle = null) {

    const status = deposit?.activationStatus ?? null;

    if (DEPOSIT_ACTIVATION_VERIFIED_STATUSES.includes(status)) {

        return true;

    }

    return lifecycle?.depositActivationVerified === true;

}

export function isDepositFull(deposit = null) {

    const phase = deposit?.phase ?? null;

    if (
        phase === DEPOSIT_SESSION_STATUS.DEPOSIT_FULL
        || phase === DEPOSIT_SESSION_STATUS.DEPLOY_AUTHORIZED
        || phase === DEPOSIT_SESSION_STATUS.GAME_CONTRACT_CREATED
    ) {

        return true;

    }

    const confirmed = Number(deposit?.confirmedSeats);

    return Number.isFinite(confirmed) && confirmed >= 3;

}

export function canDeployDeposit(deposit = null, lifecycle = null) {

    if (isDepositActivationVerified(deposit, lifecycle)) {

        return false;

    }

    return deposit?.isCreator === true
        && Boolean(deposit?.package?.stateInit?.codeBoc)
        && Boolean(deposit?.package?.stateInit?.dataBoc)
        && deposit?.package?.deployValueNanotons != null
        && Boolean(deposit?.depositAddress);

}

export function canFundSeat(deposit = null, lifecycle = null) {

    if (!isDepositActivationVerified(deposit, lifecycle)) {

        return false;

    }

    if (deposit?.mySeatStatus === "FUNDED") {

        return false;

    }

    if (deposit?.mySeatIndex == null) {

        return false;

    }

    const seatIndex = Number(deposit.mySeatIndex);

    return Number.isInteger(seatIndex)
        && seatIndex >= 0
        && seatIndex <= 2
        && deposit?.myExpectedAmountNanotons != null
        && Boolean(deposit?.depositAddress);

}

export function canStakeGameEscrow({
    paymentSession = null,
    gameContract = null,
    localPlayerId = null
} = {}) {

    return canConfirmLocalPayment(paymentSession, localPlayerId)
        && isGameContractDeployed(gameContract);

}

/**
 * PAYMENT_CONNECTION_READY must not select GAMEESCROW_STAKE.
 * GameEscrow STAKE only after the GameEscrow is deployed.
 */
export function resolvePage4PaymentPhase({
    deposit = null,
    paymentSession = null,
    gameContract = null,
    paymentConnectionReady = false,
    lifecycle = null
} = {}) {

    if (paymentSession?.status === "COMPLETED") {

        return PAGE4_PAYMENT_PHASE.WAITING_PAGE5;

    }

    if (isGameContractDeployed(gameContract)) {

        return PAGE4_PAYMENT_PHASE.GAMEESCROW_STAKE;

    }

    if (isDepositFull(deposit)) {

        return PAGE4_PAYMENT_PHASE.DEPOSIT_FULL;

    }

    if (isDepositActivationVerified(deposit, lifecycle)) {

        if (deposit?.mySeatStatus === "FUNDED") {

            return PAGE4_PAYMENT_PHASE.DEPOSIT_WAIT_FULL;

        }

        return PAGE4_PAYMENT_PHASE.FUND_SEAT;

    }

    if (canDeployDeposit(deposit, lifecycle)) {

        return PAGE4_PAYMENT_PHASE.DEPOSIT_DEPLOY;

    }

    if (deposit || paymentConnectionReady || hasPaymentSession(paymentSession)) {

        return PAGE4_PAYMENT_PHASE.DEPOSIT_ACTIVATION;

    }

    return PAGE4_PAYMENT_PHASE.WALLET;

}

export function shouldShowWalletActions(phase) {

    return phase === PAGE4_PAYMENT_PHASE.WALLET;

}

export function shouldShowPaymentSessionRows(phase) {

    return phase === PAGE4_PAYMENT_PHASE.GAMEESCROW_STAKE
        || phase === PAGE4_PAYMENT_PHASE.WAITING_PAGE5;

}

export function shouldShowDepositAction(phase) {

    return phase === PAGE4_PAYMENT_PHASE.DEPOSIT_DEPLOY
        || phase === PAGE4_PAYMENT_PHASE.FUND_SEAT;

}

export function shouldShowStakeAction(phase) {

    return phase === PAGE4_PAYMENT_PHASE.GAMEESCROW_STAKE;

}
