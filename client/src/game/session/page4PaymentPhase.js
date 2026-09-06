/**
 * R18-S16 — Page4 payment-phase coordinator (pure).
 * Game Escrow (`escrowMode=game`): STAKE only, equal for all players.
 * Legacy v4 / Deposit path: creator deploy + FundSeat + STAKE.
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

function paymentSessionGameEscrowTarget(paymentSession = null) {

    const participants = Array.isArray(paymentSession?.participants)
        ? paymentSession.participants
        : [];

    for (const participant of participants) {

        const address = String(participant?.contractAddress ?? "").trim();
        const required = Number(participant?.requiredGram);

        if (address && Number.isFinite(required) && required > 0) {

            return address;

        }

    }

    return "";

}

/**
 * Game-Escrow-only player payment (`GAME_ESCROW_MODE=game`).
 * Prefer explicit `escrowMode`, then infer from server payment state when
 * Production clients never received `escrowMode` on the contract mirror.
 * Do not infer while a real Deposit package is present (legacy `v4`).
 */
export function isGameEscrowOnlyPlayerPayment(gameContract = null, context = null) {

    const mode = String(gameContract?.escrowMode ?? "").trim().toLowerCase();

    if (mode === "game") {

        return true;

    }

    if (mode === "v4") {

        return false;

    }

    const deposit = context?.deposit ?? null;
    const paymentSession = context?.paymentSession ?? null;
    const paymentTarget = paymentSessionGameEscrowTarget(paymentSession);

    if (hasLegacyDepositPackage(deposit)) {

        return false;

    }

    if (paymentTarget) {

        return true;

    }

    return isGameContractDeployed(gameContract);

}

export function shouldShowWaitingCreatorDeposit({
    paymentPhase = null,
    gameContract = null,
    deposit = null,
    paymentSession = null
} = {}) {

    if (paymentPhase !== PAGE4_PAYMENT_PHASE.DEPOSIT_ACTIVATION) {

        return false;

    }

    if (isGameEscrowOnlyPlayerPayment(gameContract, { deposit, paymentSession })) {

        return false;

    }

    if (!hasLegacyDepositPackage(deposit)) {

        return false;

    }

    return deposit?.isCreator !== true;

}

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

function hasFundSeatInputs(deposit = null) {

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

/**
 * Creator may FundSeat in the same wallet tx as StateInit deployment.
 * Players 2/3 still require verified deposit activation.
 */
export function canIncludeFundSeatInEntry(deposit = null, lifecycle = null) {

    if (!hasFundSeatInputs(deposit)) {

        return false;

    }

    if (deposit?.isCreator === true && canDeployDeposit(deposit, lifecycle)) {

        return true;

    }

    return canFundSeat(deposit, lifecycle);

}

export function resolveEntryPaymentComponents({
    deposit = null,
    paymentSession = null,
    gameContract = null,
    localPlayerId = null,
    lifecycle = null
} = {}) {

    if (isGameEscrowOnlyPlayerPayment(gameContract, { deposit, paymentSession })) {

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

    const includeDeploy = canDeployDeposit(deposit, lifecycle);
    const includeFund = canIncludeFundSeatInEntry(deposit, lifecycle);
    const includeStake = canStakeGameEscrow({
        paymentSession,
        gameContract,
        localPlayerId
    });

    return Object.freeze({
        includeDeploy,
        includeFund,
        includeStake
    });

}

export function canSubmitEntryPayment({
    deposit = null,
    paymentSession = null,
    gameContract = null,
    localPlayerId = null,
    lifecycle = null
} = {}) {

    if (!isGameContractDeployed(gameContract)) {

        return false;

    }

    if (isGameEscrowOnlyPlayerPayment(gameContract, { deposit, paymentSession })) {

        return canStakeGameEscrow({
            paymentSession,
            gameContract,
            localPlayerId
        });

    }

    const components = resolveEntryPaymentComponents({
        deposit,
        paymentSession,
        gameContract,
        localPlayerId,
        lifecycle
    });

    if (deposit?.mySeatStatus !== "FUNDED" && !components.includeFund) {

        return false;

    }

    if (!components.includeStake) {

        return false;

    }

    if (
        deposit?.isCreator === true
        && !isDepositActivationVerified(deposit, lifecycle)
        && !components.includeDeploy
    ) {

        return false;

    }

    return components.includeDeploy
        || components.includeFund
        || components.includeStake;

}

/**
 * PAYMENT_CONNECTION_READY must not select GAMEESCROW_STAKE / ENTRY_PAYMENT
 * on the legacy Deposit path. Game Escrow-only waits for server deploy, then
 * every player with a STAKE obligation gets the same payment action.
 */
export function resolvePage4PaymentPhase({
    deposit = null,
    paymentSession = null,
    gameContract = null,
    paymentConnectionReady = false,
    localPlayerId = null,
    lifecycle = null
} = {}) {

    if (paymentSession?.status === "COMPLETED") {

        return PAGE4_PAYMENT_PHASE.WAITING_PAGE5;

    }

    if (isGameEscrowOnlyPlayerPayment(gameContract, { deposit, paymentSession })) {

        if (canSubmitEntryPayment({
            deposit,
            paymentSession,
            gameContract,
            localPlayerId,
            lifecycle
        })) {

            return PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT;

        }

        if (
            isGameContractDeployed(gameContract)
            || hasPaymentSession(paymentSession)
            || paymentConnectionReady
        ) {

            return PAGE4_PAYMENT_PHASE.GAMEESCROW_STAKE;

        }

        return PAGE4_PAYMENT_PHASE.WALLET;

    }

    if (canSubmitEntryPayment({
        deposit,
        paymentSession,
        gameContract,
        localPlayerId,
        lifecycle
    })) {

        return PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT;

    }

    if (isGameContractDeployed(gameContract)) {

        if (deposit?.mySeatStatus === "FUNDED") {

            return PAGE4_PAYMENT_PHASE.DEPOSIT_WAIT_FULL;

        }

        return PAGE4_PAYMENT_PHASE.DEPOSIT_ACTIVATION;

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

        return PAGE4_PAYMENT_PHASE.DEPOSIT_ACTIVATION;

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

    return phase === PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT
        || phase === PAGE4_PAYMENT_PHASE.GAMEESCROW_STAKE
        || phase === PAGE4_PAYMENT_PHASE.WAITING_PAGE5;

}

export function shouldShowDepositAction(phase) {

    return phase === PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT;

}

export function shouldShowStakeAction(phase) {

    return phase === PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT;

}

export function shouldShowEntryAction(phase) {

    return phase === PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT;

}
