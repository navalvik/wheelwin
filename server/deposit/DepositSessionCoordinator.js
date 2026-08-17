/**
 * R17.9L.3 — DepositSession coordinator (domain events, no TON, no deploy gate).
 */

import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { DepositSession } from "./DepositSession.js";
import { DepositSessionError } from "./DepositSessionErrors.js";
import { assertDepositIdentity } from "./depositValidation.js";
import { DEPOSIT_SESSION_STATUS } from "./DepositSessionStates.js";
import { InMemoryDepositPersistence } from "./DepositPersistencePort.js";

export class DepositSessionCoordinator {

    constructor({
        eventBus = null,
        persistence = null,
        roomExists = null,
        gameExists = null
    } = {}) {

        this._eventBus = eventBus;

        this._persistence = persistence ?? new InMemoryDepositPersistence();

        this._roomExists = roomExists;

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

        this._store(session);

        this._emit(EVENT_TYPES.DEPOSIT_CREATED, session);

        this._emit(EVENT_TYPES.DEPOSIT_STATE_CHANGED, session, {
            previousState: null
        });

        return session;

    }

    bindPlayers(depositId, players) {

        const session = this._require(depositId);

        const previousState = session.state;

        session.bindPlayers(players, {
            roomExists: this._roomExists,
            gameExists: this._gameExists
        });

        this._store(session);

        this._emit(EVENT_TYPES.DEPOSIT_PLAYER_BOUND, session);

        this._emitStateChanged(session, previousState);

        return session;

    }

    markAwaitingFunds(depositId) {

        return this._run(depositId, (session) => session.markAwaitingFunds());

    }

    applyFunding(depositId, funding) {

        const session = this._require(depositId);

        const previousState = session.state;

        session.applyFunding(funding);

        this._store(session);

        this._emitStateChanged(session, previousState);

        if (session.state === DEPOSIT_SESSION_STATUS.DEPOSIT_FULL) {

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

    async restoreFromPersistence(depositId) {

        const record = await this._persistence.loadDepositSession(depositId);

        if (!record) {

            return null;

        }

        const session = DepositSession.fromRecord(record);

        this._sessions.set(session.depositId, session);

        return session;

    }

    _run(depositId, mutate) {

        const session = this._require(depositId);

        const previousState = session.state;

        mutate(session);

        this._store(session);

        this._emitStateChanged(session, previousState);

        return session;

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

    _store(session) {

        this._sessions.set(session.depositId, session);

        void this._persistence.saveDepositSession(session);

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
