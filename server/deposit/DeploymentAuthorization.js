/**
 * R17.9L.5A — DeploymentAuthorization domain model.
 * One authorization per (roomId, gameId) while CREATED/VALID.
 * Does not deploy, spend TON, or call GameContractManager.
 */

import { randomUUID } from "node:crypto";

import {
    TON_FINANCIAL_RECORD_TYPES
} from "../persistence/TonFinancialRecordTypes.js";
import {
    computeDeploymentAuthorizationHash
} from "./deploymentAuthorizationHash.js";
import {
    InvalidDeploymentAuthorizationTransitionError
} from "./DeploymentAuthorizationErrors.js";
import {
    assertCanCreateDeploymentAuthorization
} from "./deploymentAuthorizationValidation.js";
import {
    canTransitionDeploymentAuthorizationStatus,
    DEPLOYMENT_AUTHORIZATION_STATUS,
    isDeploymentAuthorizationTerminal
} from "./DeploymentAuthorizationStates.js";

export class DeploymentAuthorization {

    constructor({
        authorizationId = null,
        roomId,
        gameId,
        depositId,
        depositStateSnapshot = null,
        bindingHash,
        authorizationHash = null,
        network = "testnet",
        status = DEPLOYMENT_AUTHORIZATION_STATUS.CREATED,
        createdAt = Date.now(),
        updatedAt = null,
        consumedAt = null,
        revokedAt = null,
        validatedAt = null,
        version = 1,
        correlationId = null,
        metadata = null
    } = {}) {

        this.authorizationId = authorizationId ?? `dauth_${randomUUID()}`;

        this.roomId = roomId;

        this.gameId = gameId;

        this.depositId = depositId;

        this.depositStateSnapshot = depositStateSnapshot && typeof depositStateSnapshot === "object"
            ? { ...depositStateSnapshot }
            : null;

        this.bindingHash = bindingHash;

        this.network = network;

        this.status = status ?? DEPLOYMENT_AUTHORIZATION_STATUS.CREATED;

        this.createdAt = createdAt;

        this.updatedAt = updatedAt ?? createdAt;

        this.consumedAt = consumedAt ?? null;

        this.revokedAt = revokedAt ?? null;

        this.validatedAt = validatedAt ?? null;

        this.authorizationHash = authorizationHash
            ?? computeDeploymentAuthorizationHash({
                roomId: this.roomId,
                gameId: this.gameId,
                depositId: this.depositId,
                bindingHash: this.bindingHash,
                createdAt: this.createdAt,
                network: this.network
            });

        this.version = Number(version) || 1;

        this.correlationId = correlationId ?? randomUUID();

        this.metadata = metadata && typeof metadata === "object"
            ? { ...metadata }
            : {};

    }

    static fromDepositSession(session, options = {}) {

        const validated = assertCanCreateDeploymentAuthorization(session, options);

        const createdAt = Date.now();

        return new DeploymentAuthorization({
            roomId: validated.roomId,
            gameId: validated.gameId,
            depositId: validated.depositId,
            depositStateSnapshot: validated.depositStateSnapshot,
            bindingHash: validated.bindingHash,
            network: validated.network,
            createdAt,
            metadata: options.metadata ?? null
        });

    }

    static fromRecord(record) {

        const payload = record?.payload ?? record ?? {};

        return new DeploymentAuthorization({
            authorizationId: payload.authorizationId ?? record?.recordId,
            roomId: payload.roomId,
            gameId: payload.gameId,
            depositId: payload.depositId,
            depositStateSnapshot: payload.depositStateSnapshot ?? null,
            bindingHash: payload.bindingHash,
            authorizationHash: payload.authorizationHash ?? null,
            network: payload.network ?? payload.tonNetwork ?? record?.tonNetwork ?? "testnet",
            status: payload.status ?? payload.state ?? record?.status
                ?? DEPLOYMENT_AUTHORIZATION_STATUS.CREATED,
            createdAt: payload.createdAt ?? record?.createdAt ?? Date.now(),
            updatedAt: payload.updatedAt ?? record?.updatedAt ?? Date.now(),
            consumedAt: payload.consumedAt ?? null,
            revokedAt: payload.revokedAt ?? null,
            validatedAt: payload.validatedAt ?? null,
            version: payload.version ?? record?.version ?? 1,
            correlationId: payload.correlationId ?? record?.correlationId ?? null,
            metadata: payload.metadata ?? null
        });

    }

    transitionTo(nextStatus, patch = {}) {

        if (!canTransitionDeploymentAuthorizationStatus(this.status, nextStatus)) {

            throw new InvalidDeploymentAuthorizationTransitionError(
                this.authorizationId,
                this.status,
                nextStatus
            );

        }

        this.status = nextStatus;

        this.updatedAt = patch.updatedAt ?? Date.now();

        this.version += 1;

        return this;

    }

    markValid() {

        this.transitionTo(DEPLOYMENT_AUTHORIZATION_STATUS.VALID);

        this.validatedAt = this.updatedAt;

        return this;

    }

    consume() {

        this.transitionTo(DEPLOYMENT_AUTHORIZATION_STATUS.CONSUMED);

        this.consumedAt = this.updatedAt;

        return this;

    }

    revoke() {

        this.transitionTo(DEPLOYMENT_AUTHORIZATION_STATUS.REVOKED);

        this.revokedAt = this.updatedAt;

        return this;

    }

    isTerminal() {

        return isDeploymentAuthorizationTerminal(this.status);

    }

    replaceFromRecord(record) {

        const next = DeploymentAuthorization.fromRecord(record);

        this.authorizationId = next.authorizationId;

        this.roomId = next.roomId;

        this.gameId = next.gameId;

        this.depositId = next.depositId;

        this.depositStateSnapshot = next.depositStateSnapshot
            ? { ...next.depositStateSnapshot }
            : null;

        this.bindingHash = next.bindingHash;

        this.authorizationHash = next.authorizationHash;

        this.network = next.network;

        this.status = next.status;

        this.createdAt = next.createdAt;

        this.updatedAt = next.updatedAt;

        this.consumedAt = next.consumedAt;

        this.revokedAt = next.revokedAt;

        this.validatedAt = next.validatedAt;

        this.version = next.version;

        this.correlationId = next.correlationId;

        this.metadata = { ...next.metadata };

        return this;

    }

    toPayload() {

        return Object.freeze({
            authorizationId: this.authorizationId,
            roomId: this.roomId,
            gameId: this.gameId,
            depositId: this.depositId,
            depositStateSnapshot: this.depositStateSnapshot
                ? Object.freeze({ ...this.depositStateSnapshot })
                : null,
            bindingHash: this.bindingHash,
            authorizationHash: this.authorizationHash,
            network: this.network,
            tonNetwork: this.network,
            status: this.status,
            state: this.status,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            consumedAt: this.consumedAt,
            revokedAt: this.revokedAt,
            validatedAt: this.validatedAt,
            version: this.version,
            correlationId: this.correlationId,
            metadata: Object.freeze({ ...this.metadata })
        });

    }

    toRecord() {

        const payload = this.toPayload();

        return Object.freeze({
            recordType: TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_AUTHORIZATION,
            recordId: this.authorizationId,
            roomId: this.roomId,
            gameId: this.gameId,
            status: this.status,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            correlationId: this.correlationId,
            version: this.version,
            payload
        });

    }

}
