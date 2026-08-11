/**
 * R11.2 — Winner failure recovery: deferred retries + WINNER_RESOLUTION_FAILED.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    WINNER_RESOLUTION_FAILURE_REASON,
    WinnerActivation
} from "../gameplay/WinnerActivation.js";
import { ResultActivation } from "../gameplay/ResultActivation.js";
import {
    GAME_CONTRACT_STATUS,
    GameContract
} from "../models/GameContract.js";
import { ContractSettlementManager } from "../payment/ContractSettlementManager.js";
import { PHYSICS_SIMULATION_STATE } from "../engines/physics/PhysicsSimulationState.js";

const OWNER = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const WINNER_WALLET = "EQAREREREREREREREREREREREREREREREREREREREREREeYT";

function createLogger() {

    return {
        info() {},
        warn() {},
        error() {},
        debug() {},
        decisionTrace() {}
    };

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

function buildWinnerResult(gameId) {

    return {
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

}

function createStoppedPhysics(overrides = {}) {

    return {
        getSimulation(gameId) {

            if (overrides.getSimulation) {

                return overrides.getSimulation(gameId);

            }

            return {
                runtime: {
                    state: PHYSICS_SIMULATION_STATE.STOPPED,
                    angle: 1.0,
                    triangleAngle: 0.1
                }
            };

        }
    };

}

function createConfigEngine(roomId = "room-r112") {

    return {
        getConfiguration(gameId) {

            return {
                metadata: { roomId, gameId },
                players: [{ playerId: "p1" }]
            };

        }
    };

}

function buildContract(gameId = "game-r112-f", roomId = "room-r112-f") {

    const snapshot = Object.freeze({
        gameId,
        roomId,
        ownerWallet: OWNER,
        totalPot: 100,
        payoutAmount: 95,
        organizerFee: 5,
        players: Object.freeze([
            Object.freeze({
                playerId: "p1",
                wallet: WINNER_WALLET,
                requiredGram: 30
            })
        ])
    });

    return new GameContract({
        contractId: `contract_${gameId}`,
        gameId,
        roomId,
        status: GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE,
        snapshot,
        contractAddress: "EQescrowaddressfortestsXXXXXXXXXXXXXX",
        paymentsCompletedAt: Date.now()
    });

}

async function run() {

    console.log("R11.2 winnerFailureRecovery");

    // --- TEST A: fast retry success ---

    {
        let attempts = 0;

        const eventBus = new EventBus({
            logger: createLogger(),
            eventBusConfig: { logEvents: false, showDebugPanel: false }
        });

        eventBus.initialize();

        const determined = [];

        const failed = [];

        eventBus.subscribe(EVENT_TYPES.WINNER_DETERMINED, (e) => determined.push(e.payload));

        eventBus.subscribe(EVENT_TYPES.WINNER_RESOLUTION_FAILED, (e) => failed.push(e.payload));

        const winnerEngine = {
            getResult: () => null,
            resolveResult(gameId) {

                attempts += 1;

                if (attempts === 1) {

                    throw new Error("transient");

                }

                return buildWinnerResult(gameId);

            }
        };

        const activation = new WinnerActivation({
            logger: createLogger(),
            eventBus,
            physicsEngine: createStoppedPhysics(),
            winnerEngine,
            gameStateEngine: {},
            configurationEngine: createConfigEngine(),
            resolveAttempts: 3,
            resolveRetryDelayMs: 5,
            deferredRetryDelaysMs: [100]
        });

        activation.initialize();

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PHYSICS_STOPPED,
            payload: { gameId: "game-a" }
        });

        await wait(50);

        assert.equal(determined.length, 1, "TEST A: WINNER_DETERMINED once");

        assert.equal(failed.length, 0, "TEST A: no terminal failure");

        activation.shutdown();

        eventBus.shutdown();

        console.log("  TEST A fast retry success: OK");

    }

    // --- TEST B: deferred retry success ---

    {
        let attempts = 0;

        const eventBus = new EventBus({
            logger: createLogger(),
            eventBusConfig: { logEvents: false, showDebugPanel: false }
        });

        eventBus.initialize();

        const determined = [];

        const failed = [];

        eventBus.subscribe(EVENT_TYPES.WINNER_DETERMINED, (e) => determined.push(e.payload));

        eventBus.subscribe(EVENT_TYPES.WINNER_RESOLUTION_FAILED, (e) => failed.push(e.payload));

        const winnerEngine = {
            getResult: () => null,
            resolveResult(gameId) {

                attempts += 1;

                if (attempts <= 3) {

                    throw new Error("still_failing");

                }

                return buildWinnerResult(gameId);

            }
        };

        const activation = new WinnerActivation({
            logger: createLogger(),
            eventBus,
            physicsEngine: createStoppedPhysics(),
            winnerEngine,
            gameStateEngine: {},
            configurationEngine: createConfigEngine(),
            resolveAttempts: 3,
            resolveRetryDelayMs: 5,
            deferredRetryDelaysMs: [15]
        });

        activation.initialize();

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PHYSICS_STOPPED,
            payload: { gameId: "game-b" }
        });

        await wait(120);

        assert.equal(determined.length, 1, "TEST B: WINNER_DETERMINED once");

        assert.equal(failed.length, 0, "TEST B: no terminal failure");

        assert.equal(attempts, 4, "TEST B: 3 fast + 1 deferred success");

        activation.shutdown();

        eventBus.shutdown();

        console.log("  TEST B deferred retry success: OK");

    }

    // --- TEST C: permanent failure ---

    {
        let attempts = 0;

        const eventBus = new EventBus({
            logger: createLogger(),
            eventBusConfig: { logEvents: false, showDebugPanel: false }
        });

        eventBus.initialize();

        const determined = [];

        const failed = [];

        eventBus.subscribe(EVENT_TYPES.WINNER_DETERMINED, (e) => determined.push(e.payload));

        eventBus.subscribe(EVENT_TYPES.WINNER_RESOLUTION_FAILED, (e) => failed.push(e.payload));

        const winnerEngine = {
            getResult: () => null,
            resolveResult() {

                attempts += 1;

                throw new Error("permanent");

            }
        };

        const activation = new WinnerActivation({
            logger: createLogger(),
            eventBus,
            physicsEngine: createStoppedPhysics(),
            winnerEngine,
            gameStateEngine: {},
            configurationEngine: createConfigEngine(),
            resolveAttempts: 3,
            resolveRetryDelayMs: 5,
            deferredRetryDelaysMs: [10, 20]
        });

        activation.initialize();

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PHYSICS_STOPPED,
            payload: { gameId: "game-c" }
        });

        await wait(150);

        assert.equal(determined.length, 0, "TEST C: no WINNER_DETERMINED");

        assert.equal(failed.length, 1, "TEST C: WINNER_RESOLUTION_FAILED once");

        assert.equal(
            failed[0].reason,
            WINNER_RESOLUTION_FAILURE_REASON.RETRY_BUDGET_EXHAUSTED
        );

        activation.shutdown();

        eventBus.shutdown();

        console.log("  TEST C permanent failure: OK");

    }

    // --- TEST D: duplicate PHYSICS_STOPPED ---

    {
        let attempts = 0;

        const eventBus = new EventBus({
            logger: createLogger(),
            eventBusConfig: { logEvents: false, showDebugPanel: false }
        });

        eventBus.initialize();

        const determined = [];

        const failed = [];

        eventBus.subscribe(EVENT_TYPES.WINNER_DETERMINED, (e) => determined.push(e.payload));

        eventBus.subscribe(EVENT_TYPES.WINNER_RESOLUTION_FAILED, (e) => failed.push(e.payload));

        const winnerEngine = {
            getResult: () => null,
            resolveResult(gameId) {

                attempts += 1;

                return buildWinnerResult(gameId);

            }
        };

        const activation = new WinnerActivation({
            logger: createLogger(),
            eventBus,
            physicsEngine: createStoppedPhysics(),
            winnerEngine,
            gameStateEngine: {},
            resolveAttempts: 3,
            resolveRetryDelayMs: 5,
            deferredRetryDelaysMs: []
        });

        activation.initialize();

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PHYSICS_STOPPED,
            payload: { gameId: "game-d" }
        });

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PHYSICS_STOPPED,
            payload: { gameId: "game-d" }
        });

        await wait(20);

        assert.equal(attempts, 1, "TEST D: single resolve chain");

        assert.equal(determined.length, 1, "TEST D: one WINNER_DETERMINED");

        assert.equal(failed.length, 0, "TEST D: no failure");

        activation.shutdown();

        eventBus.shutdown();

        console.log("  TEST D duplicate PHYSICS_STOPPED: OK");

    }

    // --- TEST E: inputs disappear ---

    {
        let attempts = 0;

        let physicsAvailable = true;

        const eventBus = new EventBus({
            logger: createLogger(),
            eventBusConfig: { logEvents: false, showDebugPanel: false }
        });

        eventBus.initialize();

        const failed = [];

        eventBus.subscribe(EVENT_TYPES.WINNER_RESOLUTION_FAILED, (e) => failed.push(e.payload));

        const winnerEngine = {
            getResult: () => null,
            resolveResult() {

                attempts += 1;

                throw new Error("should_not_reach_deferred_resolve");

            }
        };

        const activation = new WinnerActivation({
            logger: createLogger(),
            eventBus,
            physicsEngine: createStoppedPhysics({
                getSimulation() {

                    if (!physicsAvailable) {

                        return null;

                    }

                    return {
                        runtime: {
                            state: PHYSICS_SIMULATION_STATE.STOPPED,
                            angle: 1.0
                        }
                    };

                }
            }),
            winnerEngine,
            gameStateEngine: {},
            configurationEngine: createConfigEngine(),
            resolveAttempts: 3,
            resolveRetryDelayMs: 5,
            deferredRetryDelaysMs: [15]
        });

        activation.initialize();

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PHYSICS_STOPPED,
            payload: { gameId: "game-e" }
        });

        await wait(25);

        physicsAvailable = false;

        await wait(40);

        assert.equal(attempts, 3, "TEST E: only fast attempts before inputs gone");

        assert.equal(failed.length, 1, "TEST E: terminal failure");

        assert.equal(
            failed[0].reason,
            WINNER_RESOLUTION_FAILURE_REASON.REQUIRED_INPUTS_UNAVAILABLE
        );

        activation.shutdown();

        eventBus.shutdown();

        console.log("  TEST E inputs disappear: OK");

    }

    // --- TEST F: entry-paid failure preserves financial evidence ---

    {
        const gameId = "game-r112-f";

        const contract = buildContract(gameId);

        const paymentSessions = new Map([[contract.roomId, { roomId: contract.roomId, gameId }]]);

        const eventBus = new EventBus({
            logger: createLogger(),
            eventBusConfig: { logEvents: false, showDebugPanel: false }
        });

        eventBus.initialize();

        let gameDestroyed = false;

        eventBus.subscribe(EVENT_TYPES.GAME_DESTROYED, () => {

            gameDestroyed = true;

        });

        const settlementManager = new ContractSettlementManager({
            logger: createLogger(),
            eventBus,
            gameContractManager: {
                getContract: () => contract,
                getContractByGameId: () => contract,
                getContractById: () => contract
            },
            winnerEngine: { getResult: () => null },
            configurationEngine: { getConfiguration: () => ({ traceSeed: "x" }) },
            settlementAdapter: {
                async settleContract() {

                    throw new Error("must_not_settle");

                }
            },
            gameplayContextResolver: {
                resolveRoomByGameId: () => contract.roomId
            },
            gameManager: {
                wasEntryPaymentActivated: () => true,
                hasInitializedGameplay: () => true
            },
            paymentSessionManager: {
                getSession: (roomId) => paymentSessions.get(roomId) ?? null,
                destroySession(roomId) {

                    paymentSessions.delete(roomId);

                }
            }
        });

        settlementManager.initialize();

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
            configurationEngine: createConfigEngine(contract.roomId),
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

        assert.equal(
            settlementManager.getSettlementSession(gameId),
            null,
            "TEST F: no settlement started"
        );

        assert.ok(paymentSessions.has(contract.roomId), "TEST F: PaymentSession survives");

        assert.equal(contract.status, GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE);

        assert.equal(gameDestroyed, false, "TEST F: no GAME_DESTROYED");

        settlementManager.shutdown();

        activation.shutdown();

        eventBus.shutdown();

        console.log("  TEST F entry-paid failure: OK");

    }

    // --- TEST G: success reaches ResultActivation (RESULT path) ---

    {
        let attempts = 0;

        const eventBus = new EventBus({
            logger: createLogger(),
            eventBusConfig: { logEvents: false, showDebugPanel: false }
        });

        eventBus.initialize();

        const resultPhases = [];

        const winnerEngine = {
            getResult(gameId) {

                return attempts >= 4 ? buildWinnerResult(gameId) : null;

            },
            resolveResult(gameId) {

                attempts += 1;

                if (attempts <= 3) {

                    throw new Error("defer_success");

                }

                const result = buildWinnerResult(gameId);

                winnerEngine.getResult = () => result;

                return result;

            }
        };

        const gameClockEngine = {
            beginResultPhase(gameId) {

                resultPhases.push(gameId);

                return { phaseRemainingMs: 4000 };

            }
        };

        const resultActivation = new ResultActivation({
            logger: createLogger(),
            eventBus,
            gameClockEngine,
            winnerEngine,
            devMode: false
        });

        resultActivation.initialize();

        const activation = new WinnerActivation({
            logger: createLogger(),
            eventBus,
            physicsEngine: createStoppedPhysics(),
            winnerEngine,
            gameStateEngine: {},
            configurationEngine: createConfigEngine(),
            resolveAttempts: 3,
            resolveRetryDelayMs: 5,
            deferredRetryDelaysMs: [15]
        });

        activation.initialize();

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PHYSICS_STOPPED,
            payload: { gameId: "game-g" }
        });

        await wait(120);

        assert.equal(resultPhases.length, 1, "TEST G: RESULT phase started");

        assert.equal(resultPhases[0], "game-g");

        resultActivation.shutdown();

        activation.shutdown();

        eventBus.shutdown();

        console.log("  TEST G ResultActivation chain: OK");

    }

    // --- TEST H: timer cleanup ---

    {
        const eventBus = new EventBus({
            logger: createLogger(),
            eventBusConfig: { logEvents: false, showDebugPanel: false }
        });

        eventBus.initialize();

        const winnerEngine = {
            getResult: () => null,
            resolveResult(gameId) {

                return buildWinnerResult(gameId);

            }
        };

        const activation = new WinnerActivation({
            logger: createLogger(),
            eventBus,
            physicsEngine: createStoppedPhysics(),
            winnerEngine,
            gameStateEngine: {},
            resolveAttempts: 3,
            resolveRetryDelayMs: 5,
            deferredRetryDelaysMs: [100]
        });

        activation.initialize();

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PHYSICS_STOPPED,
            payload: { gameId: "game-h-success" }
        });

        await wait(20);

        assert.equal(activation._retryTimers.size, 0, "TEST H: timers cleared on success");

        assert.equal(activation._retryState.size, 0, "TEST H: retry state cleared on success");

        const failEngine = {
            getResult: () => null,
            resolveResult() {

                throw new Error("fail");

            }
        };

        const failActivation = new WinnerActivation({
            logger: createLogger(),
            eventBus,
            physicsEngine: createStoppedPhysics(),
            winnerEngine: failEngine,
            gameStateEngine: {},
            resolveAttempts: 2,
            resolveRetryDelayMs: 5,
            deferredRetryDelaysMs: [10]
        });

        failActivation.initialize();

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PHYSICS_STOPPED,
            payload: { gameId: "game-h-fail" }
        });

        await wait(80);

        assert.equal(failActivation._retryTimers.size, 0, "TEST H: timers cleared on failure");

        assert.equal(failActivation._retryState.size, 0, "TEST H: retry state cleared on failure");

        activation.shutdown();

        failActivation.shutdown();

        eventBus.shutdown();

        console.log("  TEST H timer cleanup: OK");

    }

    console.log("R11.2 winnerFailureRecovery: ALL PASSED");

}

run().catch((error) => {

    console.error(error);

    process.exitCode = 1;

});
