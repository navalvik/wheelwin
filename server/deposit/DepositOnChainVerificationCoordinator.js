/**
 * R17.9L.8 — On-Chain Deposit Verification → DepositSession Integration.
 *
 * Dedicated verification boundary: the ONLY path from
 * DEPOSIT_FULL_ONCHAIN → DepositSession DEPOSIT_FULL.
 *
 * NO real TON. NO GameContractManager. NO client input.
 */

import { DEPOSIT_SESSION_STATUS } from "./DepositSessionStates.js";
import { DEPOSIT_OBSERVATION_STATUS } from "./DepositObservationStates.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { EVENT_SOURCES } from "../events/EventSources.js";

const FUNDABLE_STATES = Object.freeze([
    DEPOSIT_SESSION_STATUS.AWAITING_FUNDS,
    DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED
]);

const REQUIRED_SEAT_COUNT = 3;

export class DepositOnChainVerificationError extends Error {

    constructor(message, details = {}) {

        super(message);

        this.name = "DepositOnChainVerificationError";

        this.details = Object.freeze({ ...details });

    }

}

export class DepositOnChainVerificationCoordinator {

    constructor({
        logger,
        eventBus,
        depositSessionCoordinator,
        observationPersistence,
        network = "testnet"
    }) {

        this._logger = logger ?? { info() {}, warn() {}, error() {}, debug() {} };

        this._eventBus = eventBus;

        this._depositSessionCoordinator = depositSessionCoordinator;

        this._observationPersistence = observationPersistence;

        this._network = network;

        this._boundHandler = null;

        this._processing = new Set();

    }

    initialize() {

        if (!this._eventBus || typeof this._eventBus.subscribe !== "function") {

            return;

        }

        this._boundHandler = (envelope) => this._handleDepositFullOnChain(envelope);

        this._eventBus.subscribe(EVENT_TYPES.DEPOSIT_FULL_ONCHAIN, this._boundHandler);

    }

    shutdown() {

        if (this._boundHandler && this._eventBus?.unsubscribe) {

            this._eventBus.unsubscribe(EVENT_TYPES.DEPOSIT_FULL_ONCHAIN, this._boundHandler);

        }

        this._boundHandler = null;

    }

    /**
     * Recovery entry point: re-verify any sessions that have all observations
     * persisted but were not yet transitioned to DEPOSIT_FULL.
     */
    syncFromPersistedObservations() {

        if (typeof this._depositSessionCoordinator?.listActiveDepositSessions !== "function") {

            return Object.freeze({ scanned: 0, verified: 0, skipped: 0 });

        }

        const sessions = this._depositSessionCoordinator.listActiveDepositSessions();

        let scanned = 0;

        let verified = 0;

        let skipped = 0;

        for (const session of sessions) {

            scanned += 1;

            if (!FUNDABLE_STATES.includes(session.state)) {

                skipped += 1;

                continue;

            }

            try {

                const result = this._verifyAndTransition(session.depositId);

                if (result?.transitioned) {

                    verified += 1;

                } else {

                    skipped += 1;

                }

            } catch {

                skipped += 1;

            }

        }

        return Object.freeze({ scanned, verified, skipped });

    }

    _handleDepositFullOnChain(envelope) {

        const payload = envelope?.payload ?? {};

        const depositId = payload.depositId;

        if (!depositId) {

            this._logger.warn(
                "DepositOnChainVerificationCoordinator: DEPOSIT_FULL_ONCHAIN missing depositId"
            );

            return null;

        }

        if (envelope.source !== EVENT_SOURCES.DEPOSIT_MONITOR) {

            this._logger.warn(
                "DepositOnChainVerificationCoordinator: rejected DEPOSIT_FULL_ONCHAIN from untrusted source",
                { source: envelope.source, depositId }
            );

            return null;

        }

        try {

            return this._verifyAndTransition(depositId);

        } catch (error) {

            this._logger.error(
                "DepositOnChainVerificationCoordinator: verification failed",
                { depositId, error: error.message }
            );

            return null;

        }

    }

    _verifyAndTransition(depositId) {

        if (this._processing.has(depositId)) {

            return { transitioned: false, reason: "already_processing" };

        }

        this._processing.add(depositId);

        try {

            return this._doVerifyAndTransition(depositId);

        } finally {

            this._processing.delete(depositId);

        }

    }

    _doVerifyAndTransition(depositId) {

        const session = this._depositSessionCoordinator.getSession(depositId);

        if (!session) {

            throw new DepositOnChainVerificationError(
                "DepositSession not found",
                { depositId }
            );

        }

        if (session.state === DEPOSIT_SESSION_STATUS.DEPOSIT_FULL) {

            return { transitioned: false, reason: "already_full" };

        }

        if (!FUNDABLE_STATES.includes(session.state)) {

            throw new DepositOnChainVerificationError(
                "DepositSession in non-fundable state",
                { depositId, state: session.state }
            );

        }

        const observations = this._loadValidatedObservations(depositId);

        this._verifyObservations(session, observations);

        this._applyAllFunding(session, observations);

        return { transitioned: true, depositId };

    }

    _loadValidatedObservations(depositId) {

        if (typeof this._observationPersistence?.listDepositObservations !== "function") {

            throw new DepositOnChainVerificationError(
                "Observation persistence unavailable",
                { depositId }
            );

        }

        const all = this._observationPersistence.listDepositObservations(depositId);

        const validated = [];

        const seenTxHashes = new Set();

        for (const record of all) {

            const obs = this._normalizeObservation(record);

            if (obs.observationStatus !== DEPOSIT_OBSERVATION_STATUS.VALIDATED) {

                continue;

            }

            const txKey = `${obs.depositId}__${obs.transactionHash}`;

            if (seenTxHashes.has(txKey)) {

                continue;

            }

            seenTxHashes.add(txKey);

            validated.push(obs);

        }

        return validated;

    }

    _normalizeObservation(record) {

        if (record && typeof record === "object" && record.observationId) {

            return record;

        }

        const payload = record?.payload ?? record ?? {};

        return {
            observationId: payload.observationId ?? record?.recordId,
            depositId: payload.depositId,
            depositAddress: payload.depositAddress,
            transactionHash: payload.transactionHash,
            senderWallet: payload.senderWallet ?? payload.wallet,
            amount: payload.amount,
            network: payload.network ?? payload.tonNetwork ?? "testnet",
            observationStatus: payload.observationStatus ?? payload.status,
            playerId: payload.playerId
        };

    }

    _verifyObservations(session, observations) {

        const depositId = session.depositId;

        if (!session.bindings || session.bindings.length === 0) {

            throw new DepositOnChainVerificationError(
                "DepositSession has no player bindings",
                { depositId }
            );

        }

        const expectedAddress = session.depositAddress;

        const walletToSeat = new Map();

        for (const binding of session.bindings) {

            walletToSeat.set(binding.wallet, binding);

        }

        const fundedWallets = new Set();

        const fundedSeats = [];

        for (const obs of observations) {

            if (obs.depositId !== depositId) {

                throw new DepositOnChainVerificationError(
                    "Observation depositId mismatch",
                    { depositId, observationDepositId: obs.depositId }
                );

            }

            if (expectedAddress && obs.depositAddress !== expectedAddress) {

                throw new DepositOnChainVerificationError(
                    "Observation depositAddress mismatch",
                    { depositId, expected: expectedAddress, actual: obs.depositAddress }
                );

            }

            if (obs.network !== this._network) {

                throw new DepositOnChainVerificationError(
                    "Observation network mismatch",
                    { depositId, expected: this._network, actual: obs.network }
                );

            }

            const seat = walletToSeat.get(obs.senderWallet);

            if (!seat) {

                throw new DepositOnChainVerificationError(
                    "Unknown wallet in observation",
                    { depositId, wallet: obs.senderWallet }
                );

            }

            if (fundedWallets.has(obs.senderWallet)) {

                continue;

            }

            if (obs.amount < seat.expectedAmount) {

                throw new DepositOnChainVerificationError(
                    "Insufficient funding amount",
                    {
                        depositId,
                        wallet: obs.senderWallet,
                        expected: seat.expectedAmount,
                        received: obs.amount
                    }
                );

            }

            fundedWallets.add(obs.senderWallet);

            fundedSeats.push({ obs, seat });

        }

        if (fundedSeats.length < REQUIRED_SEAT_COUNT) {

            throw new DepositOnChainVerificationError(
                "Incomplete funding: not all seats funded",
                {
                    depositId,
                    funded: fundedSeats.length,
                    required: REQUIRED_SEAT_COUNT
                }
            );

        }

        return fundedSeats;

    }

    _applyAllFunding(session, observations) {

        const walletToObs = new Map();

        for (const obs of observations) {

            if (!walletToObs.has(obs.senderWallet)) {

                walletToObs.set(obs.senderWallet, obs);

            }

        }

        for (const binding of session.bindings) {

            if (binding.funded) {

                continue;

            }

            const obs = walletToObs.get(binding.wallet);

            if (!obs) {

                continue;

            }

            this._depositSessionCoordinator.applyFunding(session.depositId, {
                wallet: obs.senderWallet,
                amount: obs.amount,
                fundingEventId: obs.observationId
            });

        }

    }

}
