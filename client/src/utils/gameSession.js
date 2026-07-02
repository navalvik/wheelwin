export const PAYMENT_STATUS = {
    waiting: "waiting",
    pending: "pending",
    confirmed: "confirmed",
    failed: "failed"
};

export const SMART_CONTRACT_STATUS = {
    notIssued: "not_issued",
    issued: "issued",
    confirmed: "confirmed",
    failed: "failed"
};

export const PAYMENT_PAGE_LABELS = [
    "GAMER 1 / ROOM OWNER",
    "GAMER 2 / YOUR FRIEND",
    "GAMER 3 / YOUR FRIEND"
];

export function getPaymentStatusLabel(status) {

    switch (status) {

        case PAYMENT_STATUS.confirmed:
            return "PAYMENT HAVE BEEN DONE";

        case PAYMENT_STATUS.pending:
            return "PAYMENT PROCESSING...";

        case PAYMENT_STATUS.failed:
            return "PAYMENT FAILED";

        case PAYMENT_STATUS.waiting:
        default:
            return "AWAITING FOR PAYMENT";

    }

}

export function getSmartContractStatusLabel(status) {

    switch (status) {

        case SMART_CONTRACT_STATUS.issued:
            return "SMART CONTRACT IS ISSUED";

        case SMART_CONTRACT_STATUS.confirmed:
            return "SMART CONTRACT IS CONFIRMED";

        case SMART_CONTRACT_STATUS.failed:
            return "SMART CONTRACT FAILED";

        case SMART_CONTRACT_STATUS.notIssued:
        default:
            return "SMART CONTRACT IS NOT ISSUED";

    }

}

export function areAllPaymentsConfirmed(players) {

    return players.length > 0
        && players.every(
            (player) => player.paymentStatus === PAYMENT_STATUS.confirmed
        );

}

export const DEV_INITIAL_PAYMENT_STATUSES = [
    PAYMENT_STATUS.confirmed,
    PAYMENT_STATUS.waiting,
    PAYMENT_STATUS.confirmed
];

export const PLAYER_ICON_POOL = [
    "🎲",
    "♠",
    "♕",
    "⚓",
    "★",
    "◆"
];

export function assignUniqueIcons(playerCount) {

    const pool = [...PLAYER_ICON_POOL]
        .sort(() => Math.random() - 0.5);

    return pool.slice(0, playerCount);

}

export function calculatePaymentGram(baseStake) {

    const stake = Number(baseStake);

    if (stake === 10) {

        return 25;

    }

    if (stake === 1) {

        return 2.5;

    }

    return stake * 2.5;

}

export const DEV_VERIFY_PLAYERS = [
    {
        id: 1,
        labelTitle: "YOUR NICKNAME",
        nickname: "Olaa",
        icon: "🎲",
        age: 16,
        sectorLabel: "SEPARATE SECTORS",
        sectorValue: "2"
    },
    {
        id: 2,
        labelTitle: "GAMER 2 / YOUR FRIEND",
        nickname: "Bob",
        icon: "♠",
        age: 56,
        sectorLabel: "SECTOR",
        sectorValue: "1"
    },
    {
        id: 3,
        labelTitle: "GAMER 3 / YOUR FRIEND",
        nickname: "Lena",
        icon: "♕",
        age: 15,
        sectorLabel: "TOGETHER SECTORS",
        sectorValue: "2"
    }
];
