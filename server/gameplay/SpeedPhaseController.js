import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";

/**
 * P5.6A — Drives authoritative SPEED motion via PhysicsEngine.
 *
 * Starts on SPEED_STARTED (after SELF_TEST_COMPLETED via GameClockEngine
 * + GameplayPhaseLifecycle). Hold-count changes update velocities immediately.
 * Does not own phase transitions or BRAKE.
 */
export class SpeedPhaseController {

    constructor({
        logger,
        eventBus,
        physicsEngine,
        inputAuthority,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._physicsEngine = physicsEngine;

        this._inputAuthority = inputAuthority;

        this._devMode = devMode;

        this._handlers = [];

        this._activeGames = new Set();

        this._initialized = false;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.SPEED_STARTED,
            (envelope) => {

                this._handleSpeedStarted(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.SPEED_COMPLETED,
            (envelope) => {

                this._handleSpeedCompleted(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.PLAYER_INPUT_ACCEPTED,
            (envelope) => {

                this._handleInputAccepted(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.CLEANUP_COMPLETED,
            (envelope) => {

                const gameId = envelope.payload?.gameId;

                if (gameId) {

                    this._activeGames.delete(gameId);

                }

            }
        );

        this._subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            () => {

                this._activeGames.clear();

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

        this._activeGames.clear();

        this._initialized = false;

    }

    _handleSpeedStarted({ gameId, phase }) {

        if (!gameId || phase !== GAME_STATES.SPEED) {

            return;

        }

        if (this._activeGames.has(gameId)) {

            return;

        }

        // Allow SPEED input for this game (reopen if a prior match left it closed).
        if (typeof this._inputAuthority.clearSpeedInputClosed === "function") {

            this._inputAuthority.clearSpeedInputClosed(gameId);

        }

        const heldButtonCount = this._countHeldButtons(gameId);

        const started = this._physicsEngine.beginSpeed(gameId, {
            heldButtonCount
        });

        if (!started) {

            this._logger.error(
                `SPEED start failed: physics beginSpeed rejected (${gameId})`
            );

            return;

        }

        this._activeGames.add(gameId);

        if (this._devMode) {

            this._logger.info(
                `[Speed] STARTED | gameId=${gameId}`
                + ` | heldButtons=${heldButtonCount}`
            );

        }

    }

    _handleSpeedCompleted({ gameId, phase }) {

        if (!gameId || phase !== GAME_STATES.SPEED) {

            return;

        }

        // P5.7 — preserve SPEED end velocities as BRAKE initial conditions.
        this._physicsEngine.endSpeed(gameId, { keepMotion: true });

        if (typeof this._inputAuthority.closeSpeedInput === "function") {

            this._inputAuthority.closeSpeedInput(gameId);

        }

        this._activeGames.delete(gameId);

        if (this._devMode) {

            const snapshot = this._physicsEngine.getDebugSnapshot(gameId);

            this._logger.info(
                `[Speed] COMPLETED | gameId=${gameId}`
                + ` | wheelω=${snapshot?.angularVelocity ?? "—"}`
                + ` | triangleω=${snapshot?.triangleAngularVelocity ?? "—"}`
            );

        }

    }

    _handleInputAccepted({ gameId }) {

        if (!gameId || !this._activeGames.has(gameId)) {

            return;

        }

        const heldButtonCount = this._countHeldButtons(gameId);

        this._physicsEngine.setSpeedHoldCount(gameId, heldButtonCount);

        if (this._devMode) {

            this._logger.info(
                `[Speed] HOLD_UPDATE | gameId=${gameId}`
                + ` | heldButtons=${heldButtonCount}`
            );

        }

    }

    _countHeldButtons(gameId) {

        if (typeof this._inputAuthority?.countHeldButtons === "function") {

            return this._inputAuthority.countHeldButtons(gameId);

        }

        return 0;

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

}
