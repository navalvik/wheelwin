/**
 * R17.9L.5A — DeploymentAuthorization coordinator.
 * Persist then EventBus. Does not deploy, spend TON, or call GameContractManager.
 */

import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { DeploymentAuthorization } from "./DeploymentAuthorization.js";
import {
    DeploymentAuthorizationError
} from "./DeploymentAuthorizationErrors.js";
import { InMemoryDeploymentAuthorizationPersistence } from "./DeploymentAuthorizationPersistencePort.js";
import { assertAuthorizationReadyForDeploy } from "./deploymentAuthorizationValidation.js";
import {
    DEPLOYMENT_AUTHORIZATION_STATUS,
    isRestorableDeploymentAuthorizationStatus
} from "./DeploymentAuthorizationStates.js";

export class DeploymentAuthorizationCoordinator {

    constructor({
        eventBus = null,
        persistence = null,
        roomExists = null,
        gameExists = null
    } = {}) {

        this._eventBus = eventBus;

        this._persistence = persistence ?? new InMemoryDeploymentAuthorizationPersistence();

        this._roomExists = roomExists;

        this._gameExists = gameExists;

        this._authorizations = new Map();

    }

    createFromDepositSession(session, options = {}) {

        const authorization = DeploymentAuthorization.fromDepositSession(session, {
            ...options,
            roomExists: options.roomExists ?? this._roomExists,
            gameExists: options.gameExists ?? this._gameExists
        });

        const existing = this.getByRoomAndGame(authorization.roomId, authorization.gameId)
            ?? this._loadExisting(authorization.roomId, authorization.gameId);

        if (
            existing
            && existing.status !== DEPLOYMENT_AUTHORIZATION_STATUS.REVOKED
        ) {

            throw new DeploymentAuthorizationError(
                `DeploymentAuthorization already exists | roomId=${authorization.roomId} | `
                    + `gameId=${authorization.gameId}`,
                "DEPLOYMENT_AUTHORIZATION_ALREADY_EXISTS",
                {
                    roomId: authorization.roomId,
                    gameId: authorization.gameId,
                    authorizationId: existing.authorizationId,
                    status: existing.status
                }
            );

        }

        this._commitNew(authorization);

        this._emit(EVENT_TYPES.DEPLOY_AUTHORIZATION_CREATED, authorization);

        return authorization;

    }

    createFromEntryReady(session, options = {}) {

        const authorization = DeploymentAuthorization.fromEntryReady(session, {
            ...options,
            roomExists: options.roomExists ?? this._roomExists,
            gameExists: options.gameExists ?? this._gameExists
        });

        const existing = this.getByRoomAndGame(authorization.roomId, authorization.gameId)
            ?? this._loadExisting(authorization.roomId, authorization.gameId);

        if (
            existing
            && existing.status !== DEPLOYMENT_AUTHORIZATION_STATUS.REVOKED
        ) {

            throw new DeploymentAuthorizationError(
                `DeploymentAuthorization already exists | roomId=${authorization.roomId} | `
                    + `gameId=${authorization.gameId}`,
                "DEPLOYMENT_AUTHORIZATION_ALREADY_EXISTS",
                {
                    roomId: authorization.roomId,
                    gameId: authorization.gameId,
                    authorizationId: existing.authorizationId,
                    status: existing.status
                }
            );

        }

        this._commitNew(authorization);

        this._emit(EVENT_TYPES.DEPLOY_AUTHORIZATION_CREATED, authorization);

        return authorization;

    }

    createFromGameEscrowReady(session, options = {}) {

        const authorization = DeploymentAuthorization.fromGameEscrowReady(session, {
            ...options,
            roomExists: options.roomExists ?? this._roomExists,
            gameExists: options.gameExists ?? this._gameExists
        });

        const existing = this.getByRoomAndGame(authorization.roomId, authorization.gameId)
            ?? this._loadExisting(authorization.roomId, authorization.gameId);

        if (
            existing
            && existing.status !== DEPLOYMENT_AUTHORIZATION_STATUS.REVOKED
        ) {

            throw new DeploymentAuthorizationError(
                `DeploymentAuthorization already exists | roomId=${authorization.roomId} | `
                    + `gameId=${authorization.gameId}`,
                "DEPLOYMENT_AUTHORIZATION_ALREADY_EXISTS",
                {
                    roomId: authorization.roomId,
                    gameId: authorization.gameId,
                    authorizationId: existing.authorizationId,
                    status: existing.status
                }
            );

        }

        this._commitNew(authorization);

        this._emit(EVENT_TYPES.DEPLOY_AUTHORIZATION_CREATED, authorization);

        return authorization;

    }

    markValid(authorizationId) {

        const authorization = this._run(authorizationId, (current) => current.markValid());

        this._emit(EVENT_TYPES.DEPLOY_AUTHORIZATION_VALID, authorization);

        return authorization;

    }

    consume(authorizationId) {

        const authorization = this._require(authorizationId);

        const snapshot = authorization.toRecord();

        try {

            authorization.consume();

            if (typeof this._persistence.consumeDeploymentAuthorization === "function") {

                this._persistence.consumeDeploymentAuthorization(
                    authorization.authorizationId,
                    authorization.toPayload(),
                    {
                        authorizationId: authorization.authorizationId,
                        roomId: authorization.roomId,
                        gameId: authorization.gameId,
                        status: authorization.status,
                        correlationId: authorization.correlationId,
                        updatedAt: authorization.updatedAt,
                        tonNetwork: authorization.network
                    }
                );

            } else {

                this._persist(authorization);

            }

        } catch (error) {

            authorization.replaceFromRecord(snapshot);

            this._authorizations.set(authorization.authorizationId, authorization);

            throw error;

        }

        this._authorizations.set(authorization.authorizationId, authorization);

        this._emit(EVENT_TYPES.DEPLOY_AUTHORIZATION_CONSUMED, authorization);

        return authorization;

    }

    revoke(authorizationId) {

        const authorization = this._run(authorizationId, (current) => current.revoke());

        this._emit(EVENT_TYPES.DEPLOY_AUTHORIZATION_REVOKED, authorization);

        return authorization;

    }

    getAuthorization(authorizationId) {

        return this._authorizations.get(authorizationId) ?? null;

    }

    getByRoomAndGame(roomId, gameId) {

        for (const authorization of this._authorizations.values()) {

            if (authorization.roomId === roomId && authorization.gameId === gameId) {

                return authorization;

            }

        }

        return null;

    }

    /**
     * Fail-closed consume for GameContractManager deploy.
     * Does not inspect deposits, chain, or refunds.
     */
    consumeValidForDeploy({ roomId, gameId, network = null } = {}) {

        const expectedRoom = String(roomId ?? "").trim();

        const expectedGame = String(gameId ?? "").trim();

        let authorization = this.getByRoomAndGame(expectedRoom, expectedGame)
            ?? this._loadExisting(expectedRoom, expectedGame);

        if (authorization) {

            this._authorizations.set(authorization.authorizationId, authorization);

        }

        assertAuthorizationReadyForDeploy(authorization, {
            roomId: expectedRoom,
            gameId: expectedGame,
            network
        });

        return this.consume(authorization.authorizationId);

    }

    restoreFromPersistence(authorizationId) {

        const record = this._persistence.loadDeploymentAuthorization(authorizationId);

        if (!record) {

            return null;

        }

        const authorization = DeploymentAuthorization.fromRecord(record);

        this._authorizations.set(authorization.authorizationId, authorization);

        return authorization;

    }

    /**
     * Restore VALID (usable) and CONSUMED (history) authorizations after restart.
     * Does not emit domain events or trigger deployment.
     */
    restoreActiveAuthorizations() {

        if (typeof this._persistence.listActiveDeploymentAuthorizations !== "function") {

            return Object.freeze({
                restored: 0,
                skipped: 0
            });

        }

        const records = this._persistence.listActiveDeploymentAuthorizations() ?? [];

        let restored = 0;

        let skipped = 0;

        for (const record of records) {

            const authorization = DeploymentAuthorization.fromRecord(record);

            if (!isRestorableDeploymentAuthorizationStatus(authorization.status)) {

                skipped += 1;

                continue;

            }

            this._authorizations.set(authorization.authorizationId, authorization);

            restored += 1;

        }

        return Object.freeze({
            restored,
            skipped
        });

    }

    _loadExisting(roomId, gameId) {

        if (typeof this._persistence.findDeploymentAuthorization !== "function") {

            return null;

        }

        const record = this._persistence.findDeploymentAuthorization(roomId, gameId);

        if (!record) {

            return null;

        }

        return DeploymentAuthorization.fromRecord(record);

    }

    _run(authorizationId, mutate) {

        const authorization = this._require(authorizationId);

        this._mutate(authorization, mutate);

        return authorization;

    }

    _mutate(authorization, mutate) {

        const snapshot = authorization.toRecord();

        try {

            mutate(authorization);

            this._persist(authorization);

        } catch (error) {

            authorization.replaceFromRecord(snapshot);

            this._authorizations.set(authorization.authorizationId, authorization);

            throw error;

        }

        this._authorizations.set(authorization.authorizationId, authorization);

    }

    _commitNew(authorization) {

        this._persist(authorization);

        this._authorizations.set(authorization.authorizationId, authorization);

    }

    _require(authorizationId) {

        const authorization = this._authorizations.get(authorizationId);

        if (!authorization) {

            throw new DeploymentAuthorizationError(
                `DeploymentAuthorization not found | authorizationId=${authorizationId}`,
                "DEPLOYMENT_AUTHORIZATION_NOT_FOUND",
                { authorizationId }
            );

        }

        return authorization;

    }

    _persist(authorization) {

        if (typeof this._persistence.saveDeploymentAuthorization !== "function") {

            throw new DeploymentAuthorizationError(
                "DeploymentAuthorization persistence is not configured",
                "DEPLOYMENT_AUTHORIZATION_PERSISTENCE_UNAVAILABLE",
                { authorizationId: authorization.authorizationId }
            );

        }

        const result = this._persistence.saveDeploymentAuthorization(authorization);

        if (result != null && typeof result.then === "function") {

            throw new DeploymentAuthorizationError(
                "DeploymentAuthorization persistence must be synchronous",
                "DEPLOYMENT_AUTHORIZATION_PERSISTENCE_ASYNC",
                { authorizationId: authorization.authorizationId }
            );

        }

        return result;

    }

    _emit(type, authorization) {

        if (!this._eventBus) {

            return;

        }

        this._eventBus.emit({
            source: EVENT_SOURCES.DEPLOYMENT_AUTHORIZATION_COORDINATOR,
            type,
            payload: {
                authorizationId: authorization.authorizationId,
                roomId: authorization.roomId,
                gameId: authorization.gameId,
                depositId: authorization.depositId,
                status: authorization.status,
                authorizationHash: authorization.authorizationHash
            }
        });

    }

}
