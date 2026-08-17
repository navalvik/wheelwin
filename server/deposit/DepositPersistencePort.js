/**
 * R17.9L.4 — Persistence port for DepositSession.
 *
 * Production adapter writes through TonFinancialPersistence (same store as
 * payment sessions). Methods are synchronous: persist must complete before
 * domain events are emitted.
 */

import { RecordNotFoundError } from "../persistence/TonFinancialPersistenceErrors.js";

export class DepositPersistencePort {

    saveDepositSession(_session) {

        throw new Error("DepositPersistencePort.saveDepositSession is not implemented");

    }

    loadDepositSession(_depositId) {

        throw new Error("DepositPersistencePort.loadDepositSession is not implemented");

    }

    listActiveDepositSessions() {

        throw new Error("DepositPersistencePort.listActiveDepositSessions is not implemented");

    }

    removeDepositSession(_depositId) {

        throw new Error("DepositPersistencePort.removeDepositSession is not implemented");

    }

    loadByRoomAndGame(_roomId, _gameId) {

        throw new Error("DepositPersistencePort.loadByRoomAndGame is not implemented");

    }

}

/**
 * In-memory adapter for unit tests. Serializes via DepositSession.toRecord().
 */
export class InMemoryDepositPersistence extends DepositPersistencePort {

    constructor() {

        super();

        this._byId = new Map();

        this._byRoomGame = new Map();

    }

    _key(roomId, gameId) {

        return `${roomId}::${gameId}`;

    }

    saveDepositSession(session) {

        const record = session.toRecord();

        this._byId.set(record.recordId, record);

        this._byRoomGame.set(this._key(record.roomId, record.gameId), record.recordId);

        return record;

    }

    loadDepositSession(depositId) {

        return this._byId.get(depositId) ?? null;

    }

    listActiveDepositSessions() {

        return Object.freeze([...this._byId.values()]);

    }

    removeDepositSession(depositId) {

        const record = this._byId.get(depositId);

        if (!record) {

            return false;

        }

        this._byId.delete(depositId);

        this._byRoomGame.delete(this._key(record.roomId, record.gameId));

        return true;

    }

    loadByRoomAndGame(roomId, gameId) {

        const depositId = this._byRoomGame.get(this._key(roomId, gameId));

        if (!depositId) {

            return null;

        }

        return this._byId.get(depositId) ?? null;

    }

}

function depositMetadata(session) {

    return {
        depositId: session.depositId,
        roomId: session.roomId,
        gameId: session.gameId,
        status: session.state,
        correlationId: session.correlationId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
    };

}

/**
 * Durable adapter over TonFinancialPersistence.
 * Does not create a second store.
 */
export class TonFinancialDepositPersistence extends DepositPersistencePort {

    constructor(financialPersistence) {

        super();

        this._persistence = financialPersistence;

    }

    saveDepositSession(session) {

        return this._persistence.saveDepositSession(
            session.toPayload(),
            depositMetadata(session)
        );

    }

    loadDepositSession(depositId) {

        try {

            return this._persistence.loadDepositSession(depositId);

        } catch (error) {

            if (error instanceof RecordNotFoundError || error?.name === "RecordNotFoundError") {

                return null;

            }

            throw error;

        }

    }

    listActiveDepositSessions() {

        return this._persistence.listActiveDepositSessions();

    }

    removeDepositSession(depositId) {

        return this._persistence.removeDepositSession(depositId);

    }

    loadByRoomAndGame(roomId, gameId) {

        const records = this.listActiveDepositSessions();

        return records.find((record) => (
            record.roomId === roomId && record.gameId === gameId
        )) ?? null;

    }

}
