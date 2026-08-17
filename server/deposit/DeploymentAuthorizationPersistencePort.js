/**
 * R17.9L.5A — Persistence port for DeploymentAuthorization.
 * Production adapter writes through TonFinancialPersistence.
 */

import { RecordNotFoundError } from "../persistence/TonFinancialPersistenceErrors.js";
import { TON_FINANCIAL_RECORD_TYPES } from "../persistence/TonFinancialRecordTypes.js";

function authorizationMetadata(authorization) {

    return {
        authorizationId: authorization.authorizationId,
        roomId: authorization.roomId,
        gameId: authorization.gameId,
        status: authorization.status,
        correlationId: authorization.correlationId,
        createdAt: authorization.createdAt,
        updatedAt: authorization.updatedAt,
        tonNetwork: authorization.network
    };

}

function preferAuthorizationRecord(left, right) {

    const rank = {
        VALID: 3,
        CREATED: 2,
        CONSUMED: 1,
        REVOKED: 0
    };

    const leftRank = rank[left.status ?? left.payload?.status] ?? 0;

    const rightRank = rank[right.status ?? right.payload?.status] ?? 0;

    if (leftRank !== rightRank) {

        return leftRank >= rightRank ? left : right;

    }

    return (left.updatedAt ?? 0) >= (right.updatedAt ?? 0) ? left : right;

}

export class DeploymentAuthorizationPersistencePort {

    saveDeploymentAuthorization(_authorization) {

        throw new Error("saveDeploymentAuthorization is not implemented");

    }

    loadDeploymentAuthorization(_authorizationId) {

        throw new Error("loadDeploymentAuthorization is not implemented");

    }

    findDeploymentAuthorization(_roomId, _gameId) {

        throw new Error("findDeploymentAuthorization is not implemented");

    }

    listActiveDeploymentAuthorizations() {

        throw new Error("listActiveDeploymentAuthorizations is not implemented");

    }

    consumeDeploymentAuthorization(_authorizationId, _payload, _metadata) {

        throw new Error("consumeDeploymentAuthorization is not implemented");

    }

    removeDeploymentAuthorization(_authorizationId) {

        throw new Error("removeDeploymentAuthorization is not implemented");

    }

}

export class InMemoryDeploymentAuthorizationPersistence extends DeploymentAuthorizationPersistencePort {

    constructor() {

        super();

        this._byId = new Map();

        this._byRoomGame = new Map();

    }

    _key(roomId, gameId) {

        return `${roomId}::${gameId}`;

    }

    saveDeploymentAuthorization(authorization) {

        const record = authorization.toRecord();

        this._byId.set(record.recordId, record);

        this._byRoomGame.set(this._key(record.roomId, record.gameId), record.recordId);

        return record;

    }

    loadDeploymentAuthorization(authorizationId) {

        return this._byId.get(authorizationId) ?? null;

    }

    findDeploymentAuthorization(roomId, gameId) {

        const authorizationId = this._byRoomGame.get(this._key(roomId, gameId));

        if (!authorizationId) {

            return null;

        }

        return this._byId.get(authorizationId) ?? null;

    }

    listActiveDeploymentAuthorizations() {

        return Object.freeze([...this._byId.values()]);

    }

    consumeDeploymentAuthorization(authorizationId, payload, _metadata = {}) {

        const existing = this._byId.get(authorizationId);

        if (!existing) {

            throw new RecordNotFoundError(
                TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_AUTHORIZATION,
                authorizationId
            );

        }

        const next = Object.freeze({
            ...existing,
            status: payload?.status ?? payload?.state ?? "CONSUMED",
            updatedAt: payload?.updatedAt ?? Date.now(),
            payload: payload ?? existing.payload
        });

        this._byId.set(authorizationId, next);

        return next;

    }

    removeDeploymentAuthorization(authorizationId) {

        const record = this._byId.get(authorizationId);

        if (!record) {

            return false;

        }

        this._byId.delete(authorizationId);

        this._byRoomGame.delete(this._key(record.roomId, record.gameId));

        return true;

    }

}

export class TonFinancialDeploymentAuthorizationPersistence extends DeploymentAuthorizationPersistencePort {

    constructor(financialPersistence) {

        super();

        this._persistence = financialPersistence;

    }

    saveDeploymentAuthorization(authorization) {

        return this._persistence.saveDeploymentAuthorization(
            authorization.toPayload(),
            authorizationMetadata(authorization)
        );

    }

    loadDeploymentAuthorization(authorizationId) {

        try {

            return this._persistence.loadDeploymentAuthorization(authorizationId);

        } catch (error) {

            if (error instanceof RecordNotFoundError || error?.name === "RecordNotFoundError") {

                return null;

            }

            throw error;

        }

    }

    findDeploymentAuthorization(roomId, gameId) {

        return this._persistence.findDeploymentAuthorization(roomId, gameId);

    }

    listActiveDeploymentAuthorizations() {

        return this._persistence.listActiveDeploymentAuthorizations();

    }

    consumeDeploymentAuthorization(authorizationId, payload, metadata = {}) {

        return this._persistence.consumeDeploymentAuthorization(
            authorizationId,
            payload,
            metadata
        );

    }

    removeDeploymentAuthorization(authorizationId) {

        return this._persistence.removeDeploymentAuthorization(authorizationId);

    }

}

export { preferAuthorizationRecord };
