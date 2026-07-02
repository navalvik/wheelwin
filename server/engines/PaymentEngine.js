import { PAYMENT_STATUS } from "../catalog/PaymentRules.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { deepFreezePayment } from "./payment/paymentFreeze.js";
import { PaymentValidationError } from "./payment/PaymentValidationError.js";
import { PrizeCalculator } from "./payment/PrizeCalculator.js";

export class PaymentEngine {

    constructor({
        logger,
        eventBus,
        winnerEngine,
        configurationEngine,
        gameCatalog,
        telegramWalletAdapter,
        metricsService = null
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._winnerEngine = winnerEngine;

        this._configurationEngine = configurationEngine;

        this._gameCatalog = gameCatalog;

        this._telegramWalletAdapter = telegramWalletAdapter;

        this._metricsService = metricsService;

        this._prizeCalculator = new PrizeCalculator({
            paymentRules: gameCatalog.getPaymentRules()
        });

        this._payments = new Map();

        this._infrastructureHandlers = [];

        this._initialized = false;

    }

    initialize() {

        const shutdownHandler = () => {

            this._handleServerShutdown();

        };

        this._eventBus.subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            shutdownHandler
        );

        this._infrastructureHandlers.push({
            event: EVENT_TYPES.SERVER_SHUTDOWN,
            handler: shutdownHandler
        });

        this._initialized = true;

    }

    shutdown() {

        for (const gameId of [...this._payments.keys()]) {

            this.removePayment(gameId);

        }

        for (const subscription of this._infrastructureHandlers) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._infrastructureHandlers = [];

        this._initialized = false;

    }

    preparePayment(gameId) {

        this._assertInitialized();

        const record = this._getOrCreateRecord(gameId);

        if (record.paymentStatus === PAYMENT_STATUS.COMPLETED) {

            throw new PaymentValidationError({
                gameId,
                reason: "Payment has already been processed"
            });

        }

        const { gameResult, configuration } = this._readPaymentInputs(gameId);

        const prizeBreakdown = this._prizeCalculator.calculate({
            configuration,
            gameResult
        });

        const preparedPayment = this._telegramWalletAdapter.preparePayment({
            gameId,
            winnerId: gameResult.winningPlayer.playerId,
            amount: prizeBreakdown.winnerAmount,
            currency: prizeBreakdown.currency,
            metadata: {
                traceSeed: gameResult.traceSeed,
                totalPrize: prizeBreakdown.totalPrize,
                platformFee: prizeBreakdown.platformFee
            }
        });

        record.preparedPayment = preparedPayment;

        record.prizeBreakdown = prizeBreakdown;

        record.paymentStatus = PAYMENT_STATUS.PREPARED;

        this._emit(EVENT_TYPES.PAYMENT_PREPARED, {
            gameId,
            winnerId: gameResult.winningPlayer.playerId,
            totalPrize: prizeBreakdown.totalPrize,
            winnerAmount: prizeBreakdown.winnerAmount,
            traceSeed: gameResult.traceSeed,
            timestamp: Date.now()
        });

        return this._createPreparedSnapshot(record);

    }

    processPayment(gameId) {

        const process = () => {

            this._assertInitialized();

            const record = this._payments.get(gameId);

            if (record?.paymentStatus === PAYMENT_STATUS.COMPLETED) {

                throw new PaymentValidationError({
                    gameId,
                    reason: "Payment has already been processed"
                });

            }

            const { gameResult } = this._readPaymentInputs(gameId);

            this._emit(EVENT_TYPES.PAYMENT_STARTED, {
                gameId,
                winnerId: gameResult.winningPlayer.playerId,
                traceSeed: gameResult.traceSeed,
                timestamp: Date.now()
            });

            try {

                if (!record || record.paymentStatus !== PAYMENT_STATUS.PREPARED) {

                    this.preparePayment(gameId);

                }

                const activeRecord = this._payments.get(gameId);

                const transfer = this._telegramWalletAdapter.executeTransfer(
                    activeRecord.preparedPayment
                );

                const paymentResult = deepFreezePayment({
                    gameId,
                    winnerId: gameResult.winningPlayer.playerId,
                    totalPrize: activeRecord.prizeBreakdown.totalPrize,
                    platformFee: activeRecord.prizeBreakdown.platformFee,
                    winnerAmount: activeRecord.prizeBreakdown.winnerAmount,
                    paymentStatus: PAYMENT_STATUS.COMPLETED,
                    paymentReference: transfer.paymentReference,
                    processedAt: transfer.processedAt,
                    metadata: {
                        traceSeed: gameResult.traceSeed,
                        currency: activeRecord.prizeBreakdown.currency,
                        transactionId: transfer.transactionId,
                        playerContributions: activeRecord.prizeBreakdown.playerContributions
                    }
                });

                activeRecord.paymentResult = paymentResult;

                activeRecord.paymentStatus = PAYMENT_STATUS.COMPLETED;

                this._emit(EVENT_TYPES.PAYMENT_COMPLETED, {
                    gameId,
                    winnerId: paymentResult.winnerId,
                    winnerAmount: paymentResult.winnerAmount,
                    traceSeed: gameResult.traceSeed,
                    timestamp: paymentResult.processedAt
                });

                return paymentResult;

            } catch (error) {

                const failedRecord = this._getOrCreateRecord(gameId);

                failedRecord.paymentStatus = PAYMENT_STATUS.FAILED;

                this._emit(EVENT_TYPES.PAYMENT_FAILED, {
                    gameId,
                    winnerId: gameResult.winningPlayer.playerId,
                    traceSeed: gameResult.traceSeed,
                    reason: error.message,
                    timestamp: Date.now()
                });

                if (error instanceof PaymentValidationError) {

                    throw error;

                }

                throw new PaymentValidationError({
                    gameId,
                    reason: error.message
                });

            }

        };

        if (this._metricsService?.isEnabled()) {

            return this._metricsService.time("payment.process", process);

        }

        return process();

    }

    getPayment(gameId) {

        const record = this._payments.get(gameId);

        if (!record?.paymentResult) {

            return null;

        }

        return record.paymentResult;

    }

    getPaymentStatus(gameId) {

        const record = this._payments.get(gameId);

        if (!record) {

            return null;

        }

        return record.paymentStatus;

    }

    removePayment(gameId) {

        if (!this._payments.has(gameId)) {

            this._logger.error(
                `Payment removal failed: payment not found (${gameId})`
            );

            return false;

        }

        this._payments.delete(gameId);

        this._emit(EVENT_TYPES.PAYMENT_REMOVED, {
            gameId,
            timestamp: Date.now()
        });

        return true;

    }

    getDebugSnapshot(gameId) {

        const record = this._payments.get(gameId);

        if (!record) {

            return null;

        }

        return {
            gameId,
            paymentStatus: record.paymentStatus,
            totalPrize: record.prizeBreakdown?.totalPrize ?? null,
            winnerAmount: record.prizeBreakdown?.winnerAmount ?? null,
            platformFee: record.prizeBreakdown?.platformFee ?? null,
            paymentReference: record.paymentResult?.paymentReference
                ?? record.preparedPayment?.paymentReference
                ?? null,
            metadata: record.paymentResult?.metadata
                ?? record.preparedPayment?.metadata
                ?? null
        };

    }

    _readPaymentInputs(gameId) {

        const gameResult = this._winnerEngine.getResult(gameId);

        if (!gameResult) {

            throw new PaymentValidationError({
                gameId,
                reason: "Immutable game result is missing"
            });

        }

        const configuration = this._configurationEngine.getConfiguration(gameId);

        if (!configuration) {

            throw new PaymentValidationError({
                gameId,
                reason: "Game configuration is missing"
            });

        }

        if (!gameResult.winningPlayer?.playerId) {

            throw new PaymentValidationError({
                gameId,
                reason: "Winning player is missing from game result"
            });

        }

        const ownerExists = configuration.players.some(
            (player) => player.playerId === gameResult.winningPlayer.playerId
        );

        if (!ownerExists) {

            throw new PaymentValidationError({
                gameId,
                reason: "Winning player does not exist in configuration"
            });

        }

        return { gameResult, configuration };

    }

    _getOrCreateRecord(gameId) {

        let record = this._payments.get(gameId);

        if (!record) {

            record = {
                gameId,
                paymentStatus: PAYMENT_STATUS.PENDING,
                preparedPayment: null,
                prizeBreakdown: null,
                paymentResult: null
            };

            this._payments.set(gameId, record);

        }

        return record;

    }

    _createPreparedSnapshot(record) {

        return {
            gameId: record.gameId,
            paymentStatus: record.paymentStatus,
            totalPrize: record.prizeBreakdown.totalPrize,
            platformFee: record.prizeBreakdown.platformFee,
            winnerAmount: record.prizeBreakdown.winnerAmount,
            paymentReference: record.preparedPayment.paymentReference
        };

    }

    _emit(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.PAYMENT_ENGINE,
            type,
            payload
        });

    }

    _handleServerShutdown() {

        this._payments.clear();

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new Error("PaymentEngine is not initialized");

        }

    }

}
