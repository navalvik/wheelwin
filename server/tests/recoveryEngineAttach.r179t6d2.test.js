import { createHash } from "node:crypto";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { ConfigurationEngine } from "../engines/ConfigurationEngine.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { GameClockEngine } from "../engines/GameClockEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { WinnerEngine } from "../engines/WinnerEngine.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { PHYSICS_SIMULATION_STATE } from "../engines/physics/PhysicsSimulationState.js";
import { InputAuthority } from "../input/InputAuthority.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { PlayerIdentity } from "../models/PlayerIdentity.js";
import { PlayerRuntime } from "../models/PlayerRuntime.js";
import { GameCatalog } from "../catalog/GameCatalog.js";
import { LoggerService } from "../services/LoggerService.js";
import { stableStringify } from "../persistence/tonFinancialRecordUtils.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

const logger = new LoggerService();

logger.initialize();

const eventBus = new EventBus({
    logger,
    eventBusConfig: { logEvents: false, showDebugPanel: false }
});

eventBus.initialize();

const gameCatalog = new GameCatalog({ logger });

gameCatalog.initialize();

// ---------------------------------------------------------------------------
// Event isolation counters
// ---------------------------------------------------------------------------

const eventCounts = new Map();

const LIFECYCLE_EVENTS = Object.freeze([
    EVENT_TYPES.CONFIGURATION_READY,
    EVENT_TYPES.CONFIGURATION_REMOVED,
    EVENT_TYPES.GAME_STATE_CHANGED,
    EVENT_TYPES.GAME_STATE_REJECTED,
    EVENT_TYPES.CLOCK_STARTED,
    EVENT_TYPES.CLOCK_PAUSED,
    EVENT_TYPES.CLOCK_RESUMED,
    EVENT_TYPES.CLOCK_STOPPED,
    EVENT_TYPES.PHASE_TIMEOUT,
    EVENT_TYPES.PRE_GAME_READY_STARTED,
    EVENT_TYPES.PRE_GAME_READY_COMPLETED,
    EVENT_TYPES.READY_STARTED,
    EVENT_TYPES.READY_COMPLETED,
    EVENT_TYPES.SELF_TEST_STARTED,
    EVENT_TYPES.SELF_TEST_COMPLETED,
    EVENT_TYPES.SPEED_STARTED,
    EVENT_TYPES.SPEED_COMPLETED,
    EVENT_TYPES.BRAKE_STARTED,
    EVENT_TYPES.BRAKE_COMPLETED,
    EVENT_TYPES.RESULT_STARTED,
    EVENT_TYPES.RESULT_COMPLETED,
    EVENT_TYPES.PHYSICS_STARTED,
    EVENT_TYPES.PHYSICS_UPDATED,
    EVENT_TYPES.PHYSICS_BRAKING,
    EVENT_TYPES.PHYSICS_STOPPED,
    EVENT_TYPES.PLAYER_INPUT_ACCEPTED,
    EVENT_TYPES.PLAYER_INPUT_REJECTED,
    EVENT_TYPES.WINNING_SECTOR_RESOLVED,
    EVENT_TYPES.GAME_RESULT_READY,
    EVENT_TYPES.GAME_RESULT_REMOVED
]);

for (const eventType of LIFECYCLE_EVENTS) {

    eventCounts.set(eventType, 0);

    eventBus.subscribe(eventType, () => {

        eventCounts.set(eventType, (eventCounts.get(eventType) ?? 0) + 1);

    });

}

function resetEventCounts() {

    for (const eventType of LIFECYCLE_EVENTS) {

        eventCounts.set(eventType, 0);

    }

}

function assertZeroLifecycleEvents(label) {

    for (const [eventType, count] of eventCounts) {

        assert(
            count === 0,
            `${label}: lifecycle event ${eventType} was emitted (count=${count})`
        );

    }

}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const GAME_ID = "game_d2_recovery_001";

const ROOM_ID = "room_d2_recovery_001";

const PLAYER_IDS = ["player_d2_a", "player_d2_b", "player_d2_c"];

function buildPlayerManager() {

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

    for (let index = 0; index < PLAYER_IDS.length; index += 1) {

        const playerId = PLAYER_IDS[index];

        const identity = new PlayerIdentity({
            playerId,
            nickname: `Player${index}`,
            wallet: `EQwallet${index}`,
            icon: ["dice", "spade", "queen"][index],
            age: 25,
            color: ["RED", "GREEN", "BLUE"][index],
            colorSector2: null,
            sectorCount: 1,
            sectorArrangement: "together",
            baseStake: 10,
            createdAt: 1000
        });

        const runtime = new PlayerRuntime({ lastSeen: 2000 });

        playerManager.attachPlayer({
            playerId,
            playerIndex: index,
            identity,
            runtime
        });

    }

    return playerManager;

}

function buildConfiguration() {

    return {
        gameId: GAME_ID,
        configurationVersion: "1.0",
        createdAt: 1000,
        traceSeed: "trace-seed-d2",
        sectors: [
            {
                sectorId: "sector-0",
                ownerId: PLAYER_IDS[0],
                color: "#d62828",
                icon: "dice",
                sectorIndexForPlayer: 0,
                angleStart: 0,
                angleEnd: 120
            },
            {
                sectorId: "sector-1",
                ownerId: PLAYER_IDS[1],
                color: "#00aa44",
                icon: "spade",
                sectorIndexForPlayer: 0,
                angleStart: 120,
                angleEnd: 240
            },
            {
                sectorId: "sector-2",
                ownerId: PLAYER_IDS[2],
                color: "#1c73d0",
                icon: "queen",
                sectorIndexForPlayer: 0,
                angleStart: 240,
                angleEnd: 360
            }
        ],
        players: [
            {
                playerId: PLAYER_IDS[0],
                nickname: "Player0",
                color: "RED",
                colors: ["RED"],
                icon: "dice",
                sectorCount: 1,
                sectorArrangement: null
            },
            {
                playerId: PLAYER_IDS[1],
                nickname: "Player1",
                color: "GREEN",
                colors: ["GREEN"],
                icon: "spade",
                sectorCount: 1,
                sectorArrangement: null
            },
            {
                playerId: PLAYER_IDS[2],
                nickname: "Player2",
                color: "BLUE",
                colors: ["BLUE"],
                icon: "queen",
                sectorCount: 1,
                sectorArrangement: null
            }
        ],
        wheel: {
            startAngle: 0,
            minSectors: 3,
            maxSectors: 6,
            sectorCount: 3,
            playerOrder: [0, 1, 2]
        },
        triangle: {
            startAngle: 0,
            ratio: { height: 0.04, width: 0.03 }
        },
        timers: {
            PRE_GAME_READY: { phase: "PRE_GAME_READY", durationMs: 180000 },
            READY: { phase: "READY", durationMs: 3000 },
            SELF_TEST: { phase: "SELF_TEST", durationMs: 1500 },
            SPEED: { phase: "SPEED", durationMs: 8000 },
            BRAKE: { phase: "BRAKE", durationMs: 6000 },
            RESULT: { phase: "RESULT", durationMs: 4000 }
        },
        stake: 10,
        metadata: {
            roomId: ROOM_ID,
            catalogVersion: "1.0"
        }
    };

}

function computeConfigurationHash(configuration) {

    return createHash("sha256")
        .update(stableStringify(configuration))
        .digest("hex");

}

function buildRandomService() {

    let calls = 0;

    return {
        generateTraceSeed() {

            calls += 1;

            return "generated-trace-seed";

        },
        nextInt() {

            calls += 1;

            return 0;

        },
        getCallCount() {

            return calls;

        }
    };

}

// ---------------------------------------------------------------------------
// ConfigurationEngine — attachConfiguration
// ---------------------------------------------------------------------------

(function testConfigurationAttach() {

    resetEventCounts();

    const randomService = buildRandomService();

    const configurationEngine = new ConfigurationEngine({
        logger,
        eventBus,
        gameCatalog,
        randomService
    });

    configurationEngine.initialize();

    const configuration = buildConfiguration();

    const configurationHash = computeConfigurationHash(configuration);

    // exact configuration/hash survives attach
    const attached = configurationEngine.attachConfiguration({
        gameId: GAME_ID,
        roomId: ROOM_ID,
        configuration,
        configurationHash
    });

    assert(attached, "attachConfiguration should return the attached configuration");

    assert(
        attached.gameId === GAME_ID,
        "attached configuration should preserve gameId"
    );

    assert(
        attached.traceSeed === "trace-seed-d2",
        "attached configuration should preserve traceSeed"
    );

    // attached object is deeply frozen
    assert(
        Object.isFrozen(attached),
        "attached configuration should be frozen"
    );

    assert(
        Object.isFrozen(attached.players),
        "attached configuration players should be frozen"
    );

    assert(
        Object.isFrozen(attached.sectors),
        "attached configuration sectors should be frozen"
    );

    // no random generation occurs
    assert(
        randomService.getCallCount() === 0,
        "attachConfiguration must not call randomService"
    );

    // no CONFIGURATION_READY event
    assert(
        eventCounts.get(EVENT_TYPES.CONFIGURATION_READY) === 0,
        "attachConfiguration must not emit CONFIGURATION_READY"
    );

    // equivalent duplicate is idempotent
    const duplicate = configurationEngine.attachConfiguration({
        gameId: GAME_ID,
        roomId: ROOM_ID,
        configuration,
        configurationHash
    });

    assert(
        duplicate === attached,
        "equivalent duplicate attach should return the existing configuration"
    );

    // conflicting duplicate is rejected
    const conflicting = {
        ...configuration,
        traceSeed: "different-trace-seed"
    };

    const conflictingHash = computeConfigurationHash(conflicting);

    assert(
        configurationEngine.attachConfiguration({
            gameId: GAME_ID,
            roomId: ROOM_ID,
            configuration: conflicting,
            configurationHash: conflictingHash
        }) === null,
        "conflicting duplicate attach should fail closed"
    );

    // identity mismatch
    assert(
        configurationEngine.attachConfiguration({
            gameId: "different-game",
            roomId: ROOM_ID,
            configuration,
            configurationHash
        }) === null,
        "gameId mismatch should fail closed"
    );

    assert(
        configurationEngine.attachConfiguration({
            gameId: GAME_ID,
            roomId: "different-room",
            configuration,
            configurationHash
        }) === null,
        "roomId mismatch should fail closed"
    );

    // hash mismatch
    assert(
        configurationEngine.attachConfiguration({
            gameId: GAME_ID,
            roomId: ROOM_ID,
            configuration,
            configurationHash: "invalid-hash"
        }) === null,
        "configurationHash mismatch should fail closed"
    );

    // failed attach leaves no partial state
    const failedGameId = "game_d2_failed";

    assert(
        configurationEngine.attachConfiguration({
            gameId: failedGameId,
            roomId: ROOM_ID,
            configuration: { ...configuration, gameId: failedGameId },
            configurationHash: "invalid-hash"
        }) === null,
        "failed attach should return null"
    );

    assert(
        configurationEngine.getConfiguration(failedGameId) === null,
        "failed attach must not leave partial state"
    );

    assert(
        configurationEngine.listConfigurationIds().length === 1,
        "only the successfully attached configuration should exist"
    );

    // Event isolation: no lifecycle events during attachment operations.
    assertZeroLifecycleEvents("ConfigurationEngine.attachConfiguration");

    configurationEngine.shutdown();

})();

// ---------------------------------------------------------------------------
// GameStateEngine — attachState
// ---------------------------------------------------------------------------

(function testGameStateAttach() {

    resetEventCounts();

    const gameStateEngine = new GameStateEngine({ logger, eventBus });

    gameStateEngine.initialize();

    // valid states attach directly
    const attached = gameStateEngine.attachState({
        gameId: GAME_ID,
        currentState: GAME_STATES.READY,
        enteredAt: 2000,
        previousState: GAME_STATES.PRE_GAME_READY,
        history: [
            {
                state: GAME_STATES.PRE_GAME_READY,
                enteredAt: 1000,
                reason: "recovery"
            },
            {
                state: GAME_STATES.READY,
                enteredAt: 2000,
                reason: "recovery"
            }
        ]
    });

    assert(attached, "attachState should return the attached state snapshot");

    assert(
        attached.currentState === GAME_STATES.READY,
        "attached state should preserve currentState"
    );

    assert(
        attached.enteredAt === 2000,
        "attached state should preserve enteredAt"
    );

    assert(
        attached.previousState === GAME_STATES.PRE_GAME_READY,
        "attached state should preserve previousState"
    );

    assert(
        attached.history.length === 2,
        "attached state should preserve history"
    );

    // no GAME_STATE_CHANGED
    assert(
        eventCounts.get(EVENT_TYPES.GAME_STATE_CHANGED) === 0,
        "attachState must not emit GAME_STATE_CHANGED"
    );

    // no GAME_STATE_REJECTED
    assert(
        eventCounts.get(EVENT_TYPES.GAME_STATE_REJECTED) === 0,
        "attachState must not emit GAME_STATE_REJECTED"
    );

    // invalid state rejected
    assert(
        gameStateEngine.attachState({
            gameId: "game_d2_invalid",
            currentState: "INVALID_STATE",
            enteredAt: 2000
        }) === null,
        "invalid state should be rejected"
    );

    // conflicting duplicate rejected
    assert(
        gameStateEngine.attachState({
            gameId: GAME_ID,
            currentState: GAME_STATES.SPEED,
            enteredAt: 3000
        }) === null,
        "conflicting duplicate state should fail closed"
    );

    // failed attachment leaves state clean
    assert(
        gameStateEngine.getState("game_d2_invalid") === null,
        "failed attachment must not leave state"
    );

    // Event isolation: no lifecycle events during attachment operations.
    assertZeroLifecycleEvents("GameStateEngine.attachState");

    gameStateEngine.shutdown();

})();

// ---------------------------------------------------------------------------
// GameClockEngine — attachClock + armRecoveredClock
// ---------------------------------------------------------------------------

(function testGameClockAttach() {

    resetEventCounts();

    const gameClockEngine = new GameClockEngine({
        logger,
        eventBus,
        gameCatalog
    });

    gameClockEngine.initialize();

    const now = Date.now();

    const checkpoint = now - 1000;

    // full supported recovery fields attach
    const attached = gameClockEngine.attachClock({
        gameId: GAME_ID,
        currentPhase: GAME_STATES.READY,
        startedAt: checkpoint - 5000,
        phaseStartedAt: checkpoint,
        paused: false,
        totalPausedMs: 0,
        awaitingResultActivation: false,
        resultPhaseStarted: false,
        serverTimestampAtCheckpoint: checkpoint
    }, { arm: false });

    assert(attached, "attachClock should return the attached clock snapshot");

    assert(
        attached.currentPhase === GAME_STATES.READY,
        "attached clock should preserve currentPhase"
    );

    assert(
        attached.running === false,
        "attachClock with arm:false must not start the clock"
    );

    // attach with arm:false creates no timeout
    const clockRecord = gameClockEngine._clocks.get(GAME_ID);

    assert(
        clockRecord.timeoutHandle === null,
        "attachClock with arm:false must not create a timeout"
    );

    // no lifecycle events emitted during attachment
    assert(
        eventCounts.get(EVENT_TYPES.CLOCK_STARTED) === 0,
        "attachClock must not emit CLOCK_STARTED"
    );

    assert(
        eventCounts.get(EVENT_TYPES.READY_STARTED) === 0,
        "attachClock must not emit READY_STARTED"
    );

    // arming creates exactly one timeout
    const armed = gameClockEngine.armRecoveredClock(GAME_ID);

    assert(armed, "armRecoveredClock should return the armed clock snapshot");

    assert(
        armed.running === true,
        "armRecoveredClock should mark the clock running"
    );

    assert(
        clockRecord.timeoutHandle !== null,
        "armRecoveredClock should create exactly one timeout"
    );

    // duplicate arming does not create another timeout
    const firstHandle = clockRecord.timeoutHandle;

    assert(
        gameClockEngine.armRecoveredClock(GAME_ID) === null,
        "duplicate arming should fail closed"
    );

    assert(
        clockRecord.timeoutHandle === firstHandle,
        "duplicate arming must not create another timeout"
    );

    // rollback/removal clears timers
    gameClockEngine.removeClock(GAME_ID);

    assert(
        gameClockEngine.getClock(GAME_ID) === null,
        "removeClock should remove the clock"
    );

    // Teardown of an armed clock legitimately emits CLOCK_STOPPED through
    // normal stop semantics; clear counters so subsequent refusal checks
    // validate attachment silence only.
    resetEventCounts();

    // expired deadline refuses arming
    const expiredGameId = "game_d2_expired";

    const expiredCheckpoint = now - 100000;

    gameClockEngine.attachClock({
        gameId: expiredGameId,
        currentPhase: GAME_STATES.READY,
        startedAt: expiredCheckpoint - 5000,
        phaseStartedAt: expiredCheckpoint,
        paused: false,
        totalPausedMs: 0,
        awaitingResultActivation: false,
        resultPhaseStarted: false,
        serverTimestampAtCheckpoint: expiredCheckpoint
    }, { arm: false });

    assert(
        gameClockEngine.armRecoveredClock(expiredGameId) === null,
        "expired deadline should refuse arming"
    );

    const expiredRecord = gameClockEngine._clocks.get(expiredGameId);

    assert(
        expiredRecord.timeoutHandle === null,
        "expired clock must not have a timeout"
    );

    gameClockEngine.removeClock(expiredGameId);

    // phase/configuration timer mismatch rejected
    const mismatchGameId = "game_d2_mismatch";

    assert(
        gameClockEngine.attachClock({
            gameId: mismatchGameId,
            currentPhase: "INVALID_PHASE",
            startedAt: checkpoint - 5000,
            phaseStartedAt: checkpoint,
            paused: false,
            totalPausedMs: 0,
            awaitingResultActivation: false,
            resultPhaseStarted: false,
            serverTimestampAtCheckpoint: checkpoint
        }, { arm: false }) === null,
        "invalid phase should be rejected"
    );

    // Event isolation: no lifecycle events during expired/mismatch refusal.
    assertZeroLifecycleEvents("GameClockEngine.attachClock/armRecoveredClock");

    gameClockEngine.shutdown();

})();

// ---------------------------------------------------------------------------
// PhysicsEngine — attachSimulation
// ---------------------------------------------------------------------------

(function testPhysicsAttach() {

    resetEventCounts();

    const physicsEngine = new PhysicsEngine({
        logger,
        eventBus,
        gameClock: null
    });

    physicsEngine.initialize();

    // CREATED pre-motion attachment succeeds silently
    const created = physicsEngine.attachSimulation({
        gameId: GAME_ID,
        runtime: {
            state: PHYSICS_SIMULATION_STATE.CREATED,
            angle: 0,
            triangleAngle: 0,
            angularVelocity: 0,
            triangleAngularVelocity: 0,
            angularAcceleration: 0
        },
        commandLog: []
    }, { emitEvents: false });

    assert(created, "CREATED attachSimulation should succeed");

    assert(
        created.runtime.state === PHYSICS_SIMULATION_STATE.CREATED,
        "attached simulation should preserve CREATED state"
    );

    // no PHYSICS_STARTED/STOPPED
    assert(
        eventCounts.get(EVENT_TYPES.PHYSICS_STARTED) === 0,
        "attachSimulation must not emit PHYSICS_STARTED"
    );

    assert(
        eventCounts.get(EVENT_TYPES.PHYSICS_STOPPED) === 0,
        "attachSimulation must not emit PHYSICS_STOPPED"
    );

    // RUNNING rejected
    assert(
        physicsEngine.attachSimulation({
            gameId: "game_d2_running",
            runtime: {
                state: PHYSICS_SIMULATION_STATE.RUNNING,
                angle: 0,
                triangleAngle: 0,
                angularVelocity: 1,
                triangleAngularVelocity: 1,
                angularAcceleration: 0
            }
        }) === null,
        "RUNNING attachSimulation should be rejected"
    );

    // BRAKING rejected
    assert(
        physicsEngine.attachSimulation({
            gameId: "game_d2_braking",
            runtime: {
                state: PHYSICS_SIMULATION_STATE.BRAKING,
                angle: 0,
                triangleAngle: 0,
                angularVelocity: 1,
                triangleAngularVelocity: 1,
                angularAcceleration: 0
            }
        }) === null,
        "BRAKING attachSimulation should be rejected"
    );

    // failed attach leaves no stale simulation
    assert(
        physicsEngine.getSimulation("game_d2_running") === null,
        "failed attach must not leave stale simulation"
    );

    physicsEngine.removeSimulation(GAME_ID);

    // terminal STOPPED attachment succeeds
    const finalAngle = 2.5;

    const finalTriangleAngle = 1.0;

    const stopped = physicsEngine.attachSimulation({
        gameId: GAME_ID,
        runtime: {
            state: PHYSICS_SIMULATION_STATE.STOPPED,
            angle: finalAngle,
            triangleAngle: finalTriangleAngle,
            angularVelocity: 0,
            triangleAngularVelocity: 0,
            angularAcceleration: 0
        },
        commandLog: []
    }, { emitEvents: false });

    assert(stopped, "STOPPED attachSimulation should succeed");

    // final angles remain exact
    assert(
        stopped.runtime.angle === finalAngle,
        "final wheel angle should remain exact"
    );

    assert(
        stopped.runtime.triangleAngle === finalTriangleAngle,
        "final triangle angle should remain exact"
    );

    // terminal motion values are validated
    assert(
        physicsEngine.attachSimulation({
            gameId: "game_d2_bad_motion",
            runtime: {
                state: PHYSICS_SIMULATION_STATE.STOPPED,
                angle: 1.0,
                triangleAngle: 1.0,
                angularVelocity: 0.5,
                triangleAngularVelocity: 0,
                angularAcceleration: 0
            }
        }) === null,
        "STOPPED with non-zero velocity should be rejected"
    );

    // no SimulationLoop registration (no PHYSICS_STARTED emitted)
    assert(
        eventCounts.get(EVENT_TYPES.PHYSICS_STARTED) === 0,
        "attachSimulation must not register in SimulationLoop"
    );

    // Event isolation: no lifecycle events during attachment operations.
    assertZeroLifecycleEvents("PhysicsEngine.attachSimulation");

    physicsEngine.shutdown();

})();

// ---------------------------------------------------------------------------
// InputAuthority — attachRegistry
// ---------------------------------------------------------------------------

(function testInputAttach() {

    resetEventCounts();

    const playerManager = buildPlayerManager();

    const gameStateEngine = new GameStateEngine({ logger, eventBus });

    gameStateEngine.initialize();

    const physicsEngine = new PhysicsEngine({
        logger,
        eventBus,
        gameClock: null
    });

    physicsEngine.initialize();

    const inputAuthority = new InputAuthority({
        logger,
        eventBus,
        gameCatalog,
        playerManager,
        physicsEngine,
        gameStateEngine
    });

    inputAuthority.initialize();

    // exact expected player set
    const attached = inputAuthority.attachRegistry({
        gameId: GAME_ID,
        playerIds: PLAYER_IDS,
        commandQueue: [],
        acceptedCommands: [],
        sequenceNumber: 0
    });

    assert(attached, "attachRegistry should return the attached registry snapshot");

    assert(
        attached.playerIds.length === 3,
        "attachRegistry should register exactly three players"
    );

    // default empty queue
    assert(
        attached.commandQueueLength === 0,
        "attachRegistry should have empty command queue"
    );

    // sequence number safe default
    assert(
        attached.sequenceNumber === 0,
        "attachRegistry should have sequenceNumber 0"
    );

    // no PlayerManager mutation
    assert(
        playerManager.getRuntime(PLAYER_IDS[0]).playerState === "IDLE",
        "attachRegistry must not mutate PlayerManager"
    );

    // no input events
    assert(
        eventCounts.get(EVENT_TYPES.PLAYER_INPUT_ACCEPTED) === 0,
        "attachRegistry must not emit PLAYER_INPUT_ACCEPTED"
    );

    assert(
        eventCounts.get(EVENT_TYPES.PLAYER_INPUT_REJECTED) === 0,
        "attachRegistry must not emit PLAYER_INPUT_REJECTED"
    );

    // duplicate/unknown player rejected atomically
    assert(
        inputAuthority.attachRegistry({
            gameId: "game_d2_dup",
            playerIds: [PLAYER_IDS[0], PLAYER_IDS[0]]
        }) === null,
        "duplicate playerIds should be rejected"
    );

    assert(
        inputAuthority.attachRegistry({
            gameId: "game_d2_unknown",
            playerIds: ["unknown_player"]
        }) === null,
        "unknown player should be rejected"
    );

    assert(
        inputAuthority.hasGame("game_d2_unknown") === false,
        "failed attach must not leave partial registry"
    );

    // active SPEED/BRAKE restoration rejected (non-empty queue)
    assert(
        inputAuthority.attachRegistry({
            gameId: "game_d2_active",
            playerIds: PLAYER_IDS,
            commandQueue: [{ type: "ACCELERATION_START" }]
        }) === null,
        "non-empty commandQueue should be rejected"
    );

    // Event isolation: no lifecycle events during attachment operations.
    assertZeroLifecycleEvents("InputAuthority.attachRegistry");

    inputAuthority.shutdown();

    gameStateEngine.shutdown();

    physicsEngine.shutdown();

    playerManager.shutdown();

})();

// ---------------------------------------------------------------------------
// WinnerEngine — attachResult + restoreResult
// ---------------------------------------------------------------------------

(function testWinnerAttach() {

    resetEventCounts();

    const configurationEngine = new ConfigurationEngine({
        logger,
        eventBus,
        gameCatalog,
        randomService: buildRandomService()
    });

    configurationEngine.initialize();

    const physicsEngine = new PhysicsEngine({
        logger,
        eventBus,
        gameClock: null
    });

    physicsEngine.initialize();

    const winnerEngine = new WinnerEngine({
        logger,
        eventBus,
        physicsEngine,
        configurationEngine,
        gameCatalog
    });

    winnerEngine.initialize();

    const configuration = buildConfiguration();

    const configurationHash = computeConfigurationHash(configuration);

    configurationEngine.attachConfiguration({
        gameId: GAME_ID,
        roomId: ROOM_ID,
        configuration,
        configurationHash
    });

    // no result required before RESULT
    assert(
        winnerEngine.getResult(GAME_ID) === null,
        "WinnerEngine should remain empty before RESULT"
    );

    // terminal winner is deterministic from exact configuration + STOPPED physics
    const finalAngle = 2.5;

    const finalTriangleAngle = 1.0;

    physicsEngine.attachSimulation({
        gameId: GAME_ID,
        runtime: {
            state: PHYSICS_SIMULATION_STATE.STOPPED,
            angle: finalAngle,
            triangleAngle: finalTriangleAngle,
            angularVelocity: 0,
            triangleAngularVelocity: 0,
            angularAcceleration: 0
        },
        commandLog: []
    }, { emitEvents: false });

    const restored = winnerEngine.restoreResult(GAME_ID);

    assert(restored, "restoreResult should return the recomputed result");

    assert(
        restored.winnerPlayerId,
        "restoreResult should determine a winner"
    );

    assert(
        restored.resolvedAt === null,
        "restoreResult must not invent the historical resolvedAt"
    );

    // no winner/result events
    assert(
        eventCounts.get(EVENT_TYPES.WINNING_SECTOR_RESOLVED) === 0,
        "restoreResult must not emit WINNING_SECTOR_RESOLVED"
    );

    assert(
        eventCounts.get(EVENT_TYPES.GAME_RESULT_READY) === 0,
        "restoreResult must not emit GAME_RESULT_READY"
    );

    // equivalent result safe
    const equivalent = winnerEngine.restoreResult(GAME_ID);

    assert(
        equivalent === restored,
        "equivalent restoreResult should return the existing result"
    );

    // conflicting result rejected
    const conflictingResult = {
        gameId: GAME_ID,
        winningSector: {
            index: 0,
            sectorId: "sector-0",
            ownerId: PLAYER_IDS[0],
            color: "RED",
            icon: "dice"
        },
        winningPlayer: {
            playerId: PLAYER_IDS[0],
            color: "RED",
            icon: "dice"
        },
        winnerPlayerId: PLAYER_IDS[0],
        winnerSectorIndex: 0,
        prize: null,
        payout: null,
        finalAngle: 0.1,
        wheelFinalAngle: 0.1,
        triangleFinalAngle: 0.1,
        resolvedAt: 1000,
        traceSeed: "trace-seed-d2",
        metadata: { configurationVersion: "1.0" }
    };

    assert(
        winnerEngine.attachResult(conflictingResult) === null,
        "conflicting result should fail closed"
    );

    // missing historical resolvedAt is not invented
    assert(
        restored.resolvedAt === null,
        "missing historical resolvedAt must not be invented"
    );

    // Event isolation: no lifecycle events during attachment/restoration.
    assertZeroLifecycleEvents("WinnerEngine.attachResult/restoreResult");

    winnerEngine.shutdown();

    physicsEngine.shutdown();

    configurationEngine.shutdown();

})();

logger.info("R17.9T.6-D2 recovery engine attach tests passed");
