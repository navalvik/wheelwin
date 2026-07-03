import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { CONNECTION_STATE } from "../models/ConnectionState.js";

/**
 * C4.8b — Authoritative Offline Input Continuation.
 *
 * Restores the original WheelWin philosophy: after Page5 starts, a player may
 * vanish from the network, but their gameplay does not. The game never pauses,
 * never waits, and never loses a player's contribution. The server continues the
 * offline player's remaining SPEED interaction on their behalf.
 *
 * ── Why this component, and why this integration point ────────────────────────
 *
 * InputAuthority is the single authoritative owner of player interaction: it
 * owns each player's input state (pressCount / buttonPressed / cooldown / lock)
 * and is the ONLY producer of physics acceleration commands
 * (ACCELERATION_START / ACCELERATION_STOP). The SocketGateway already drives it
 * by calling inputAuthority.handleButtonPress/Release directly — the socket is
 * merely a transport, not the authority.
 *
 * Therefore the correct owner of a disconnected player's *remaining* interaction
 * is still InputAuthority. This module does not become a second authority and it
 * does not touch physics: it simply continues driving InputAuthority's existing
 * public input path for offline players, exactly as the SocketGateway would for
 * an online player. This is the layer "above PhysicsEngine and below player
 * input": InputAuthority still validates every command, physics still receives
 * the identical command types via the identical SimulationLoop queue, and
 * physics remains completely unaware of whether a player is online.
 *
 * ── Deterministic clock ───────────────────────────────────────────────────────
 *
 * The continuation is driven by the already-existing PHYSICS_UPDATED tick
 * (emitted once per fixed SimulationLoop step). We create no parallel loop and
 * no new timer: the same deterministic infrastructure that advances physics also
 * advances the continuation. Cadence honours the authoritative input cooldown so
 * every synthesised cycle passes InputAuthority validation legitimately — there
 * are no fake socket events and no fake packets, only authoritative method calls.
 *
 * ── Effect on SPEED lifetime ─────────────────────────────────────────────────
 *
 * Because offline players are continued to their full press-limit, they emit the
 * real PLAYER_PRESS_LIMIT_REACHED just like online players. SpeedActivation can
 * therefore use the plain full-roster completion rule: offline players neither
 * hang SPEED (they are continued) nor end it early / lose acceleration (their
 * input is completed rather than skipped). Disconnecting no longer changes the
 * physical evolution of the game.
 */
export class OfflineInputContinuation {

    constructor({
        logger,
        eventBus,
        inputAuthority,
        gameStateEngine,
        playerManager,
        gameCatalog,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._inputAuthority = inputAuthority;

        this._gameStateEngine = gameStateEngine;

        this._playerManager = playerManager;

        this._gameCatalog = gameCatalog;

        this._devMode = devMode;

        this._handlers = [];

        // gameId -> Set<playerId> : full authoritative roster (from GAME_CREATED).
        this._rosters = new Map();

        // gameId -> Map<playerId, cursor> : players currently being continued.
        // cursor = { holding, nextPressAt, releaseAt }
        this._active = new Map();

        this._initialized = false;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.GAME_CREATED,
            (envelope) => {

                this._handleGameCreated(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.GAME_STATE_CHANGED,
            (envelope) => {

                this._handleGameStateChanged(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.PLAYER_DISCONNECTED,
            (envelope) => {

                this._handlePlayerDisconnected(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.PLAYER_CONNECTED,
            (envelope) => {

                this._handlePlayerConnected(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.PHYSICS_UPDATED,
            (envelope) => {

                this._handlePhysicsUpdated(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            () => {

                this._reset();

            }
        );

        this._initialized = true;

    }

    shutdown() {

        for (const subscription of this._handlers) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._handlers = [];

        this._reset();

        this._initialized = false;

    }

    forgetGame(gameId) {

        this._rosters.delete(gameId);

        this._active.delete(gameId);

    }

    /**
     * Diagnostics: which (gameId, playerId) pairs are being continued right now.
     */
    getActiveContinuations() {

        const result = [];

        for (const [gameId, cursors] of this._active) {

            for (const playerId of cursors.keys()) {

                result.push({ gameId, playerId });

            }

        }

        return result;

    }

    _handleGameCreated(payload) {

        const gameId = payload?.gameId;

        if (!gameId || !Array.isArray(payload.players)) {

            return;

        }

        const roster = new Set();

        for (const entry of payload.players) {

            const playerId = this._resolvePlayerId(entry);

            if (playerId) {

                roster.add(playerId);

            }

        }

        this._rosters.set(gameId, roster);

        this._active.delete(gameId);

    }

    _handleGameStateChanged(payload) {

        const gameId = payload?.gameId;

        const currentState = payload?.currentState ?? payload?.state;

        if (!gameId) {

            return;

        }

        if (currentState !== GAME_STATES.SPEED) {

            // SPEED is over. Gameplay input is closed, so any continuation for
            // this game must stop immediately and authoritatively — do not wait
            // for the next physics tick, which may never arrive once the wheel
            // has stopped. This keeps active-continuation state truthful.
            this._active.delete(gameId);

            return;

        }

        // On SPEED entry, adopt any player that is already offline (for example a
        // player who dropped during COUNTDOWN). Their PLAYER_DISCONNECTED fired
        // before SPEED existed, so start their continuation now.
        const roster = this._rosters.get(gameId);

        if (!roster) {

            return;

        }

        for (const playerId of roster) {

            if (!this._isPlayerOnline(playerId)) {

                this._startContinuation(gameId, playerId);

            }

        }

    }

    _handlePlayerDisconnected(payload) {

        const playerId = payload?.playerId;

        if (!playerId) {

            return;

        }

        const gameId = this._resolveGameIdForPlayer(playerId);

        if (!gameId) {

            return;

        }

        if (this._gameStateEngine.getState(gameId) !== GAME_STATES.SPEED) {

            return;

        }

        this._startContinuation(gameId, playerId);

    }

    _handlePlayerConnected(payload) {

        const playerId = payload?.playerId;

        if (!playerId) {

            return;

        }

        const gameId = this._resolveGameIdForPlayer(playerId);

        if (!gameId) {

            return;

        }

        // The player is back and will drive their own remaining input. Hand the
        // interaction back cleanly: if the continuation is mid-hold, release so
        // the authoritative button state is consistent for the returning client.
        this._stopContinuation(gameId, playerId, true);

    }

    _handlePhysicsUpdated(payload) {

        const gameId = payload?.gameId;

        if (!gameId) {

            return;

        }

        const cursors = this._active.get(gameId);

        if (!cursors || cursors.size === 0) {

            return;

        }

        // Continuation only exists while SPEED is authoritative. Any other state
        // means gameplay input is closed; drop everything for this game.
        if (this._gameStateEngine.getState(gameId) !== GAME_STATES.SPEED) {

            this._active.delete(gameId);

            return;

        }

        const now = Date.now();

        for (const [playerId, cursor] of [...cursors]) {

            this._advancePlayer(gameId, playerId, cursor, now);

        }

    }

    _startContinuation(gameId, playerId) {

        const cursors = this._ensureCursors(gameId);

        if (cursors.has(playerId)) {

            return;

        }

        const state = this._inputAuthority.getPlayerInputState(gameId, playerId);

        // Only continue a player that is genuinely still an active participant
        // with input remaining. If they are unknown or already at the limit,
        // there is nothing to continue.
        if (!state || state.locked) {

            return;

        }

        cursors.set(playerId, {
            holding: state.buttonPressed === true,
            nextPressAt: earliestNextAction(state),
            releaseAt: 0
        });

        this._logStep(
            `Continuation started | gameId=${gameId} | playerId=${playerId} `
            + `| pressCount=${state.pressCount}`
        );

    }

    _advancePlayer(gameId, playerId, cursor, currentTime) {

        const state = this._inputAuthority.getPlayerInputState(gameId, playerId);

        if (!state || state.locked) {

            // Reached the authoritative press limit (or vanished): continuation
            // is complete. The final release already emitted
            // PLAYER_PRESS_LIMIT_REACHED, so SpeedActivation is informed.
            this._removeCursor(gameId, playerId);

            return;

        }

        if (cursor.holding) {

            if (currentTime < cursor.releaseAt) {

                return;

            }

            const released = this._inputAuthority.handleButtonRelease(
                gameId,
                playerId
            );

            if (released) {

                cursor.holding = false;

                cursor.nextPressAt = currentTime + this._cooldownMs();

            }

            return;

        }

        if (currentTime < cursor.nextPressAt) {

            return;

        }

        const pressed = this._inputAuthority.handleButtonPress(gameId, playerId);

        if (pressed) {

            cursor.holding = true;

            cursor.releaseAt = currentTime + this._holdMs();

        }

    }

    _stopContinuation(gameId, playerId, releaseIfHolding) {

        const cursors = this._active.get(gameId);

        if (!cursors) {

            return;

        }

        const cursor = cursors.get(playerId);

        if (!cursor) {

            return;

        }

        if (releaseIfHolding && cursor.holding) {

            this._inputAuthority.handleButtonRelease(gameId, playerId);

        }

        this._removeCursor(gameId, playerId);

        this._logStep(
            `Continuation stopped | gameId=${gameId} | playerId=${playerId}`
        );

    }

    _removeCursor(gameId, playerId) {

        const cursors = this._active.get(gameId);

        if (!cursors) {

            return;

        }

        cursors.delete(playerId);

        if (cursors.size === 0) {

            this._active.delete(gameId);

        }

    }

    _ensureCursors(gameId) {

        let cursors = this._active.get(gameId);

        if (!cursors) {

            cursors = new Map();

            this._active.set(gameId, cursors);

        }

        return cursors;

    }

    _isPlayerOnline(playerId) {

        const runtime = this._playerManager?.getRuntime(playerId);

        if (!runtime) {

            return false;

        }

        return runtime.connectionState === CONNECTION_STATE.CONNECTED;

    }

    _resolveGameIdForPlayer(playerId) {

        const runtime = this._playerManager?.getRuntime(playerId);

        if (runtime?.gameId && this._rosters.has(runtime.gameId)) {

            return runtime.gameId;

        }

        for (const [gameId, roster] of this._rosters) {

            if (roster.has(playerId)) {

                return gameId;

            }

        }

        return null;

    }

    _cooldownMs() {

        return this._gameCatalog.getInputRules().pressCooldownMs;

    }

    _holdMs() {

        // Hold each synthesised press for one cooldown interval so the offline
        // player imparts real, sustained acceleration across simulation ticks
        // (mirroring an online hold-then-release cadence). With a zero cooldown
        // catalog the press still spans at least one tick before release.
        return this._gameCatalog.getInputRules().pressCooldownMs;

    }

    _resolvePlayerId(entry) {

        if (typeof entry === "string") {

            return entry;

        }

        return entry?.playerId ?? entry?.id ?? null;

    }

    _reset() {

        this._rosters.clear();

        this._active.clear();

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _logStep(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.info(`[OfflineInputContinuation] ${message}`);

    }

}

function earliestNextAction(state) {

    // A player mid-hold at continuation start should release promptly; a player
    // between cycles must still respect their active cooldown before the next
    // press. Use the authoritative cooldownUntil as the earliest next action.
    return state.cooldownUntil ?? 0;

}
