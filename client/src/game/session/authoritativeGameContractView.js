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
    DEPLOY_FAILED: "DEPLOY_FAILED"
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
            return "Waiting for payments";

        case GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE:
            return "Payments complete";

        case GAME_CONTRACT_STATUS.DEPLOY_FAILED:
            return "Deployment failed";

        case GAME_CONTRACT_STATUS.NOT_CREATED:
        default:
            return "Game Contract";

    }

}
