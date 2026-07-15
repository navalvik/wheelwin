export const PAYMENT_STATUS = {
    waiting: "waiting",
    pending: "pending",
    confirmed: "confirmed",
    failed: "failed"
};

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
