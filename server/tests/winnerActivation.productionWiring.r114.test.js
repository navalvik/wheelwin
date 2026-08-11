/**
 * R11.4 — Production WinnerActivation wiring: shared configurationEngine.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    WINNER_RESOLUTION_FAILURE_REASON,
    WinnerActivation
} from "../gameplay/WinnerActivation.js";
import { PHYSICS_SIMULATION_STATE } from "../engines/physics/PhysicsSimulationState.js";

const APP_JS_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "../app.js"
);

function createLogger() {

    return {
        info() {},
        warn() {},
        error() {},
        debug() {}
    };

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

function createStoppedPhysics() {

    return {
        getSimulation() {

            return {
                runtime: {
                    state: PHYSICS_SIMULATION_STATE.STOPPED,
                    angle: 1.0
                }
            };

        }
    };

}

function createSharedConfigurationEngine(initial = new Map()) {

    const configurations = initial;

    return {
        getConfiguration(gameId) {

            return configurations.get(gameId) ?? null;

        },
        removeConfiguration(gameId) {

            configurations.delete(gameId);

        },
        setConfiguration(gameId, configuration) {

            configurations.set(gameId, configuration);

        }
    };

}

async function run() {

    console.log("R11.4 winnerActivation.productionWiring");

    // --- A: production app.js passes shared configurationEngine ---

    {
        const appSource = readFileSync(APP_JS_PATH, "utf8");

        assert.match(
            appSource,
            /new WinnerActivation\(\{[\s\S]*?configurationEngine:\s*this\._engines\.configurationEngine,/,
            "app.js must wire configurationEngine into WinnerActivation"
        );

        console.log("  TEST A app.js production wiring: OK");
    }

    // --- B: production-shaped DI — missing configuration classified early ---

    {
        const gameId = "game-r114-missing-config";

        const configurationEngine = createSharedConfigurationEngine();

        const eventBus = new EventBus({
            logger: createLogger(),
            eventBusConfig: { logEvents: false, showDebugPanel: false }
        });

        eventBus.initialize();

        const failed = [];

        eventBus.subscribe(EVENT_TYPES.WINNER_RESOLUTION_FAILED, (envelope) => {

            failed.push(envelope.payload);

        });

        const winnerEngine = {
            getResult: () => null,
            resolveResult() {

                throw new Error("should_not_reach_resolve");

            }
        };

        const activation = new WinnerActivation({
            logger: createLogger(),
            eventBus,
            physicsEngine: createStoppedPhysics(),
            winnerEngine,
            gameStateEngine: {},
            configurationEngine,
            resolveAttempts: 3,
            resolveRetryDelayMs: 5,
            deferredRetryDelaysMs: [15]
        });

        activation.initialize();

        configurationEngine.setConfiguration(gameId, {
            metadata: { roomId: "room-r114-missing-config", gameId },
            players: [{ playerId: "p1" }]
        });

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PHYSICS_STOPPED,
            payload: { gameId }
        });

        await wait(25);

        configurationEngine.removeConfiguration(gameId);

        await wait(40);

        assert.equal(failed.length, 1, "TEST B: one terminal failure");

        assert.equal(
            failed[0].reason,
            WINNER_RESOLUTION_FAILURE_REASON.REQUIRED_INPUTS_UNAVAILABLE,
            "TEST B: missing configuration classified early"
        );

        activation.shutdown();

        eventBus.shutdown();

        console.log("  TEST B configuration validation: OK");
    }

    // --- C: roomId present when configuration survives to terminal failure ---

    {
        const gameId = "game-r114-room-id";

        const roomId = "room-r114-room-id";

        const configurationEngine = createSharedConfigurationEngine();

        configurationEngine.setConfiguration(gameId, {
            metadata: { roomId, gameId },
            players: [{ playerId: "p1" }]
        });

        const eventBus = new EventBus({
            logger: createLogger(),
            eventBusConfig: { logEvents: false, showDebugPanel: false }
        });

        eventBus.initialize();

        const failed = [];

        eventBus.subscribe(EVENT_TYPES.WINNER_RESOLUTION_FAILED, (envelope) => {

            failed.push(envelope.payload);

        });

        const winnerEngine = {
            getResult: () => null,
            resolveResult() {

                throw new Error("permanent");

            }
        };

        const activation = new WinnerActivation({
            logger: createLogger(),
            eventBus,
            physicsEngine: createStoppedPhysics(),
            winnerEngine,
            gameStateEngine: {},
            configurationEngine,
            resolveAttempts: 2,
            resolveRetryDelayMs: 5,
            deferredRetryDelaysMs: [10]
        });

        activation.initialize();

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PHYSICS_STOPPED,
            payload: { gameId }
        });

        await wait(80);

        assert.equal(failed.length, 1, "TEST C: one terminal failure");

        assert.equal(
            failed[0].reason,
            WINNER_RESOLUTION_FAILURE_REASON.RETRY_BUDGET_EXHAUSTED
        );

        assert.equal(failed[0].roomId, roomId, "TEST C: roomId from configuration metadata");

        activation.shutdown();

        eventBus.shutdown();

        console.log("  TEST C roomId in terminal payload: OK");
    }

    // --- D: normal success path unchanged ---

    {
        const gameId = "game-r114-success";

        const configurationEngine = createSharedConfigurationEngine();

        configurationEngine.setConfiguration(gameId, {
            metadata: { roomId: "room-success", gameId },
            players: [{ playerId: "p1" }]
        });

        const eventBus = new EventBus({
            logger: createLogger(),
            eventBusConfig: { logEvents: false, showDebugPanel: false }
        });

        eventBus.initialize();

        const determined = [];

        eventBus.subscribe(EVENT_TYPES.WINNER_DETERMINED, (envelope) => {

            determined.push(envelope.payload);

        });

        const winnerResult = {
            gameId,
            winningSector: { index: 0, sectorId: "s0", color: "#f00", icon: "a" },
            winningPlayer: { playerId: "p1", color: "#f00", icon: "a" },
            winnerPlayerId: "p1",
            winnerSectorIndex: 0,
            finalAngle: 1.2,
            wheelFinalAngle: 1.2,
            triangleFinalAngle: 0.1,
            resolvedAt: Date.now()
        };

        const winnerEngine = {
            getResult: () => null,
            resolveResult() {

                return winnerResult;

            }
        };

        const activation = new WinnerActivation({
            logger: createLogger(),
            eventBus,
            physicsEngine: createStoppedPhysics(),
            winnerEngine,
            gameStateEngine: {},
            configurationEngine
        });

        activation.initialize();

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PHYSICS_STOPPED,
            payload: { gameId }
        });

        await wait(20);

        assert.equal(determined.length, 1, "TEST D: WINNER_DETERMINED once");

        assert.equal(determined[0].gameId, gameId);

        activation.shutdown();

        eventBus.shutdown();

        console.log("  TEST D success path: OK");
    }

    console.log("R11.4 winnerActivation.productionWiring: ALL PASSED");

}

run().catch((error) => {

    console.error(error);

    process.exitCode = 1;

});
