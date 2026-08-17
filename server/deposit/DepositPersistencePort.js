/**
 * R17.9L.3 — Persistence port for DepositSession.
 *
 * Does not write to TonFinancialPersistence yet.
 * Records use recordType deposit_session for future compatibility.
 */

export class DepositPersistencePort {

    async saveDepositSession(_session) {

        throw new Error("DepositPersistencePort.saveDepositSession is not implemented");

    }

    async loadDepositSession(_depositId) {

        throw new Error("DepositPersistencePort.loadDepositSession is not implemented");

    }

    async loadByRoomAndGame(_roomId, _gameId) {

        throw new Error("DepositPersistencePort.loadByRoomAndGame is not implemented");

    }

}

/**
 * In-memory adapter for tests and skeleton recovery.
 * Not a production store — serializes via DepositSession.toRecord().
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

    async saveDepositSession(session) {

        const record = session.toRecord();

        this._byId.set(record.recordId, record);

        this._byRoomGame.set(this._key(record.roomId, record.gameId), record.recordId);

        return record;

    }

    async loadDepositSession(depositId) {

        return this._byId.get(depositId) ?? null;

    }

    async loadByRoomAndGame(roomId, gameId) {

        const depositId = this._byRoomGame.get(this._key(roomId, gameId));

        if (!depositId) {

            return null;

        }

        return this._byId.get(depositId) ?? null;

    }

}
