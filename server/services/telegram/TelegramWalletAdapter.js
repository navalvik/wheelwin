import { randomUUID } from "node:crypto";

export class TelegramWalletAdapter {

    constructor({ logger }) {

        this._logger = logger;

    }

    preparePayment({
        gameId,
        winnerId,
        amount,
        currency,
        metadata
    }) {

        this._validatePaymentParameters({
            gameId,
            winnerId,
            amount,
            currency
        });

        return {
            paymentReference: `tg_wallet_${randomUUID()}`,
            gameId,
            winnerId,
            amount,
            currency,
            status: "prepared",
            metadata: { ...metadata },
            preparedAt: Date.now()
        };

    }

    executeTransfer(preparedPayment) {

        this._validatePaymentParameters({
            gameId: preparedPayment.gameId,
            winnerId: preparedPayment.winnerId,
            amount: preparedPayment.amount,
            currency: preparedPayment.currency
        });

        if (!preparedPayment.paymentReference) {

            throw new Error("Payment reference is required");

        }

        return {
            paymentReference: preparedPayment.paymentReference,
            transactionId: `tg_tx_${randomUUID()}`,
            status: "completed",
            processedAt: Date.now()
        };

    }

    _validatePaymentParameters({
        gameId,
        winnerId,
        amount,
        currency
    }) {

        if (!gameId) {

            throw new Error("gameId is required");

        }

        if (!winnerId) {

            throw new Error("winnerId is required");

        }

        if (!Number.isFinite(amount) || amount <= 0) {

            throw new Error("amount must be a positive number");

        }

        if (!currency) {

            throw new Error("currency is required");

        }

    }

}
