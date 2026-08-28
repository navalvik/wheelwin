/**
 * R17.9L.7 — DepositMonitor blockchain observation layer.
 * Reports verified funding observations only. Does NOT:
 * - deploy contracts;
 * - create DeploymentAuthorization;
 * - mutate DepositSession;
 * - call GameContractManager or TonGameContractAdapter.
 */

import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { DepositObservation } from "./DepositObservation.js";
import {
    DepositMonitorNotStartedError,
    DepositWatchNotAuthorizedError,
    InvalidDepositObservationError
} from "./DepositMonitorErrors.js";
import { InMemoryDepositObservationPersistence } from "./DepositObservationPersistencePort.js";
import {
    DEPOSIT_OBSERVATION_REJECTION_REASONS,
    DEPOSIT_OBSERVATION_STATUS
} from "./DepositObservationStates.js";
import { DEPOSIT_SESSION_STATUS } from "./DepositSessionStates.js";
import { normalizeDepositWallet } from "./depositValidation.js";

const WATCHABLE_DEPOSIT_STATUSES = Object.freeze([
    DEPOSIT_SESSION_STATUS.AWAITING_FUNDS,
    DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED
]);

export class DepositMonitor {

    constructor({
        logger = null,
        eventBus = null,
        depositSessionCoordinator = null,
        persistence = null,
        blockchainSource = null,
        network = "testnet",
        requireActivationVerification = false,
        roomManager = null
    } = {}) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._depositSessionCoordinator = depositSessionCoordinator;

        this._persistence = persistence ?? new InMemoryDepositObservationPersistence();

        this._blockchainSource = blockchainSource;

        this._network = network;

        this._initialized = false;

        this._started = false;

        this._watches = new Map();

        this._requireActivationVerification = requireActivationVerification === true;

        this._roomManager = roomManager;

        this._activationAuthorized = new Set();

        if (this._blockchainSource?.attachMonitor) {

            this._blockchainSource.attachMonitor(this);

        }

    }

    initialize() {

        this._initialized = true;

        this._started = true;

    }

    shutdown() {

        this._watches.clear();

        this._activationAuthorized.clear();

        this._started = false;

        this._initialized = false;

    }

    /**
     * R17.9L.22 — Authorization issued only after chain activation verification.
     * Does not start a watch by itself.
     */
    authorizeVerifiedWatch(depositId) {

        if (!depositId) {

            throw new InvalidDepositObservationError("depositId is required");

        }

        this._activationAuthorized.add(depositId);

        return true;

    }

    isWatchAuthorized(depositId) {

        return this._activationAuthorized.has(depositId);

    }

    startWatching(depositSession) {

        this._assertStarted();

        if (!depositSession || typeof depositSession !== "object") {

            throw new InvalidDepositObservationError("depositSession is required");

        }

        const depositId = depositSession.depositId;

        if (this._requireActivationVerification && !this._activationAuthorized.has(depositId)) {

            throw new DepositWatchNotAuthorizedError(depositId);

        }

        if (this._watches.has(depositId)) {

            return this._watches.get(depositId);

        }

        const depositAddress = normalizeDepositWallet(depositSession.depositAddress);

        if (!depositAddress) {

            throw new InvalidDepositObservationError(
                "depositAddress is required before watching",
                { depositId }
            );

        }

        if (!WATCHABLE_DEPOSIT_STATUSES.includes(depositSession.state)) {

            throw new InvalidDepositObservationError(
                "DepositMonitor can only watch AWAITING_FUNDS or PARTIALLY_FUNDED sessions",
                {
                    depositId,
                    state: depositSession.state
                }
            );

        }

        const bindings = Array.isArray(depositSession.bindings)
            ? depositSession.bindings.map((binding) => Object.freeze({ ...binding }))
            : [];

        if (bindings.length === 0) {

            throw new InvalidDepositObservationError(
                "DepositMonitor requires bound player wallets",
                { depositId }
            );

        }

        const watch = Object.freeze({
            depositId,
            roomId: depositSession.roomId,
            gameId: depositSession.gameId,
            depositAddress,
            network: depositSession.metadata?.network
                ?? depositSession.metadata?.tonNetwork
                ?? this._network,
            bindings,
            fundedWallets: new Set(),
            fundedPlayerIds: new Set(),
            transactionHashes: new Set()
        });

        this._watches.set(depositId, watch);

        return watch;

    }

    /**
     * Pull observations from the attached blockchain source.
     * Fake sources have no poll(); real TON adapter implements it.
     */
    async poll() {

        this._assertStarted();

        this._pruneWatchesWithoutLiveRooms();

        if (typeof this._blockchainSource?.poll !== "function") {

            return Object.freeze({
                observed: 0,
                skipped: 0,
                failed: 0,
                results: Object.freeze([])
            });

        }

        return this._blockchainSource.poll(this.listActiveWatches());

    }

    stopWatching(depositId) {

        this._assertStarted();

        this._activationAuthorized.delete(depositId);

        return this._watches.delete(depositId);

    }

    _isAssociatedRoomLive(roomId) {

        if (typeof this._roomManager?.getRoom !== "function") {

            return true;

        }

        if (!roomId) {

            return true;

        }

        return Boolean(this._roomManager.getRoom(roomId));

    }

    _pruneWatchesWithoutLiveRooms() {

        if (typeof this._roomManager?.getRoom !== "function") {

            return;

        }

        for (const [depositId, watch] of [...this._watches.entries()]) {

            if (this._isAssociatedRoomLive(watch.roomId)) {

                continue;

            }

            this._logger?.warn?.(
                "DepositMonitor dropping watch for room that is no longer live"
                + ` | depositId=${depositId}`
                + ` | roomId=${watch.roomId ?? "none"}`
            );

            this.stopWatching(depositId);

        }

    }

    listActiveWatches() {

        return Object.freeze([...this._watches.values()].map((watch) => Object.freeze({
            depositId: watch.depositId,
            roomId: watch.roomId,
            gameId: watch.gameId,
            depositAddress: watch.depositAddress,
            network: watch.network,
            bindingCount: watch.bindings.length,
            fundedCount: watch.fundedWallets.size
        })));

    }

    restoreActiveWatches() {

        this._assertStarted();

        if (!this._depositSessionCoordinator?.listActiveDepositSessions) {

            return Object.freeze({
                restored: 0,
                skipped: 0
            });

        }

        const sessions = this._depositSessionCoordinator.listActiveDepositSessions();

        let restored = 0;

        let skipped = 0;

        for (const session of sessions) {

            if (!WATCHABLE_DEPOSIT_STATUSES.includes(session.state)) {

                skipped += 1;

                continue;

            }

            if (!session.depositAddress) {

                skipped += 1;

                continue;

            }

            if (!this._isAssociatedRoomLive(session.roomId)) {

                skipped += 1;

                continue;

            }

            if (
                this._requireActivationVerification
                && !this._activationAuthorized.has(session.depositId)
            ) {

                skipped += 1;

                continue;

            }

            this.startWatching(session);

            restored += 1;

        }

        return Object.freeze({
            restored,
            skipped
        });

    }

    processObservation(input) {

        this._assertStarted();

        const observation = DepositObservation.fromInput({
            ...input,
            network: input?.network ?? this._network
        });

        this._emit(EVENT_TYPES.DEPOSIT_OBSERVATION_RECEIVED, observation);

        const watch = this._watches.get(observation.depositId);

        if (!watch) {

            return this._rejectObservation(
                observation,
                DEPOSIT_OBSERVATION_REJECTION_REASONS.WATCH_NOT_FOUND
            );

        }

        if (observation.depositId !== watch.depositId) {

            return this._rejectObservation(
                observation,
                DEPOSIT_OBSERVATION_REJECTION_REASONS.DEPOSIT_ID_MISMATCH
            );

        }

        if (observation.depositAddress !== watch.depositAddress) {

            return this._rejectObservation(
                observation,
                DEPOSIT_OBSERVATION_REJECTION_REASONS.DEPOSIT_ADDRESS_MISMATCH
            );

        }

        if (
            this._persistence.findDepositObservation(
                observation.depositId,
                observation.transactionHash
            )
            || watch.transactionHashes.has(observation.transactionHash)
        ) {

            return this._rejectObservation(
                observation,
                DEPOSIT_OBSERVATION_REJECTION_REASONS.DUPLICATE_TRANSACTION
            );

        }

        const seat = watch.bindings.find(
            (binding) => binding.wallet === observation.senderWallet
        );

        if (!seat) {

            return this._rejectObservation(
                observation,
                DEPOSIT_OBSERVATION_REJECTION_REASONS.UNKNOWN_WALLET
            );

        }

        if (watch.fundedWallets.has(seat.wallet)) {

            return this._rejectObservation(
                observation,
                DEPOSIT_OBSERVATION_REJECTION_REASONS.SEAT_ALREADY_FUNDED
            );

        }

        if (observation.amount < seat.expectedAmount) {

            return this._rejectObservation(
                observation,
                DEPOSIT_OBSERVATION_REJECTION_REASONS.INSUFFICIENT_AMOUNT
            );

        }

        observation.markValidated({ playerId: seat.playerId });

        this._persistObservation(observation);

        watch.transactionHashes.add(observation.transactionHash);

        watch.fundedWallets.add(seat.wallet);

        watch.fundedPlayerIds.add(seat.playerId);

        this._emit(EVENT_TYPES.DEPOSIT_SEAT_FUNDED, observation, {
            roomId: watch.roomId,
            gameId: watch.gameId,
            playerId: seat.playerId,
            expectedAmount: seat.expectedAmount
        });

        if (watch.fundedWallets.size >= watch.bindings.length) {

            this._emit(EVENT_TYPES.DEPOSIT_FULL_ONCHAIN, observation, {
                roomId: watch.roomId,
                gameId: watch.gameId,
                depositId: watch.depositId,
                depositAddress: watch.depositAddress,
                fundedSeatCount: watch.fundedWallets.size
            });

        }

        return observation;

    }

    _rejectObservation(observation, rejectionReason) {

        observation.markRejected(rejectionReason);

        this._persistObservation(observation);

        this._emit(EVENT_TYPES.DEPOSIT_OBSERVATION_REJECTED, observation, {
            rejectionReason
        });

        return observation;

    }

    _persistObservation(observation) {

        if (typeof this._persistence.saveDepositObservation !== "function") {

            return null;

        }

        const result = this._persistence.saveDepositObservation(observation);

        if (result != null && typeof result.then === "function") {

            throw new InvalidDepositObservationError(
                "Deposit observation persistence must be synchronous",
                { observationId: observation.observationId }
            );

        }

        return result;

    }

    _emit(type, observation, extra = {}) {

        if (!this._eventBus) {

            return;

        }

        this._eventBus.emit({
            source: EVENT_SOURCES.DEPOSIT_MONITOR,
            type,
            payload: {
                observationId: observation.observationId,
                depositId: observation.depositId,
                depositAddress: observation.depositAddress,
                transactionHash: observation.transactionHash,
                senderWallet: observation.senderWallet,
                amount: observation.amount,
                timestamp: observation.timestamp,
                network: observation.network,
                observationStatus: observation.observationStatus,
                status: observation.observationStatus,
                rejectionReason: observation.rejectionReason,
                playerId: observation.playerId,
                ...extra
            }
        });

    }

    _assertStarted() {

        if (!this._initialized || !this._started) {

            throw new DepositMonitorNotStartedError();

        }

    }

}

export {
    DEPOSIT_OBSERVATION_STATUS,
    DEPOSIT_OBSERVATION_REJECTION_REASONS
} from "./DepositObservationStates.js";
