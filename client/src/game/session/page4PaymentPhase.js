/**
 * Page4 payment-phase coordinator.
 *
 * Active gameplay payment architecture: direct transfer from each player
 * wallet to the authoritative Room Wallet. No gameplay smart-contract path
 * is selected by this module.
 */

import {
    canConfirmLocalPayment,
    hasPaymentSession
} from "./authoritativePaymentSessionView.js";
import { DEPOSIT_SESSION_STATUS } from "./depositSessionStatus.js";

export const PAGE4_PAYMENT_PHASE = Object.freeze({
    WALLET: "WALLET",
    DEPOSIT_DEPLOY: "DEPOSIT_DEPLOY",
    DEPOSIT_ACTIVATION: "DEPOSIT_ACTIVATION",
    FUND_SEAT: "FUND_SEAT",
    DEPOSIT_WAIT_FULL: "DEPOSIT_WAIT_FULL",
    DEPOSIT_FULL: "DEPOSIT_FULL",
    ENTRY_PAYMENT: "ENTRY_PAYMENT",
    WAITING_PAGE5: "WAITING_PAGE5"
});

export const DEPOSIT_ACTIVATION_VERIFIED_STATUSES = Object.freeze([
    "VERIFIED",
    "ALREADY_VERIFIED"
]);

export function resolvePlayerPaymentDestination({
    paymentSession = null
} = {}) {
    const address = String(paymentSession?.roomWalletAddress ?? "").trim();
    return address || null;
}

function isRoomWalletPaymentSession(paymentSession = null) {
    return Boolean(String(paymentSession?.roomWalletAddress ?? "").trim());
}

function hasLegacyDepositPackage(deposit = null) {
    if (!deposit || typeof deposit !== "object") return false;
    const depositId = String(deposit.depositId ?? "").trim();
    const depositAddress = String(deposit.depositAddress ?? "").trim();
    const pkg = deposit.package && typeof deposit.package === "object" ? deposit.package : null;
    const hasStateInit = Boolean(
        pkg?.stateInit?.codeBoc || pkg?.stateInit?.dataBoc
        || pkg?.stateInitBocB64 || pkg?.codeBocB64 || pkg?.dataBocB64
    );
    const deployValue = Number(pkg?.deployValueNanotons);
    return Boolean(depositId || depositAddress || hasStateInit
        || (Number.isFinite(deployValue) && deployValue > 0));
}

export function isDepositActivationVerified(deposit = null, lifecycle = null) {
    return DEPOSIT_ACTIVATION_VERIFIED_STATUSES.includes(deposit?.activationStatus)
        || lifecycle?.depositActivationVerified === true;
}

export function isDepositFull(deposit = null) {
    const phase = deposit?.phase ?? null;
    if (
        phase === DEPOSIT_SESSION_STATUS.DEPOSIT_FULL
        || phase === DEPOSIT_SESSION_STATUS.DEPLOY_AUTHORIZED
        || phase === DEPOSIT_SESSION_STATUS.GAME_CONTRACT_CREATED
    ) return true;
    const confirmed = Number(deposit?.confirmedSeats);
    return Number.isFinite(confirmed) && confirmed >= 3;
}

export function canDeployDeposit(deposit = null, lifecycle = null) {
    if (isDepositActivationVerified(deposit, lifecycle)) return false;
    return deposit?.isCreator === true
        && Boolean(deposit?.package?.stateInit?.codeBoc)
        && Boolean(deposit?.package?.stateInit?.dataBoc)
        && deposit?.package?.deployValueNanotons != null
        && Boolean(deposit?.depositAddress);
}

export function canFundSeat(deposit = null, lifecycle = null) {
    if (!isDepositActivationVerified(deposit, lifecycle)) return false;
    if (deposit?.mySeatStatus === "FUNDED" || deposit?.mySeatIndex == null) return false;
    const seatIndex = Number(deposit.mySeatIndex);
    return Number.isInteger(seatIndex) && seatIndex >= 0 && seatIndex <= 2
        && deposit?.myExpectedAmountNanotons != null
        && Boolean(deposit?.depositAddress);
}

export function canStakeGameEscrow({ paymentSession = null, localPlayerId = null } = {}) {
    return canConfirmLocalPayment(paymentSession, localPlayerId)
        && Boolean(resolvePlayerPaymentDestination({ paymentSession, localPlayerId }));
}

function hasFundSeatInputs(deposit = null) {
    if (deposit?.mySeatStatus === "FUNDED" || deposit?.mySeatIndex == null) return false;
    const seatIndex = Number(deposit.mySeatIndex);
    return Number.isInteger(seatIndex) && seatIndex >= 0 && seatIndex <= 2
        && deposit?.myExpectedAmountNanotons != null
        && Boolean(deposit?.depositAddress);
}

export function canIncludeFundSeatInEntry(deposit = null, lifecycle = null) {
    if (!hasFundSeatInputs(deposit)) return false;
    if (deposit?.isCreator === true && canDeployDeposit(deposit, lifecycle)) return true;
    return canFundSeat(deposit, lifecycle);
}

export function resolveEntryPaymentComponents({
    deposit = null,
    paymentSession = null,
    localPlayerId = null,
    lifecycle = null
} = {}) {
    if (isRoomWalletPaymentSession(paymentSession)) {
        return Object.freeze({
            includeDeploy: false,
            includeFund: false,
            includeStake: canConfirmLocalPayment(paymentSession, localPlayerId)
        });
    }

    return Object.freeze({
        includeDeploy: canDeployDeposit(deposit, lifecycle),
        includeFund: canIncludeFundSeatInEntry(deposit, lifecycle),
        includeStake: false
    });
}

export function canSubmitEntryPayment({
    deposit = null,
    paymentSession = null,
    localPlayerId = null
} = {}) {
    if (!isRoomWalletPaymentSession(paymentSession)) return false;
    return canConfirmLocalPayment(paymentSession, localPlayerId)
        && Boolean(resolvePlayerPaymentDestination({ paymentSession, localPlayerId }));
}

export function resolvePage4PaymentPhase({
    deposit = null,
    paymentSession = null,
    paymentConnectionReady = false,
    localPlayerId = null,
    lifecycle = null
} = {}) {
    void deposit;
    void paymentConnectionReady;
    void lifecycle;

    if (paymentSession?.status === "FULLY_PAID" || paymentSession?.status === "COMPLETED") {
        return PAGE4_PAYMENT_PHASE.WAITING_PAGE5;
    }

    if (isRoomWalletPaymentSession(paymentSession)) {
        return canSubmitEntryPayment({ paymentSession, localPlayerId })
            ? PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT
            : PAGE4_PAYMENT_PHASE.WALLET;
    }

    if (hasPaymentSession(paymentSession)) {
        return PAGE4_PAYMENT_PHASE.WALLET;
    }

    return PAGE4_PAYMENT_PHASE.WALLET;
}

export function shouldShowWaitingCreatorDeposit() {
    return false;
}

export function shouldShowWalletActions(phase) {
    return phase === PAGE4_PAYMENT_PHASE.WALLET;
}

export function shouldShowPaymentSessionRows(phase) {
    return phase === PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT
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
