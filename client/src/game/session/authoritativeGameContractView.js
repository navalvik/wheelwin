/**
 * P6.4 — Authoritative Game Contract view helpers for Page4.
 */

export const GAME_CONTRACT_STATUS = Object.freeze({
    NOT_CREATED: "NOT_CREATED",
    CREATING: "CREATING",
    CREATED: "CREATED",
    AWAITING_PAYMENTS: "AWAITING_PAYMENTS",
    READY_FOR_BLOCKCHAIN: "READY_FOR_BLOCKCHAIN"
});

export function hasGameContract(gameContract) {

    return Boolean(gameContract?.contractId);

}

export function mapGameContractStatusLabel(status) {

    switch (status) {

        case GAME_CONTRACT_STATUS.CREATING:
            return "Creating...";

        case GAME_CONTRACT_STATUS.CREATED:
            return "Ready";

        case GAME_CONTRACT_STATUS.AWAITING_PAYMENTS:
        case GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN:
            return "Waiting for payments";

        case GAME_CONTRACT_STATUS.NOT_CREATED:
        default:
            return "Game Contract";

    }

}
