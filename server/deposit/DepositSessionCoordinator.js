/**
 * R17.9L.4 — DepositSession coordinator (persist then EventBus; no TON, no deploy).
 */

import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { DepositSession } from "./DepositSession.js";
import { DepositSessionError } from "./DepositSessionErrors.js";
import {
    assertDepositIdentity,
    resolveReservedDepositWallets
} from "./depositValidation.js";
import {
    DEPOSIT_SESSION_STATUS,
    isRestorableDepositSessionStatus
} from "./DepositSessionStates.js";
import { InMemoryDepositPersistence } from "./DepositPersistencePort.js";

export class DepositSessionCoordinator {

    constructor({
        eventBus = null,
        persistence = null,
        roomExists = null,
        gameExists = null,
        reservedWallets = null,
        env = null
    } = {}) {

        this._eventBus = eventBus;

        this._persistence = persistence ?? new InMemoryDepositPersistence();

        this._roomExists = roomExists;

        this._reservedWallets = reservedWallets
            ?? resolveReservedDepositWallets(env ?? process.env);

        this._gameExists = gameExists;

        this._sessions = new Map();

    }

    createSession({ roomId, gameId, metadata = null } = {}) {

        const identity = assertDepositIdentity({
            roomId,
            gameId,
            roomExists: this._roomExists,
            gameExists: this._gameExists
        });

        const existing = this.getByRoomAndGame(identity.roomId, identity.gameId);

        if (existing) {

            throw new DepositSessionError(
                `Deposit session already exists | roomId=${identity.roomId} | gameId=${identity.gameId}`,
                "DEPOSIT_SESSION_ALREADY_EXISTS",
                identity
            );

        }

        const session = new DepositSession({
            roomId: identity.roomId,
            gameId: identity.gameId,
            metadata
        });

        this._commitNew(session);

        this._emit(EVENT_TYPES.DEPOSIT_CREATED, session);

        this._emit(EVENT_TYPES.DEPOSIT_STATE_CHANGED, session, {
            previousState: null
        });

        return session;

    }

    bindPlayers(depositId, players) {

        const session = this._require(depositId);

        const previousState = session.state;

        this._mutate(session, (current) => {

            current.bindPlayers(players, {
                roomExists: this._roomExists,
                gameExists: this._gameExists,
                reservedWallets: this._reservedWallets
            });

        });

        this._emit(EVENT_TYPES.DEPOSIT_PLAYER_BOUND, session);

        this._emitStateChanged(session, previousState);

        return session;

    }

    /**
     * Assign the authoritative deposit contract address.
     * Validates, persists atomically, then commits in-memory.
     */
    setDepositAddress(depositId, depositAddress) {

        return this._run(depositId, (session) => session.setDepositAddress(depositAddress));

    }

    markAwaitingFunds(depositId) {

        return this._run(depositId, (session) => session.markAwaitingFunds());

    }

    applyFunding(depositId, funding) {

        const session = this._require(depositId);

        const previousState = session.state;

        this._run(depositId, (current) => current.applyFunding(funding));

        if (
            session.state === DEPOSIT_SESSION_STATUS.DEPOSIT_FULL
            && previousState !== DEPOSIT_SESSION_STATUS.DEPOSIT_FULL
        ) {

            this._emit(EVENT_TYPES.DEPOSIT_FULL, session);

        }

        return session;

    }

    expire(depositId) {

        const session = this._run(depositId, (current) => current.expire());

        this._emit(EVENT_TYPES.DEPOSIT_EXPIRED, session);

        return session;

    }

    startRefund(depositId) {

        const session = this._run(depositId, (current) => current.startRefund());

        this._emit(EVENT_TYPES.DEPOSIT_REFUND_STARTED, session);

        return session;

    }

    completeRefund(depositId) {

        const session = this._run(depositId, (current) => current.completeRefund());

        this._emit(EVENT_TYPES.DEPOSIT_REFUNDED, session);

        return session;

    }

    authorizeDeploy(depositId) {

        return this._run(depositId, (session) => session.authorizeDeploy());

    }

    markGameContractCreated(depositId) {

        return this._run(depositId, (session) => session.markGameContractCreated());

    }

    release(depositId) {

        return this._run(depositId, (session) => session.release());

    }

    reimburse(depositId) {

        return this._run(depositId, (session) => session.reimburse());

    }

    getSession(depositId) {

        return this._sessions.get(depositId) ?? null;

    }

    getByRoomAndGame(roomId, gameId) {

        for (const session of this._sessions.values()) {

            if (session.roomId === roomId && session.gameId === gameId) {

                return session;

            }

        }

        return null;

    }

    restoreFromPersistence(depositId) {

        const record = this._persistence.loadDepositSession(depositId);

        if (!record) {

            return null;

        }

        const session = DepositSession.fromRecord(record);

        this._sessions.set(session.depositId, session);

        return session;

    }

    /**
     * Restore restorable sessions after restart.
     * Does not emit DEPOSIT_FULL, authorization, or deployment events.
     */
    restoreActiveSessions() {

        if (typeof this._persistence.listActiveDepositSessions !== "function") {

            return Object.freeze({
                restored: 0,
                skipped: 0
            });

        }

        const records = this._persistence.listActiveDepositSessions() ?? [];

        let restored = 0;

        let skipped = 0;

        for (const record of records) {

            const session = DepositSession.fromRecord(record);

            if (!isRestorableDepositSessionStatus(session.state)) {

                skipped += 1;

                continue;

            }

            this._sessions.set(session.depositId, session);

            restored += 1;

        }

        return Object.freeze({
            restored,
            skipped
        });

    }

    /**
     * In-memory snapshot of currently restored/created active sessions.
     * Used for deployment-authorization automation (no events emitted).
     */
    listActiveDepositSessions() {
        return Object.freeze([...this._sessions.values()]);
    }

    _run(depositId, mutate) {

        const session = this._require(depositId);

        const previousState = session.state;

        this._mutate(session, mutate);

        this._emitStateChanged(session, previousState);

        return session;

    }

    _mutate(session, mutate) {

        const snapshot = session.toRecord();

        try {

            mutate(session);

            this._persist(session);

        } catch (error) {

            session.replaceFromRecord(snapshot);

            this._sessions.set(session.depositId, session);

            throw error;

        }

        this._sessions.set(session.depositId, session);

    }

    _commitNew(session) {

        this._persist(session);

        this._sessions.set(session.depositId, session);

    }

    _require(depositId) {

        const session = this._sessions.get(depositId);

        if (!session) {

            throw new DepositSessionError(
                `Deposit session not found | depositId=${depositId}`,
                "DEPOSIT_SESSION_NOT_FOUND",
                { depositId }
            );

        }

        return session;

    }

    _persist(session) {

        if (typeof this._persistence.saveDepositSession !== "function") {

            throw new DepositSessionError(
                "Deposit persistence is not configured",
                "DEPOSIT_PERSISTENCE_UNAVAILABLE",
                { depositId: session.depositId }
            );

        }

        const result = this._persistence.saveDepositSession(session);

        if (result != null && typeof result.then === "function") {

            throw new DepositSessionError(
                "Deposit persistence saveDepositSession must be synchronous",
                "DEPOSIT_PERSISTENCE_ASYNC",
                { depositId: session.depositId }
            );

        }

        return result;

    }

    _emitStateChanged(session, previousState) {

        if (previousState === session.state) {

            return;

        }

        this._emit(EVENT_TYPES.DEPOSIT_STATE_CHANGED, session, { previousState });

    }

    _emit(type, session, extra = {}) {

        if (!this._eventBus) {

            return;

        }

        this._eventBus.emit({
            source: EVENT_SOURCES.DEPOSIT_SESSION_COORDINATOR,
            type,
            payload: {
                depositId: session.depositId,
                roomId: session.roomId,
                gameId: session.gameId,
                state: session.state,
                ...extra
            }
        });

    }

}
