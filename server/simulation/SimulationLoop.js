import { EVENT_TYPES } from "../events/EventTypes.js";
import { DEFAULT_PHYSICS_PARAMETERS } from "../engines/physics/PhysicsParameters.js";
import { PHYSICS_SIMULATION_STATE } from "../engines/physics/PhysicsSimulationState.js";

export class SimulationLoop {

    constructor({
        logger,
        eventBus,
        physicsEngine,
        inputAuthority = null,
        fixedStepMs = DEFAULT_PHYSICS_PARAMETERS.fixedSimulationStepMs,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._physicsEngine = physicsEngine;

        this._inputAuthority = inputAuthority;

        this._fixedStepMs = fixedStepMs;

        this._devMode = devMode;

        this._activeGameIds = new Set();

        this._intervalHandle = null;

        this._handlers = [];

        this._initialized = false;

        this._running = false;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.PHYSICS_STARTED,
            (envelope) => {

                const gameId = envelope.payload?.gameId;

                if (gameId) {

                    this._activeGameIds.add(gameId);

                }

            }
        );

        this._subscribe(
            EVENT_TYPES.PHYSICS_STOPPED,
            (envelope) => {

                const gameId = envelope.payload?.gameId;

                if (gameId) {

                    this._activeGameIds.delete(gameId);

                }

            }
        );

        this._subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            () => {

                this.stop();

            }
        );

        this._initialized = true;

    }

    start() {

        if (!this._initialized || this._running) {

            return;

        }

        this._running = true;

        this._logger.info("Simulation Loop Started");

        this._intervalHandle = setInterval(
            () => this._onTick(),
            this._fixedStepMs
        );

    }

    stop() {

        if (this._intervalHandle) {

            clearInterval(this._intervalHandle);

            this._intervalHandle = null;

        }

        this._running = false;

    }

    shutdown() {

        this.stop();

        for (const subscription of this._handlers) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._handlers = [];

        this._activeGameIds.clear();

        this._initialized = false;

    }

    isRunning() {

        return this._running;

    }

    getActiveGameCount() {

        return this._activeGameIds.size;

    }

    getFixedStepMs() {

        return this._fixedStepMs;

    }

    setInputAuthority(inputAuthority) {

        this._inputAuthority = inputAuthority;

    }

    _onTick() {

        if (this._activeGameIds.size === 0) {

            this._logDev("Simulation Loop Tick");

            return;

        }

        for (const gameId of [...this._activeGameIds]) {

            const simulation = this._physicsEngine.getSimulation(gameId);

            if (!simulation) {

                this._activeGameIds.delete(gameId);

                continue;

            }

            const state = simulation.runtime.state;

            if (state !== PHYSICS_SIMULATION_STATE.RUNNING
                && state !== PHYSICS_SIMULATION_STATE.BRAKING) {

                this._activeGameIds.delete(gameId);

                continue;

            }

            // C3.7 authoritative order:
            // process input queue → apply acceleration → update physics.
            if (this._inputAuthority) {

                this._logDev("Processing Queue");

                this._inputAuthority.processCommandQueue(gameId);

            }

            this._logDev(`Updating game ${gameId}`);

            this._physicsEngine.updateSimulation(gameId, this._fixedStepMs);

            this._logDev("Physics Updated");

        }

        this._logDev("Simulation Loop Tick");

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _logDev(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.info(`[SimulationLoop] ${message}`);

    }

}
