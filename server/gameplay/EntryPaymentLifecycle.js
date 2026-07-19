import {
    ENTRY_SMART_CONTRACT_STATUS
} from "../models/EntryPaymentSession.js";

/**
 * C5.8D — Drives EntryPaymentSession lifecycle via TelegramWalletAdapter stub.
 *
 * Simulates per-player payment success, then smart-contract creating → created.
 * Does not call Telegram Wallet API or the TON blockchain.
 */
export class EntryPaymentLifecycle {

    constructor({
        logger,
        telegramWalletAdapter,
        applySessionUpdate,
        playerPaymentDelayMs = 750,
        smartContractDelayMs = 500
    }) {

        this._logger = logger;

        this._telegramWalletAdapter = telegramWalletAdapter;

        this._applySessionUpdate = applySessionUpdate;

        this._playerPaymentDelayMs = playerPaymentDelayMs;

        this._smartContractDelayMs = smartContractDelayMs;

        // roomId → timeout handles
        this._timersByRoom = new Map();

    }

    start(roomId, session) {

        if (!roomId || !session) {

            return;

        }

        this.cancel(roomId);

        const timers = [];

        this._timersByRoom.set(roomId, timers);

        session.players.forEach((player, index) => {

            const delayMs = this._playerPaymentDelayMs * (index + 1);

            const timer = setTimeout(() => {

                void this._simulatePlayerPayment(roomId, player);

            }, delayMs);

            timers.push(timer);

        });

        this._logger.info(
            `Entry payment lifecycle started | roomId=${roomId} | `
                + `players=${session.players.length}`
        );

    }

    cancel(roomId) {

        const timers = this._timersByRoom.get(roomId);

        if (!timers) {

            return;

        }

        for (const timer of timers) {

            clearTimeout(timer);

        }

        this._timersByRoom.delete(roomId);

    }

    shutdown() {

        for (const roomId of [...this._timersByRoom.keys()]) {

            this.cancel(roomId);

        }

    }

    async _simulatePlayerPayment(roomId, player) {

        if (!this._timersByRoom.has(roomId)) {

            return;

        }

        try {

            await this._telegramWalletAdapter.simulateEntryPayment({
                roomId,
                playerId: player.playerId,
                wallet: player.wallet
            });

        } catch (error) {

            this._logger.error(
                `Entry payment simulation failed | roomId=${roomId} | `
                    + `playerId=${player.playerId} | ${error.message}`
            );

            return;

        }

        if (!this._timersByRoom.has(roomId)) {

            return;

        }

        const next = this._applySessionUpdate(roomId, (session) => (
            session.withPlayerPaid(player.playerId)
        ));

        if (!next) {

            return;

        }

        this._logger.info(
            `Entry payment paid | roomId=${roomId} | playerId=${player.playerId}`
        );

        if (next.areAllPlayersPaid()
            && next.smartContractStatus
                === ENTRY_SMART_CONTRACT_STATUS.WAITING) {

            this._beginSmartContract(roomId);

        }

    }

    _beginSmartContract(roomId) {

        if (!this._timersByRoom.has(roomId)) {

            return;

        }

        const creating = this._applySessionUpdate(roomId, (session) => (
            session.withSmartContractStatus(
                ENTRY_SMART_CONTRACT_STATUS.CREATING
            )
        ));

        if (!creating) {

            return;

        }

        this._logger.info(`Entry smart contract creating | roomId=${roomId}`);

        const timers = this._timersByRoom.get(roomId) ?? [];

        const timer = setTimeout(() => {

            if (!this._timersByRoom.has(roomId)) {

                return;

            }

            const created = this._applySessionUpdate(roomId, (session) => (
                session.withSmartContractStatus(
                    ENTRY_SMART_CONTRACT_STATUS.CREATED
                )
            ));

            if (created) {

                this._logger.info(
                    `Entry smart contract created | roomId=${roomId}`
                );

            }

        }, this._smartContractDelayMs);

        timers.push(timer);

        this._timersByRoom.set(roomId, timers);

    }

}
