/**
 * P6.4/P6.5 — Authoritative Game Contract view helpers for Page4.
 */

export const GAME_CONTRACT_STATUS = Object.freeze({
    NOT_CREATED: "NOT_CREATED",
    CREATING: "CREATING",
    CREATED: "CREATED",
    AWAITING_PAYMENTS: "AWAITING_PAYMENTS",
    READY_FOR_BLOCKCHAIN: "READY_FOR_BLOCKCHAIN",
    DEPLOYING: "DEPLOYING",
    DEPLOYED: "DEPLOYED",
    AWAITING_PLAYER_PAYMENTS: "AWAITING_PLAYER_PAYMENTS",
    PAYMENTS_COMPLETE: "PAYMENTS_COMPLETE",
    DEPLOY_FAILED: "DEPLOY_FAILED",
    SETTLEMENT_PREPARING: "SETTLEMENT_PREPARING",
    SETTLEMENT_SUBMITTED: "SETTLEMENT_SUBMITTED",
    SETTLEMENT_PENDING: "SETTLEMENT_PENDING",
    SETTLEMENT_CONFIRMED: "SETTLEMENT_CONFIRMED",
    SETTLEMENT_COMPLETED: "SETTLEMENT_COMPLETED",
    SETTLEMENT_FAILED: "SETTLEMENT_FAILED"
});

export function hasGameContract(gameContract) {

    return Boolean(gameContract?.contractId);

}

export function isGameContractDeployed(gameContract) {

    const status = gameContract?.status;

    return status === GAME_CONTRACT_STATUS.DEPLOYED
        || status === GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS
        || status === GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE
        || Boolean(gameContract?.contractAddress);

}

export function mapGameContractStatusLabel(status) {

    switch (status) {

        case GAME_CONTRACT_STATUS.CREATING:
        case GAME_CONTRACT_STATUS.DEPLOYING:
            return "Creating...";

        case GAME_CONTRACT_STATUS.CREATED:
        case GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN:
        case GAME_CONTRACT_STATUS.DEPLOYED:
            return "Contract Ready";

        case GAME_CONTRACT_STATUS.AWAITING_PAYMENTS:
        case GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS:
            return "payment.waitingForPayments";

        case GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE:
            return "Payments complete";

        case GAME_CONTRACT_STATUS.SETTLEMENT_PREPARING:
        case GAME_CONTRACT_STATUS.SETTLEMENT_SUBMITTED:
        case GAME_CONTRACT_STATUS.SETTLEMENT_PENDING:
        case GAME_CONTRACT_STATUS.SETTLEMENT_CONFIRMED:
            return "Settling...";

        case GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED:
            return "Settlement complete";

        case GAME_CONTRACT_STATUS.SETTLEMENT_FAILED:
            return "Settlement failed";

        case GAME_CONTRACT_STATUS.DEPLOY_FAILED:
            return "Deployment failed";

        case GAME_CONTRACT_STATUS.NOT_CREATED:
        default:
            return "Game Contract";

    }

}
