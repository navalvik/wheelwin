/**
 * R1.3C — Thin coordinator / registry for authoritative wall clocks.
 *
 * Does not own Setup / Gameplay / Completion business logic.
 */
export class TimerService {

    constructor({ logger }) {

        this._logger = logger;

        this._initialized = false;

        this._setupSessionLifecycle = null;

        this._gameplayTimerLifecycle = null;

    }

    initialize() {

        this._initialized = true;

    }

    registerSetupSessionLifecycle(lifecycle) {

        this._setupSessionLifecycle = lifecycle ?? null;

    }

    registerGameplayTimerLifecycle(lifecycle) {

        this._gameplayTimerLifecycle = lifecycle ?? null;

    }

    getSetupSessionLifecycle() {

        return this._setupSessionLifecycle;

    }

    getGameplayTimerLifecycle() {

        return this._gameplayTimerLifecycle;

    }

    shutdown() {

        this._setupSessionLifecycle = null;

        this._gameplayTimerLifecycle = null;

        this._initialized = false;

    }

}
