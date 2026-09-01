/**
 * R18-S16 — Deposit package ready → DeploymentAuthorization VALID.
 * Lets GameEscrow deploy before DEPOSIT_FULL so each player can send one
 * TonConnect transaction covering FundSeat + STAKE.
 *
 * Does not spend TON. Does not call GameContractManager.
 * consumeValidForDeploy remains the deploy spend gate.
 */

import assert from "node:assert/strict";

import { EVENT_TYPES } from "../events/EventTypes.js";
import { DeploymentAuthorizationError } from "./DeploymentAuthorizationErrors.js";
import { DeploymentAuthorizationCoordinator } from "./DeploymentAuthorizationCoordinator.js";
import { DepositSessionError } from "./DepositSessionErrors.js";
import { DEPOSIT_SESSION_STATUS } from "./DepositSessionStates.js";

const ENTRY_READY_STATES = Object.freeze([
    DEPOSIT_SESSION_STATUS.AWAITING_FUNDS,
    DEPOSIT_SESSION_STATUS.PARTIALLY_FUNDED,
    DEPOSIT_SESSION_STATUS.DEPOSIT_FULL
]);

export class EntryDeploymentAuthorizationAutomation {

    constructor({
        logger = null,
        eventBus = null,
        depositSessionCoordinator,
        deploymentAuthorizationCoordinator
    } = {}) {

        this._logger = logger;
        this._eventBus = eventBus;

        assert(depositSessionCoordinator, "depositSessionCoordinator is required");
        assert(
            deploymentAuthorizationCoordinator,
            "deploymentAuthorizationCoordinator is required"
        );

        if (
            !(deploymentAuthorizationCoordinator instanceof DeploymentAuthorizationCoordinator)
            && typeof deploymentAuthorizationCoordinator.createFromEntryReady !== "function"
        ) {

            throw new Error("deploymentAuthorizationCoordinator missing createFromEntryReady");

        }

        this._depositSessionCoordinator = depositSessionCoordinator;
        this._deploymentAuthorizationCoordinator = deploymentAuthorizationCoordinator;
        this._activeRoomGameLocks = new Map();

        this._boundHandler = (envelope) => {

            void this._handleDepositPackagePublished(envelope);

        };

    }

    initialize() {

        if (!this._eventBus || typeof this._eventBus.subscribe !== "function") {

            return;

        }

        this._eventBus.subscribe(
            EVENT_TYPES.DEPOSIT_PACKAGE_PUBLISHED,
            this._boundHandler
        );

    }

    _handleDepositPackagePublished(envelope) {

        const payload = envelope?.payload ?? envelope ?? null;
        const depositId = payload?.depositId ?? null;

        if (!depositId) {

            this._logWarn("DEPOSIT_PACKAGE_PUBLISHED missing depositId", { payload });
            return;

        }

        const session = this._depositSessionCoordinator.getSession?.(depositId)
            ?? this._depositSessionCoordinator.restoreFromPersistence?.(depositId)
            ?? null;

        if (!session) {

            this._logWarn("DEPOSIT_PACKAGE_PUBLISHED restore failed", { depositId });
            return;

        }

        if (!ENTRY_READY_STATES.includes(session.state)) {

            return;

        }

        this._ensureValidFromDepositSession(session);

    }

    _ensureValidFromDepositSession(session) {

        if (!session) {

            throw new DepositSessionError("DepositSession is required", "DEPOSIT_SESSION_REQUIRED");

        }

        const roomId = session.roomId;
        const gameId = session.gameId;
        const key = `${String(roomId ?? "").trim()}::${String(gameId ?? "").trim()}`;

        if (this._activeRoomGameLocks.get(key)) {

            return;

        }

        this._activeRoomGameLocks.set(key, true);

        try {

            return this._tryCreateAndMarkValid(session);

        } finally {

            this._activeRoomGameLocks.delete(key);

        }

    }

    _tryCreateAndMarkValid(session) {

        let createdAuthorization = null;

        try {

            createdAuthorization = this._deploymentAuthorizationCoordinator
                .createFromEntryReady(session);

        } catch (error) {

            if (
                !(error instanceof DeploymentAuthorizationError)
                || error.code !== "DEPLOYMENT_AUTHORIZATION_ALREADY_EXISTS"
            ) {

                throw error;

            }

            const authorizationId = error.details?.authorizationId ?? null;

            if (!authorizationId) {

                return null;

            }

            const restored = this._deploymentAuthorizationCoordinator
                .restoreFromPersistence(authorizationId);

            if (!restored) {

                return null;

            }

            if (restored.status === "CREATED") {

                this._deploymentAuthorizationCoordinator.markValid(restored.authorizationId);

            }

            return restored;

        }

        if (createdAuthorization?.authorizationId) {

            this._deploymentAuthorizationCoordinator.markValid(
                createdAuthorization.authorizationId
            );

        }

        return createdAuthorization;

    }

    _logWarn(message, details) {

        try {

            this._logger?.warn?.(message, details);

        } catch {

            // ignore logger failures

        }

    }

}
