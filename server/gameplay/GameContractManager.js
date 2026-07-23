import { randomUUID } from "node:crypto";

import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    GAME_CONTRACT_STATUS,
    GameContract
} from "../models/GameContract.js";
import { PAYMENT_PARTICIPANT_STATUS } from "../models/PaymentSession.js";
import { buildGameContractSnapshot } from "../payment/buildGameContractSnapshot.js";

const REQUESTED_OR_BEYOND = new Set([
    PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED,
    PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION,
    PAYMENT_PARTICIPANT_STATUS.PAYMENT_SUBMITTED,
    PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
]);

/**
 * P6.4 — Authoritative Game Smart Contract lifecycle (architecture only).
 *
 * Owns contract metadata and immutable snapshot. No blockchain deployment,
 * no TON/GRM transfer, no winner/payout logic.
 */
export class GameContractManager {

    constructor({
        logger,
        eventBus,
        playerManager,
        roomManager,
        sessionWalletStore = null,
        configurationEngine = null,
        paymentRules = null,
        creatingDelayMs = 0,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._playerManager = playerManager;

        this._roomManager = roomManager;

        this._sessionWalletStore = sessionWalletStore;

        this._configurationEngine = configurationEngine;

        this._paymentRules = paymentRules;

        this._creatingDelayMs = Number.isFinite(creatingDelayMs)
            && creatingDelayMs >= 0
            ? creatingDelayMs
            : 0;

        this._devMode = devMode;

        // roomId → GameContract
        this._contractsByRoom = new Map();

        // gameId → roomId
        this._roomByGameId = new Map();

        this._creatingTimers = new Map();

        this._handlers = [];

        this._initialized = false;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.PAYMENT_SESSION_UPDATED,
            (envelope) => {

                this._handlePaymentSessionUpdated(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.PAYMENT_SESSION_COMPLETED,
            (envelope) => {

                this._handlePaymentSessionCompleted(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.PAYMENT_SESSION_FAILED,
            (envelope) => {

                this.destroyContract(envelope.payload?.roomId);

            }
        );

        this._subscribe(
            EVENT_TYPES.ROOM_DESTROYED,
            (envelope) => {

                this.destroyContract(envelope.payload?.roomId);

            }
        );

        this._subscribe(
            EVENT_TYPES.SESSION_FINISHED,
            (envelope) => {

                this.destroyContract(envelope.payload?.roomId);

            }
        );

        this._subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            () => {

                this._reset();

            }
        );

        this._initialized = true;

    }

    shutdown() {

        this._reset();

        for (const subscription of this._handlers) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._handlers = [];

        this._initialized = false;

    }

    getContract(roomId) {

        return this._contractsByRoom.get(roomId) ?? null;

    }

    getContractByGameId(gameId) {

        if (!gameId) {

            return null;

        }

        const roomId = this._roomByGameId.get(gameId);

        return roomId ? this.getContract(roomId) : null;

    }

    /**
     * Create Game Contract Request once payment seats are PAYMENT_REQUESTED+.
     */
    createContractRequest(roomId, { gameId = null } = {}) {

        this._assertInitialized();

        if (!roomId || this._contractsByRoom.has(roomId)) {

            return this._contractsByRoom.get(roomId) ?? null;

        }

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            this._logger.error(
                `GameContract create failed | roomId=${roomId} | reason=room_missing`
            );

            return null;

        }

        const resolvedGameId = gameId ?? null;

        if (!resolvedGameId) {

            this._logger.error(
                `GameContract create failed | roomId=${roomId} | reason=game_missing`
            );

            return null;

        }

        if (this._roomByGameId.has(resolvedGameId)) {

            return this.getContractByGameId(resolvedGameId);

        }

        const configuration = this._configurationEngine
            ?.getConfiguration?.(resolvedGameId)
            ?? null;

        const snapshot = buildGameContractSnapshot({
            gameId: resolvedGameId,
            roomId,
            playerIds: [...room.players],
            playerManager: this._playerManager,
            sessionWalletStore: this._sessionWalletStore,
            configuration,
            paymentRules: this._paymentRules ?? undefined
        });

        if (!snapshot) {

            this._logger.error(
                `GameContract create failed | roomId=${roomId} | reason=snapshot_invalid`
            );

            return null;

        }

        const contract = new GameContract({
            contractId: `contract_${randomUUID()}`,
            gameId: resolvedGameId,
            roomId,
            status: GAME_CONTRACT_STATUS.NOT_CREATED,
            snapshot
        });

        this._contractsByRoom.set(roomId, contract);

        this._roomByGameId.set(resolvedGameId, roomId);

        contract.transitionTo(GAME_CONTRACT_STATUS.CREATING);

        this._emitClientUpdate(contract);

        this._log(
            `CREATING | roomId=${roomId} | gameId=${resolvedGameId} | `
                + `contractId=${contract.contractId}`
        );

        this._scheduleCreated(contract);

        return contract;

    }

    markReadyForBlockchain(roomId) {

        const contract = this._contractsByRoom.get(roomId);

        if (!contract) {

            return null;

        }

        if (contract.status === GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN) {

            return contract;

        }

        if (contract.status !== GAME_CONTRACT_STATUS.AWAITING_PAYMENTS) {

            return contract;

        }

        if (!contract.transitionTo(GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN)) {

            return contract;

        }

        this._emitClientUpdate(contract);

        this._log(
            `READY_FOR_BLOCKCHAIN | roomId=${roomId} | `
                + `contractId=${contract.contractId}`
        );

        return contract;

    }

    destroyContract(roomId) {

        if (!roomId) {

            return;

        }

        this._clearCreatingTimer(roomId);

        const contract = this._contractsByRoom.get(roomId);

        if (contract?.gameId) {

            this._roomByGameId.delete(contract.gameId);

        }

        this._contractsByRoom.delete(roomId);

    }

    _handlePaymentSessionUpdated(payload) {

        const roomId = payload?.roomId;

        const gameId = payload?.gameId;

        if (!roomId || !gameId) {

            return;

        }

        if (this._contractsByRoom.has(roomId)) {

            return;

        }

        const participants = Array.isArray(payload.participants)
            ? payload.participants
            : [];

        if (participants.length === 0) {

            return;

        }

        const allRequested = participants.every(
            (participant) => REQUESTED_OR_BEYOND.has(participant.status)
        );

        if (!allRequested) {

            return;

        }

        this.createContractRequest(roomId, { gameId });

    }

    _handlePaymentSessionCompleted(payload) {

        const roomId = payload?.roomId;

        if (!roomId) {

            return;

        }

        this.markReadyForBlockchain(roomId);

    }

    _scheduleCreated(contract) {

        const finish = () => {

            this._creatingTimers.delete(contract.roomId);

            const current = this._contractsByRoom.get(contract.roomId);

            if (!current || current.contractId !== contract.contractId) {

                return;

            }

            if (current.status !== GAME_CONTRACT_STATUS.CREATING) {

                return;

            }

            if (!current.transitionTo(GAME_CONTRACT_STATUS.CREATED)) {

                return;

            }

            this._emitClientUpdate(current);

            this._log(
                `CREATED | roomId=${current.roomId} | `
                    + `contractId=${current.contractId}`
            );

            if (!current.transitionTo(GAME_CONTRACT_STATUS.AWAITING_PAYMENTS)) {

                return;

            }

            this._emitClientUpdate(current);

            this._log(
                `AWAITING_PAYMENTS | roomId=${current.roomId} | `
                    + `contractId=${current.contractId}`
            );

        };

        if (this._creatingDelayMs <= 0) {

            finish();

            return;

        }

        const timerId = setTimeout(finish, this._creatingDelayMs);

        this._creatingTimers.set(contract.roomId, timerId);

    }

    _clearCreatingTimer(roomId) {

        const timerId = this._creatingTimers.get(roomId);

        if (timerId) {

            clearTimeout(timerId);

            this._creatingTimers.delete(roomId);

        }

    }

    _emitClientUpdate(contract) {

        this._emit(
            EVENT_TYPES.GAME_CONTRACT_UPDATED,
            contract.toClientSnapshot()
        );

    }

    _reset() {

        for (const roomId of [...this._creatingTimers.keys()]) {

            this._clearCreatingTimer(roomId);

        }

        this._contractsByRoom.clear();

        this._roomByGameId.clear();

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _emit(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.GAME_CONTRACT_MANAGER,
            type,
            payload
        });

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new Error("GameContractManager is not initialized");

        }

    }

    _log(message) {

        if (this._devMode) {

            this._logger.info(`[GameContractManager] ${message}`);

        }

    }

}
