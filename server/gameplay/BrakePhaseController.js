import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";

/**
 * P5.7 — Drives authoritative BRAKE motion via PhysicsEngine.
 *
 * Starts on BRAKE_STARTED after SPEED_COMPLETED (lifecycle-owned transition).
 * Does not own phase transitions and does not resolve winners.
 */
export class BrakePhaseController {

    constructor({
        logger,
        eventBus,
        physicsEngine,
        gameClockEngine = null,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._physicsEngine = physicsEngine;

        this._gameClockEngine = gameClockEngine;

        this._devMode = devMode;

        this._handlers = [];

        this._activeGames = new Set();

        this._initialized = false;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.BRAKE_STARTED,
            (envelope) => {

                this._handleBrakeStarted(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.BRAKE_COMPLETED,
            (envelope) => {

                this._handleBrakeCompleted(envelope.payload);

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

    _handleBrakeStarted({ gameId, phase, durationMs, startedAt, endsAt }) {

        if (!gameId || phase !== GAME_STATES.BRAKE) {

            return;

        }

        if (this._activeGames.has(gameId)) {

            return;

        }

        const resolvedDurationMs = this._resolveDurationMs({
            gameId,
            durationMs,
            startedAt,
            endsAt
        });

        const started = this._physicsEngine.beginBrake(gameId, {
            durationMs: resolvedDurationMs
        });

        if (!started) {

            this._logger.error(
                `BRAKE start failed: physics beginBrake rejected (${gameId})`
            );

            return;

        }

        this._activeGames.add(gameId);

        if (this._devMode) {

            const snapshot = this._physicsEngine.getDebugSnapshot(gameId);

            this._logger.info(
                `[Brake] STARTED | gameId=${gameId}`
                + ` | durationMs=${resolvedDurationMs}`
                + ` | wheelω0=${snapshot?.brakeStartWheelOmega ?? snapshot?.angularVelocity}`
            );

        }

    }

    _handleBrakeCompleted({ gameId, phase }) {

        if (!gameId || phase !== GAME_STATES.BRAKE) {

            return;

        }

        this._physicsEngine.completeBrake(gameId);

        this._activeGames.delete(gameId);

        if (this._devMode) {

            this._logger.info(`[Brake] COMPLETED | gameId=${gameId}`);

        }

    }

    _resolveDurationMs({ gameId, durationMs, startedAt, endsAt }) {

        if (Number.isFinite(durationMs) && durationMs > 0) {

            return durationMs;

        }

        if (Number.isFinite(startedAt) && Number.isFinite(endsAt) && endsAt > startedAt) {

            return endsAt - startedAt;

        }

        const schedule = this._gameClockEngine?.getPhaseSchedule?.(gameId);

        if (schedule
            && Number.isFinite(schedule.startedAt)
            && Number.isFinite(schedule.endsAt)
            && schedule.endsAt > schedule.startedAt) {

            return schedule.endsAt - schedule.startedAt;

        }

        return 6000;

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

}
