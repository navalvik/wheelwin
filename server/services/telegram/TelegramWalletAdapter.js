import { randomUUID } from "node:crypto";

function delay(ms) {

    return new Promise((resolve) => {

        setTimeout(resolve, ms);

    });

}

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

    /**
     * C5.8D — Stub entry-stake payment. No Telegram Wallet API / TON chain.
     * Optional delayMs simulates async wallet completion.
     */
    async simulateEntryPayment({
        roomId,
        playerId,
        wallet,
        delayMs = 0
    } = {}) {

        if (!roomId) {

            throw new Error("roomId is required");

        }

        if (!playerId) {

            throw new Error("playerId is required");

        }

        if (delayMs > 0) {

            await delay(delayMs);

        }

        this._logger?.info?.(
            `TelegramWalletAdapter stub entry payment | roomId=${roomId} | `
                + `playerId=${playerId}`
        );

        return {
            paymentReference: `tg_entry_${randomUUID()}`,
            roomId,
            playerId,
            wallet: wallet ?? null,
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
