import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";

/**
 * P5.5 — Drives authoritative SELF_TEST motion via PhysicsEngine.
 *
 * Starts on SELF_TEST_STARTED (after READY_COMPLETED via GameClockEngine).
 * Freezes pose on SELF_TEST_COMPLETED. Does not own phase transitions.
 */
export class SelfTestPhaseController {

    constructor({
        logger,
        eventBus,
        configurationEngine,
        physicsEngine,
        gameClockEngine,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._configurationEngine = configurationEngine;

        this._physicsEngine = physicsEngine;

        this._gameClockEngine = gameClockEngine;

        this._devMode = devMode;

        this._handlers = [];

        this._activeGames = new Set();

        this._initialized = false;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.SELF_TEST_STARTED,
            (envelope) => {

                this._handleSelfTestStarted(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.SELF_TEST_COMPLETED,
            (envelope) => {

                this._handleSelfTestCompleted(envelope.payload);

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

    _handleSelfTestStarted({ gameId, phase, durationMs, startedAt, endsAt }) {

        if (!gameId || phase !== GAME_STATES.SELF_TEST) {

            return;

        }

        if (this._activeGames.has(gameId)) {

            return;

        }

        const configuration = this._configurationEngine.getConfiguration(gameId);

        if (!configuration) {

            this._logger.error(
                `SELF_TEST start failed: configuration missing (${gameId})`
            );

            return;

        }

        const resolvedDurationMs = this._resolveDurationMs({
            gameId,
            durationMs,
            startedAt,
            endsAt
        });

        const started = this._physicsEngine.beginSelfTest(gameId, {
            durationMs: resolvedDurationMs,
            wheelStartAngleDeg: configuration.wheel?.startAngle,
            triangleStartAngleDeg: configuration.triangle?.startAngle
        });

        if (!started) {

            this._logger.error(
                `SELF_TEST start failed: physics beginSelfTest rejected (${gameId})`
            );

            return;

        }

        this._activeGames.add(gameId);

        if (this._devMode) {

            this._logger.info(
                `[SelfTest] STARTED | gameId=${gameId}`
                + ` | durationMs=${resolvedDurationMs}`
                + ` | wheelStart=${configuration.wheel?.startAngle}`
                + ` | triangleStart=${configuration.triangle?.startAngle}`
            );

        }

    }

    _handleSelfTestCompleted({ gameId, phase }) {

        if (!gameId || phase !== GAME_STATES.SELF_TEST) {

            return;

        }

        this._physicsEngine.endSelfTest(gameId);

        this._activeGames.delete(gameId);

        if (this._devMode) {

            const snapshot = this._physicsEngine.getDebugSnapshot(gameId);

            this._logger.info(
                `[SelfTest] COMPLETED | gameId=${gameId}`
                + ` | wheelAngle=${snapshot?.angle ?? "—"}`
                + ` | triangleAngle=${snapshot?.triangleAngle ?? "—"}`
            );

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

        return 1500;

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

}
