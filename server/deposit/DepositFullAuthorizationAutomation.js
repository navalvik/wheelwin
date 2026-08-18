/**
 * R17.9L.6 — DepositFull → DeploymentAuthorization VALID automation.
 * NO TON, NO Page4, NO GameContractManager integration.
 */

import assert from "node:assert/strict";

import { EVENT_TYPES } from "../events/EventTypes.js";
import { DeploymentAuthorizationError } from "./DeploymentAuthorizationErrors.js";
import { DeploymentAuthorizationCoordinator } from "./DeploymentAuthorizationCoordinator.js";

import { DepositSessionError } from "./DepositSessionErrors.js";
import { DEPOSIT_SESSION_STATUS } from "./DepositSessionStates.js";

/**
 * @typedef {import("./DepositSession.js").DepositSession} DepositSession
 */

export class DepositFullAuthorizationAutomation {

    constructor({
        logger = null,
        eventBus = null,
        depositSessionCoordinator,
        deploymentAuthorizationCoordinator
    } = {}) {
        this._logger = logger;
        this._eventBus = eventBus;

        assert(depositSessionCoordinator, "depositSessionCoordinator is required");
        assert(deploymentAuthorizationCoordinator, "deploymentAuthorizationCoordinator is required");

        if (!(deploymentAuthorizationCoordinator instanceof DeploymentAuthorizationCoordinator)) {
            // Keep runtime type check permissive (tests may use subclasses/mocks).
            // Still require the expected method surface.
            if (typeof deploymentAuthorizationCoordinator.createFromDepositSession !== "function") {
                throw new Error("deploymentAuthorizationCoordinator missing required methods");
            }
        }

        this._depositSessionCoordinator = depositSessionCoordinator;
        this._deploymentAuthorizationCoordinator = deploymentAuthorizationCoordinator;

        this._activeRoomGameLocks = new Map(); // key(roomId,gameId) -> true

        this._boundHandler = (envelope) => {
            // EventBus handler contract passes envelope argument in this codebase style.
            void this._handleDepositFull(envelope);
        };
    }

    initialize() {
        if (!this._eventBus || typeof this._eventBus.subscribe !== "function") {
            return;
        }

        this._eventBus.subscribe(EVENT_TYPES.DEPOSIT_FULL, this._boundHandler);
    }

    syncFromActiveDepositSessions() {
        if (
            typeof this._depositSessionCoordinator?.listActiveDepositSessions !== "function"
        ) {
            return Object.freeze({ ok: true, scanned: 0, skipped: 0 });
        }

        const sessions = this._depositSessionCoordinator.listActiveDepositSessions();
        let scanned = 0;
        let skipped = 0;

        for (const session of sessions) {
            scanned += 1;
            if (session?.state !== DEPOSIT_SESSION_STATUS.DEPOSIT_FULL) {
                skipped += 1;
                continue;
            }

            // Synchronous best-effort creation.
            try {
                this._ensureValidFromDepositSession(session);
            } catch (error) {
                this._logWarn("SYNC DEPOSIT_FULL auth failed", {
                    roomId: session?.roomId,
                    gameId: session?.gameId,
                    depositId: session?.depositId,
                    error: error?.message ?? String(error)
                });
            }
        }

        return Object.freeze({ ok: true, scanned, skipped });
    }

    async _handleDepositFull(envelope) {
        const payload = envelope?.payload ?? envelope ?? null;

        const depositId = payload?.depositId ?? null;
        if (!depositId) {
            this._logWarn("DEPOSIT_FULL missing depositId", { payload });
            return;
        }

        const persisted = this._depositSessionCoordinator.restoreFromPersistence(depositId);
        if (!persisted) {
            this._logWarn("DEPOSIT_FULL restore failed (missing persistence)", { depositId });
            return;
        }

        if (persisted.state !== DEPOSIT_SESSION_STATUS.DEPOSIT_FULL) {
            // Fail closed: wrong state must not create authorization.
            return;
        }

        this._ensureValidFromDepositSession(persisted);
    }

    _ensureValidFromDepositSession(session) {
        if (!session) {
            throw new DepositSessionError("DepositSession is required", "DEPOSIT_SESSION_REQUIRED");
        }

        const roomId = session.roomId;
        const gameId = session.gameId;
        const key = `${String(roomId ?? "").trim()}::${String(gameId ?? "").trim()}`;

        if (this._activeRoomGameLocks.get(key)) {
            // Duplicate event while the first handler is processing.
            return;
        }

        this._activeRoomGameLocks.set(key, true);

        try {
            const created = this._tryCreateAndMarkValid(session);
            return created;
        } finally {
            this._activeRoomGameLocks.delete(key);
        }
    }

    _tryCreateAndMarkValid(session) {
        let createdAuthorization = null;

        try {
            createdAuthorization = this._deploymentAuthorizationCoordinator.createFromDepositSession(session);
        } catch (error) {
            if (
                !(error instanceof DeploymentAuthorizationError)
                || error.code !== "DEPLOYMENT_AUTHORIZATION_ALREADY_EXISTS"
            ) {
                throw error;
            }

            // Duplicate DEPOSIT_FULL: load existing and ensure VALID.
            const authorizationId = error.details?.authorizationId ?? null;
            if (!authorizationId) {
                // If we cannot identify it, fail closed (do not mark VALID).
                return null;
            }

            const restored = this._deploymentAuthorizationCoordinator.restoreFromPersistence(authorizationId);
            if (!restored) {
                return null;
            }

            if (restored.status === "CREATED") {
                this._deploymentAuthorizationCoordinator.markValid(restored.authorizationId);
            }

            return restored;
        }

        // First creation: mark VALID to satisfy GCM gate.
        if (createdAuthorization?.authorizationId) {
            this._deploymentAuthorizationCoordinator.markValid(createdAuthorization.authorizationId);
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

