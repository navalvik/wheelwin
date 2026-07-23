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

        this._resultSessionLifecycle = null;

    }

    initialize() {

        this._initialized = true;

    }

    registerSetupSessionLifecycle(lifecycle) {

        this._setupSessionLifecycle = lifecycle ?? null;

    }

    getSetupSessionLifecycle() {

        return this._setupSessionLifecycle;

    }

    registerResultSessionLifecycle(lifecycle) {

        this._resultSessionLifecycle = lifecycle ?? null;

    }

    getResultSessionLifecycle() {

        return this._resultSessionLifecycle;

    }

    shutdown() {

        this._setupSessionLifecycle = null;

        this._resultSessionLifecycle = null;

        this._initialized = false;

    }

}
