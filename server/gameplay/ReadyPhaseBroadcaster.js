import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";

/**
 * P5.4 — Broadcasts immutable READY wheel layout once per match.
 *
 * wheelAngle and triangleAngle are authoritative from frozen configuration.
 * Clients never randomize locally.
 */
export class ReadyPhaseBroadcaster {

    constructor({
        logger,
        eventBus,
        configurationEngine,
        physicsEngine = null,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._configurationEngine = configurationEngine;

        this._physicsEngine = physicsEngine;

        this._devMode = devMode;

        this._handlers = [];

        this._broadcastByGame = new Set();

        this._initialized = false;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.READY_STARTED,
            (envelope) => {

                this._handleReadyStarted(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.CLEANUP_COMPLETED,
            (envelope) => {

                const gameId = envelope.payload?.gameId;

                if (gameId) {

                    this._broadcastByGame.delete(gameId);

                }

            }
        );

        this._subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            () => {

                this._broadcastByGame.clear();

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

        this._broadcastByGame.clear();

        this._initialized = false;

    }

    _handleReadyStarted({ gameId, phase }) {

        if (!gameId || phase !== GAME_STATES.READY) {

            return;

        }

        if (this._broadcastByGame.has(gameId)) {

            return;

        }

        const configuration = this._configurationEngine.getConfiguration(gameId);

        if (!configuration) {

            this._logger.error(
                `READY wheel broadcast failed: configuration missing (${gameId})`
            );

            return;

        }

        this._broadcastByGame.add(gameId);

        const payload = {
            gameId,
            sectors: configuration.sectors ?? [],
            wheelAngle: configuration.wheel?.startAngle ?? null,
            triangleAngle: configuration.triangle?.startAngle ?? null
        };

        // P5.11 — Physics remains CREATED during PRE_GAME_READY.
        // Start the simulation only when authoritative READY begins.
        if (this._physicsEngine) {

            this._physicsEngine.startSimulation(gameId);

            if (Number.isFinite(payload.wheelAngle)
                && Number.isFinite(payload.triangleAngle)) {

                this._physicsEngine.setPoseDegrees(
                    gameId,
                    payload.wheelAngle,
                    payload.triangleAngle
                );

            }

        }

        this._eventBus.emit({
            source: EVENT_SOURCES.READY_PHASE_BROADCASTER,
            type: EVENT_TYPES.WHEEL_CONFIGURATION,
            payload
        });

        if (this._devMode) {

            this._logger.info(
                `[ReadyPhase] WHEEL_CONFIGURATION | gameId=${gameId}`
                + ` | wheelAngle=${payload.wheelAngle}`
                + ` | triangleAngle=${payload.triangleAngle}`
            );

        }

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

}
