import { randomUUID } from "node:crypto";

import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { CONNECTION_STATE } from "../models/ConnectionState.js";
import { Player } from "../models/Player.js";
import { PlayerIdentity } from "../models/PlayerIdentity.js";
import { PlayerRuntime } from "../models/PlayerRuntime.js";
import { PLAYER_STATE } from "../models/PlayerState.js";

const RUNTIME_FIELDS = Object.freeze([
    "connectionState",
    "playerState",
    "roomId",
    "gameId",
    "pressCount",
    "ping",
    "connectedAt",
    "lastSeen"
]);

export class PlayerManager {

    constructor({ logger, eventBus }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._identities = new Map();

        this._runtimes = new Map();

        this._infrastructureHandlers = [];

        this._initialized = false;

    }

    initialize() {

        const shutdownHandler = () => {

            this._handleServerShutdown();

        };

        this._eventBus.subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            shutdownHandler
        );

        this._infrastructureHandlers.push({
            event: EVENT_TYPES.SERVER_SHUTDOWN,
            handler: shutdownHandler
        });

        this._initialized = true;

    }

    shutdown() {

        for (const playerId of [...this._identities.keys()]) {

            this.removePlayer(playerId);

        }

        for (const subscription of this._infrastructureHandlers) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._infrastructureHandlers = [];

        this._initialized = false;

    }

    createPlayer(identityInput = {}) {

        const playerId = identityInput.playerId ?? this._generatePlayerId();

        if (this._identities.has(playerId)) {

            this._logger.error(
                `Player creation failed: playerId already exists (${playerId})`
            );

            return null;

        }

        const identity = new PlayerIdentity({
            playerId,
            nickname: identityInput.nickname ?? null,
            wallet: identityInput.wallet ?? null,
            icon: identityInput.icon ?? null,
            age: identityInput.age ?? null,
            color: identityInput.color ?? null,
            colorSector2: identityInput.colorSector2 ?? null,
            sectorCount: identityInput.sectorCount ?? null,
            sectorArrangement: identityInput.sectorArrangement ?? null,
            baseStake: identityInput.baseStake ?? null,
            createdAt: identityInput.createdAt ?? Date.now()
        });

        const runtime = new PlayerRuntime({
            lastSeen: Date.now()
        });

        this._identities.set(playerId, identity);

        this._runtimes.set(playerId, runtime);

        this._logger.info(`Player Created: ${playerId}`);

        this._emit(EVENT_TYPES.PLAYER_CREATED, {
            playerId,
            identity: identity.toSnapshot(),
            runtime: runtime.toSnapshot()
        });

        return Player.fromParts(identity, runtime);

    }

    removePlayer(playerId) {

        const identity = this._getIdentityOrLog(playerId, "remove");

        if (!identity) {

            return false;

        }

        const runtime = this._runtimes.get(playerId);

        this._identities.delete(playerId);

        this._runtimes.delete(playerId);

        this._logger.info(`Player Removed: ${playerId}`);

        this._emit(EVENT_TYPES.PLAYER_REMOVED, {
            playerId,
            identity: identity.toSnapshot(),
            runtime: runtime.toSnapshot()
        });

        return true;

    }

    getPlayer(playerId) {

        const identity = this._identities.get(playerId);

        const runtime = this._runtimes.get(playerId);

        if (!identity || !runtime) {

            return null;

        }

        return Player.fromParts(identity, runtime);

    }

    getIdentity(playerId) {

        const identity = this._identities.get(playerId);

        if (!identity) {

            return null;

        }

        return identity.toSnapshot();

    }

    /**
     * Replaces frozen identity fields (nickname, age, icon, color, sectors).
     * Used by Page2 profile submission. Returns the new identity snapshot or null.
     */
    updateIdentity(playerId, identityPatch = {}) {

        const previous = this._getIdentityOrLog(playerId, "update identity for");

        if (!previous) {

            return null;

        }

        const next = new PlayerIdentity({
            playerId: previous.playerId,
            nickname: identityPatch.nickname !== undefined
                ? identityPatch.nickname
                : previous.nickname,
            wallet: identityPatch.wallet !== undefined
                ? identityPatch.wallet
                : previous.wallet,
            icon: identityPatch.icon !== undefined
                ? identityPatch.icon
                : previous.icon,
            age: identityPatch.age !== undefined
                ? identityPatch.age
                : previous.age,
            color: identityPatch.color !== undefined
                ? identityPatch.color
                : previous.color,
            colorSector2: identityPatch.colorSector2 !== undefined
                ? identityPatch.colorSector2
                : previous.colorSector2,
            sectorCount: identityPatch.sectorCount !== undefined
                ? identityPatch.sectorCount
                : previous.sectorCount,
            sectorArrangement: identityPatch.sectorArrangement !== undefined
                ? identityPatch.sectorArrangement
                : previous.sectorArrangement,
            baseStake: identityPatch.baseStake !== undefined
                ? identityPatch.baseStake
                : previous.baseStake,
            createdAt: previous.createdAt
        });

        this._identities.set(playerId, next);

        this._logger.info(`Player Identity Updated: ${playerId}`);

        return next.toSnapshot();

    }

    getRuntime(playerId) {

        const runtime = this._runtimes.get(playerId);

        if (!runtime) {

            return null;

        }

        return runtime.toSnapshot();

    }

    updateRuntime(playerId, runtimePatch = {}) {

        const runtime = this._getRuntimeOrLog(playerId, "update runtime for");

        if (!runtime) {

            return null;

        }

        if (!this._applyRuntimePatch(runtime, runtimePatch)) {

            return null;

        }

        runtime.lastSeen = Date.now();

        this._emitRuntimeUpdated(playerId, runtime);

        return runtime.toSnapshot();

    }

    setConnectionState(playerId, connectionState) {

        if (!this._isValidConnectionState(connectionState)) {

            this._logger.error(
                `Set connection state failed: invalid state (${connectionState})`
            );

            return null;

        }

        const runtime = this._getRuntimeOrLog(playerId, "set connection state for");

        if (!runtime) {

            return null;

        }

        const previousState = runtime.connectionState;

        if (previousState === connectionState) {

            return runtime.toSnapshot();

        }

        runtime.connectionState = connectionState;

        runtime.lastSeen = Date.now();

        if (connectionState === CONNECTION_STATE.CONNECTED) {

            runtime.connectedAt = Date.now();

            this._logger.info(`Player Connected: ${playerId}`);

            this._emit(EVENT_TYPES.PLAYER_CONNECTED, {
                playerId,
                connectionState,
                runtime: runtime.toSnapshot()
            });

            return runtime.toSnapshot();

        }

        if (connectionState === CONNECTION_STATE.DISCONNECTED) {

            this._logger.info(`Player Disconnected: ${playerId}`);

            this._emit(EVENT_TYPES.PLAYER_DISCONNECTED, {
                playerId,
                connectionState,
                runtime: runtime.toSnapshot()
            });

            return runtime.toSnapshot();

        }

        this._emitRuntimeUpdated(playerId, runtime);

        return runtime.toSnapshot();

    }

    setPlayerState(playerId, playerState) {

        if (!this._isValidPlayerState(playerState)) {

            this._logger.error(
                `Set player state failed: invalid state (${playerState})`
            );

            return null;

        }

        const runtime = this._getRuntimeOrLog(playerId, "set player state for");

        if (!runtime) {

            return null;

        }

        if (runtime.playerState === playerState) {

            return runtime.toSnapshot();

        }

        runtime.playerState = playerState;

        runtime.lastSeen = Date.now();

        this._emitRuntimeUpdated(playerId, runtime);

        return runtime.toSnapshot();

    }

    hasPlayer(playerId) {

        return this._identities.has(playerId);

    }

    getDebugSnapshot() {

        const players = [];

        for (const [playerId, identity] of this._identities) {

            const runtime = this._runtimes.get(playerId);

            players.push({
                playerId,
                nickname: identity.nickname,
                connectionState: runtime.connectionState,
                playerState: runtime.playerState,
                roomId: runtime.roomId,
                gameId: runtime.gameId,
                ping: runtime.ping
            });

        }

        return { players };

    }

    _handleServerShutdown() {

        for (const playerId of [...this._identities.keys()]) {

            this.removePlayer(playerId);

        }

    }

    _getIdentityOrLog(playerId, operation) {

        if (!playerId) {

            this._logger.error(`Player ${operation} failed: playerId is required`);

            return null;

        }

        const identity = this._identities.get(playerId);

        if (!identity) {

            this._logger.error(
                `Player ${operation} failed: player not found (${playerId})`
            );

            return null;

        }

        return identity;

    }

    _getRuntimeOrLog(playerId, operation) {

        if (!playerId) {

            this._logger.error(`Player ${operation} failed: playerId is required`);

            return null;

        }

        const runtime = this._runtimes.get(playerId);

        if (!runtime) {

            this._logger.error(
                `Player ${operation} failed: player not found (${playerId})`
            );

            return null;

        }

        return runtime;

    }

    _applyRuntimePatch(runtime, runtimePatch) {

        for (const [field, value] of Object.entries(runtimePatch)) {

            if (!RUNTIME_FIELDS.includes(field)) {

                this._logger.error(
                    `Runtime update failed: unsupported field (${field})`
                );

                return false;

            }

            if (field === "connectionState" && !this._isValidConnectionState(value)) {

                this._logger.error(
                    `Runtime update failed: invalid connection state (${value})`
                );

                return false;

            }

            if (field === "playerState" && !this._isValidPlayerState(value)) {

                this._logger.error(
                    `Runtime update failed: invalid player state (${value})`
                );

                return false;

            }

            runtime[field] = value;

        }

        return true;

    }

    _isValidConnectionState(connectionState) {

        return Object.values(CONNECTION_STATE).includes(connectionState);

    }

    _isValidPlayerState(playerState) {

        return Object.values(PLAYER_STATE).includes(playerState);

    }

    _emitRuntimeUpdated(playerId, runtime) {

        this._emit(EVENT_TYPES.PLAYER_RUNTIME_UPDATED, {
            playerId,
            runtime: runtime.toSnapshot()
        });

    }

    _emit(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.PLAYER_MANAGER,
            type,
            payload
        });

    }

    _generatePlayerId() {

        return `player_${randomUUID()}`;

    }

}
