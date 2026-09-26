/**
 * Page4 payment-phase coordinator.
 *
 * Active architecture: direct player-to-Room-Wallet payment only.
 */
import {
    canConfirmLocalPayment,
    hasPaymentSession
} from "./authoritativePaymentSessionView.js";

export const PAGE4_PAYMENT_PHASE = Object.freeze({
    WALLET: "WALLET",
    ENTRY_PAYMENT: "ENTRY_PAYMENT",
    WAITING_PAGE5: "WAITING_PAGE5"
});

export function resolvePlayerPaymentDestination({ paymentSession = null } = {}) {
    const address = String(paymentSession?.roomWalletAddress ?? "").trim();
    return address || null;
}

export function isRoomWalletPaymentSession(paymentSession = null) {
    return Boolean(resolvePlayerPaymentDestination({ paymentSession }));
}

export function canSubmitRoomWalletPayment({
    paymentSession = null,
    localPlayerId = null
} = {}) {
    return canConfirmLocalPayment(paymentSession, localPlayerId)
        && isRoomWalletPaymentSession(paymentSession);
}

export function canSubmitEntryPayment({
    paymentSession = null,
    localPlayerId = null
} = {}) {
    return canSubmitRoomWalletPayment({ paymentSession, localPlayerId });
}

export function resolveEntryPaymentComponents({
    paymentSession = null,
    localPlayerId = null
} = {}) {
    return Object.freeze({
        includeDeploy: false,
        includeFund: false,
        includeStake: isRoomWalletPaymentSession(paymentSession)
            && canConfirmLocalPayment(paymentSession, localPlayerId)
    });
}

// Retained as compatibility no-ops for callers outside Page4.
export function canDeployDeposit() { return false; }
export function canFundSeat() { return false; }
export function canIncludeFundSeatInEntry() { return false; }
export function isDepositActivationVerified() { return false; }
export function isDepositFull() { return false; }
export function shouldShowDepositAction() { return false; }

export function resolvePage4PaymentPhase({
    paymentSession = null,
    localPlayerId = null
} = {}) {
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

export function shouldShowStakeAction(phase) {
    return phase === PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT;
}

export function shouldShowEntryAction(phase) {
    return phase === PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT;
}
