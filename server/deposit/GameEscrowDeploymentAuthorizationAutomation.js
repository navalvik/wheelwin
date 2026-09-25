/**
 * GameEscrow-only player payment: PaymentSession created → DeploymentAuthorization VALID.
 * Server deploys GameEscrow without a Deposit Contract / FundSeat layer.
 *
 * Does not spend TON. Does not call GameContractManager.
 * consumeValidForDeploy remains the deploy spend gate.
 */

import assert from "node:assert/strict";

import { EVENT_TYPES } from "../events/EventTypes.js";
import { DeploymentAuthorizationError } from "./DeploymentAuthorizationErrors.js";
import { DeploymentAuthorizationCoordinator } from "./DeploymentAuthorizationCoordinator.js";

export class GameEscrowDeploymentAuthorizationAutomation {

    constructor({
        logger = null,
        eventBus = null,
        paymentSessionManager = null,
        deploymentAuthorizationCoordinator,
        enabled = false
    } = {}) {

        this._logger = logger;
        this._eventBus = eventBus;
        this._paymentSessionManager = paymentSessionManager;
        this._enabled = enabled === true;
        this._initialized = false;

        assert(
            deploymentAuthorizationCoordinator,
            "deploymentAuthorizationCoordinator is required"
        );

        if (
            !(deploymentAuthorizationCoordinator instanceof DeploymentAuthorizationCoordinator)
            && typeof deploymentAuthorizationCoordinator.createFromGameEscrowReady !== "function"
        ) {

            throw new Error(
                "deploymentAuthorizationCoordinator missing createFromGameEscrowReady"
            );

        }

        this._deploymentAuthorizationCoordinator = deploymentAuthorizationCoordinator;
        this._activeRoomGameLocks = new Map();

        this._boundHandler = (envelope) => {

            try {

                this._handlePaymentSessionCreated(envelope);

            } catch (error) {

                this._logWarn("GameEscrow DeploymentAuthorization failed", {
                    roomId: envelope?.payload?.roomId ?? null,
                    error: error?.message ?? String(error)
                });

            }

        };

    }

    initialize() {

        if (!this._enabled || this._initialized) {

            return;

        }

        if (!this._eventBus || typeof this._eventBus.subscribe !== "function") {

            return;

        }

        this._eventBus.subscribe(
            EVENT_TYPES.PAYMENT_SESSION_CREATED,
            this._boundHandler
        );

        this._initialized = true;

    }

    shutdown() {

        if (this._eventBus?.unsubscribe && this._initialized) {

            this._eventBus.unsubscribe(
                EVENT_TYPES.PAYMENT_SESSION_CREATED,
                this._boundHandler
            );

        }

        this._initialized = false;

    }

    _handlePaymentSessionCreated(envelope) {

        const payload = envelope?.payload ?? envelope ?? null;
        const roomId = typeof payload?.roomId === "string" ? payload.roomId.trim() : "";

        if (!roomId) {

            this._logWarn("PAYMENT_SESSION_CREATED missing roomId", { payload });
            return;

        }

        const session = this._paymentSessionManager?.getSession?.(roomId) ?? null;

        if (!session) {

            this._logWarn("PAYMENT_SESSION_CREATED session missing", { roomId });
            return;

        }

        this._ensureValidFromPaymentSession(session);

    }

    _ensureValidFromPaymentSession(session) {

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
                .createFromGameEscrowReady(session);

        } catch (error) {

            if (
                !(error instanceof DeploymentAuthorizationError)
                || error.code !== "DEPLOYMENT_AUTHORIZATION_ALREADY_EXISTS"
            ) {

                this._logWarn("GameEscrow DeploymentAuthorization create failed", {
                    roomId: session?.roomId ?? null,
                    gameId: session?.gameId ?? null,
                    error: error?.message ?? String(error)
                });

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
