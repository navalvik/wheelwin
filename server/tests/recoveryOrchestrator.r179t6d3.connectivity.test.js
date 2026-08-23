/**
 * R17.9T.6 OPTION B — Connectivity-Aware Recovered Clock Arming tests.
 *
 * Covers:
 *   A. Zero connected players        → UNARMED-ATTACHED, pending, no timeout;
 *   B. One connected player          → remains unarmed/pending;
 *   C. Two connected players         → remains unarmed/pending;
 *   D. All three already connected   → arms exactly once during recovery,
 *                                      original deadline authoritative;
 *   E. Sequential connects 0→1→2→3   → arms exactly once at 3;
 *   F. Duplicate PLAYER_CONNECTED    → no duplicate arm / no second timeout;
 *   G. Deadline expires before full
 *      reconnect                     → existing fail-closed behavior, no
 *                                      deadline extension, no invented state;
 *   H. Disconnect after arming       → clock continues normally (no pause/
 *                                      disarm/deadline change);
 *   I. RESULT recovery               → terminal, no pending clock, no arming;
 *   J. Unsupported phase             → classification unchanged, no pending;
 *   K. Candidate rollback            → no runtime or pending residue;
 *   L. Second recovery pass          → idempotent, no duplicate pending/
 *                                      timeout;
 *   M. Normal game isolation         → PLAYER_CONNECTED never affects normal
 *                                      GameClockEngine clocks.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { RoomManager } from "../managers/RoomManager.js";
import { GameManager } from "../managers/GameManager.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { ConfigurationEngine } from "../engines/ConfigurationEngine.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { GameClockEngine } from "../engines/GameClockEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { WinnerEngine } from "../engines/WinnerEngine.js";
import { InputAuthority } from "../input/InputAuthority.js";
import { GameCatalog } from "../catalog/GameCatalog.js";
import { LoggerService } from "../services/LoggerService.js";
import {
    TonFinancialPersistence
} from "../persistence/TonFinancialPersistence.js";
import {
    RecoveryDataPersistence
} from "../persistence/RecoveryDataPersistence.js";
import {
    RecoveryOrchestrator,
    RECOVERY_RESULT_STATUS
} from "../recovery/RecoveryOrchestrator.js";
import { stableStringify } from "../persistence/tonFinancialRecordUtils.js";
import { PlayerRuntime } from "../models/PlayerRuntime.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

const GAME_ID = "game_conn_arming_001";

const ROOM_ID = "room_conn_arming_001";

const PLAYER_IDS = ["player_conn_a", "player_conn_b", "player_conn_c"];

const logger = new LoggerService();

logger.initialize();

function buildConfiguration() {

    return {
        gameId: GAME_ID,
        configurationVersion: "1.0",
        createdAt: 1000,
        traceSeed: "trace-seed-conn",
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

/**
 * Build a valid RECOVERY_DATA payload (READY by default).
 *
 * `phaseAgeMs` controls how much of the READY phase elapsed at checkpoint
 * (default leaves ample remaining time).
 */
function buildPayload(overrides = {}, { phaseAgeMs = 500 } = {}) {

    const configuration = overrides.configuration ?? buildConfiguration();

    const now = Date.now();

    const checkpoint = now - 200;

    const payload = {
        recoveryContractVersion: 1,
        schemaVersion: 1,
        recoveryRecordId: GAME_ID,
        roomId: ROOM_ID,
        gameId: GAME_ID,
        contractId: "contract_conn_001",
        paymentSessionId: "payment_session_conn_001",
        tonNetwork: "testnet",
        correlationId: null,
        players: [
            {
                playerId: PLAYER_IDS[0],
                playerIndex: 0,
                wallet: "EQconnA",
                nickname: "Player0",
                baseStake: 10,
                sectorCount: 1,
                color: "RED",
                colorSector2: null,
                icon: "dice",
                sectorArrangement: "single",
                age: 25
            },
            {
                playerId: PLAYER_IDS[1],
                playerIndex: 1,
                wallet: "EQconnB",
                nickname: "Player1",
                baseStake: 10,
                sectorCount: 1,
                color: "GREEN",
                colorSector2: null,
                icon: "spade",
                sectorArrangement: "single",
                age: 30
            },
            {
                playerId: PLAYER_IDS[2],
                playerIndex: 2,
                wallet: "EQconnC",
                nickname: "Player2",
                baseStake: 10,
                sectorCount: 1,
                color: "BLUE",
                colorSector2: null,
                icon: "queen",
                sectorArrangement: "single",
                age: 28
            }
        ],
        configuration,
        configurationHash: computeConfigurationHash(configuration),
        configurationVersion: "1.0",
        traceSeed: "trace-seed-conn",
        snapshotHash: "snapshot-hash-conn-001",
        gameState: "READY",
        gameStatus: "RUNNING",
        phaseStartedAt: checkpoint - phaseAgeMs,
        clockStartedAt: checkpoint - phaseAgeMs - 5000,
        clockPaused: false,
        clockTotalPausedMs: 0,
        awaitingResultActivation: false,
        resultPhaseStarted: false,
        serverTimestampAtCheckpoint: checkpoint,
        physicsFinalAngle: 2.5,
        physicsFinalTriangleAngle: 1.0,
        physicsSimulationState: "STOPPED",
        winnerId: null,
        ...overrides
    };

    if (overrides.configuration !== undefined
        && overrides.configurationHash === undefined) {

        payload.configurationHash = computeConfigurationHash(
            payload.configuration
        );

    }

    return payload;

}

function buildGraph() {

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const gameCatalog = new GameCatalog({ logger });

    gameCatalog.initialize();

    let lifecycleEventCount = 0;

    for (const eventType of [
        EVENT_TYPES.CLOCK_STARTED,
        EVENT_TYPES.CLOCK_PAUSED,
        EVENT_TYPES.CLOCK_RESUMED,
        EVENT_TYPES.CLOCK_STOPPED,
        EVENT_TYPES.PHASE_TIMEOUT,
        EVENT_TYPES.GAME_STATE_CHANGED,
        EVENT_TYPES.PRE_GAME_READY_STARTED,
        EVENT_TYPES.READY_STARTED,
        EVENT_TYPES.SPEED_STARTED,
        EVENT_TYPES.RESULT_STARTED
    ]) {

        eventBus.subscribe(eventType, () => {

            lifecycleEventCount += 1;

        });

    }

    const roomManager = new RoomManager({
        logger,
        eventBus,
        roomConfig: { maxPlayers: 3 }
    });

    roomManager.initialize();

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

    const gameManager = new GameManager({ logger, eventBus });

    gameManager.initialize();

    const randomService = {
        generateTraceSeed() {

            throw new Error("randomService must never be called during recovery");

        },
        nextInt() {

            throw new Error("randomService must never be called during recovery");

        }
    };

    const configurationEngine = new ConfigurationEngine({
        logger,
        eventBus,
        gameCatalog,
        randomService
    });

    configurationEngine.initialize();

    const gameStateEngine = new GameStateEngine({ logger, eventBus });

    gameStateEngine.initialize();

    const gameClockEngine = new GameClockEngine({
        logger,
        eventBus,
        gameCatalog
    });

    gameClockEngine.initialize();

    const physicsEngine = new PhysicsEngine({
        logger,
        eventBus,
        gameClock: gameClockEngine
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

    const winnerEngine = new WinnerEngine({
        logger,
        eventBus,
        physicsEngine,
        configurationEngine,
        gameCatalog
    });

    winnerEngine.initialize();

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-conn-arming-"));

    const financialPersistence = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint: false
    });

    financialPersistence.initialize();

    const recoveryDataPersistence = new RecoveryDataPersistence({
        financialPersistence
    });

    const orchestrator = new RecoveryOrchestrator({
        logger,
        recoveryDataPersistence,
        roomManager,
        playerManager,
        gameManager,
        configurationEngine,
        gameStateEngine,
        gameClockEngine,
        physicsEngine,
        inputAuthority,
        winnerEngine
    });

    return {
        eventBus,
        lifecycleEvents: () => lifecycleEventCount,
        roomManager,
        playerManager,
        gameManager,
        configurationEngine,
        gameStateEngine,
        gameClockEngine,
        physicsEngine,
        inputAuthority,
        winnerEngine,
        recoveryDataPersistence,
        orchestrator
    };

}

/** Connect N players through the authoritative PlayerManager API. */
function connectPlayers(graph, count) {

    for (let i = 0; i < count; i += 1) {

        graph.playerManager.setConnectionState(PLAYER_IDS[i], "CONNECTED");

    }

}

function assertUnarmedPending(graph, label) {

    const record = graph.gameClockEngine._clocks.get(GAME_ID);

    assert(
        record && record.running === false,
        `${label}: clock must be attached but NOT running`
    );

    assert(
        record.timeoutHandle === null,
        `${label}: no timeout may be scheduled while unarmed`
    );

    assert(
        graph.orchestrator._pendingRecoveredClocks.has(GAME_ID),
        `${label}: game must remain in pending recovered-clock state`
    );

}

// ---------------------------------------------------------------------------
// A. Zero connected players
// ---------------------------------------------------------------------------

(function testCaseA() {

    const graph = buildGraph();

    const result = graph.orchestrator.recoverCandidate(buildPayload());

    assert(
        result.status === RECOVERY_RESULT_STATUS.SUCCESS,
        `A: recovery should succeed, got ${result.status} (${result.reason})`
    );

    assertUnarmedPending(graph, "A");

    assert(
        graph.lifecycleEvents() === 0,
        "A: dormant recovered state must emit zero lifecycle events"
    );

    graph.gameClockEngine.removeClock(GAME_ID);

})();

// ---------------------------------------------------------------------------
// B. One connected player
// ---------------------------------------------------------------------------

(function testCaseB() {

    const graph = buildGraph();

    const result = graph.orchestrator.recoverCandidate(buildPayload());

    assert(result.status === RECOVERY_RESULT_STATUS.SUCCESS, "B: success");

    connectPlayers(graph, 1);

    assertUnarmedPending(graph, "B");

    assert(graph.lifecycleEvents() === 0, "B: no phase progression");

    graph.gameClockEngine.removeClock(GAME_ID);

})();

// ---------------------------------------------------------------------------
// C. Two connected players
// ---------------------------------------------------------------------------

(function testCaseC() {

    const graph = buildGraph();

    const result = graph.orchestrator.recoverCandidate(buildPayload());

    assert(result.status === RECOVERY_RESULT_STATUS.SUCCESS, "C: success");

    connectPlayers(graph, 2);

    assertUnarmedPending(graph, "C");

    assert(graph.lifecycleEvents() === 0, "C: no phase progression");

    graph.gameClockEngine.removeClock(GAME_ID);

})();

// ---------------------------------------------------------------------------
// D. All three connected during recovery (already-connected case)
// ---------------------------------------------------------------------------

(function testCaseD() {

    const graph = buildGraph();

    const payload = buildPayload();

    const result = graph.orchestrator.recoverCandidate(payload);

    assert(
        result.status === RECOVERY_RESULT_STATUS.SUCCESS,
        `D: recovery should succeed, got ${result.status}`
    );

    // All three players report CONNECTED (connection state available right
    // after reconstruction): the explicit current-state evaluation must arm
    // exactly once.
    connectPlayers(graph, 3);

    const record = graph.gameClockEngine._clocks.get(GAME_ID);

    assert(record && record.running === true, "D: clock must be running");

    assert(record.timeoutHandle !== null, "D: exactly one timeout scheduled");

    assert(
        !graph.orchestrator._pendingRecoveredClocks.has(GAME_ID),
        "D: pending entry must be removed after successful arming"
    );

    // Original authoritative deadline remains unchanged.
    const expectedDeadline = payload.phaseStartedAt
        + payload.configuration.timers.READY.durationMs;

    assert(
        record.phaseEndsAt === expectedDeadline,
        `D: original deadline must remain authoritative `
            + `(got ${record.phaseEndsAt}, expected ${expectedDeadline})`
    );

    // Duplicate PLAYER_CONNECTED after arming must be a safe no-op.
    graph.playerManager.setConnectionState(PLAYER_IDS[0], "DISCONNECTED");

    graph.playerManager.setConnectionState(PLAYER_IDS[0], "CONNECTED");

    assert(
        record.running === true && record.timeoutHandle !== null,
        "D: post-arming connection churn must not re-arm or reset"
    );

    graph.gameClockEngine.removeClock(GAME_ID);

})();

// ---------------------------------------------------------------------------
// E. Players connect sequentially 0 → 1 → 2 → 3
// ---------------------------------------------------------------------------

(function testCaseE() {

    const graph = buildGraph();

    const result = graph.orchestrator.recoverCandidate(buildPayload());

    assert(result.status === RECOVERY_RESULT_STATUS.SUCCESS, "E: success");

    graph.playerManager.setConnectionState(PLAYER_IDS[0], "CONNECTED");

    assertUnarmedPending(graph, "E (after 1)");

    graph.playerManager.setConnectionState(PLAYER_IDS[1], "CONNECTED");

    assertUnarmedPending(graph, "E (after 2)");

    graph.playerManager.setConnectionState(PLAYER_IDS[2], "CONNECTED");

    const record = graph.gameClockEngine._clocks.get(GAME_ID);

    assert(
        record.running === true && record.timeoutHandle !== null,
        "E: clock must arm exactly once at the third connection"
    );

    assert(
        !graph.orchestrator._pendingRecoveredClocks.has(GAME_ID),
        "E: pending entry removed after arming"
    );

    graph.gameClockEngine.removeClock(GAME_ID);

})();

// ---------------------------------------------------------------------------
// F. Duplicate PLAYER_CONNECTED notifications
// ---------------------------------------------------------------------------

(function testCaseF() {

    const graph = buildGraph();

    const result = graph.orchestrator.recoverCandidate(buildPayload());

    assert(result.status === RECOVERY_RESULT_STATUS.SUCCESS, "F: success");

    // Duplicate direct handler invocations before the predicate holds.
    for (let i = 0; i < 3; i += 1) {

        graph.orchestrator._handlePlayerConnected({
            payload: { playerId: PLAYER_IDS[0], connectionState: "CONNECTED" }
        });

    }

    assertUnarmedPending(graph, "F (pre-predicate duplicates)");

    // Connect all three, then send duplicate notifications.
    connectPlayers(graph, 3);

    const recordBefore = graph.gameClockEngine._clocks.get(GAME_ID);

    assert(recordBefore.running === true, "F: clock should be armed");

    for (let i = 0; i < 3; i += 1) {

        graph.orchestrator._handlePlayerConnected({
            payload: { playerId: PLAYER_IDS[i], connectionState: "CONNECTED" }
        });

    }

    const recordAfter = graph.gameClockEngine._clocks.get(GAME_ID);

    assert(
        recordAfter.running === true,
        "F: duplicate notifications must not disarm"
    );

    assert(
        recordAfter.timeoutHandle === recordBefore.timeoutHandle,
        "F: no second timeout may be created"
    );

    assert(
        !graph.orchestrator._pendingRecoveredClocks.has(GAME_ID),
        "F: no pending residue"
    );

    graph.gameClockEngine.removeClock(GAME_ID);

})();

// ---------------------------------------------------------------------------
// G. Deadline expires before all three reconnect
// ---------------------------------------------------------------------------

async function testCaseG() {

    const graph = buildGraph();

    // READY duration is 3000ms; leave only ~120ms remaining at recovery.
    const payload = buildPayload({}, { phaseAgeMs: 2880 });

    const result = graph.orchestrator.recoverCandidate(payload);

    assert(
        result.status === RECOVERY_RESULT_STATUS.SUCCESS,
        `G: recovery should succeed (pending), got ${result.status}`
    );

    assertUnarmedPending(graph, "G");

    // Let the original authoritative deadline elapse before reconnecting.
    await new Promise((resolve) => setTimeout(resolve, 300));

    connectPlayers(graph, 3);

    const record = graph.gameClockEngine._clocks.get(GAME_ID);

    assert(
        record && record.running === false,
        "G: late arming attempt must fail closed (clock stays unarmed)"
    );

    assert(
        record.timeoutHandle === null,
        "G: no timeout may be scheduled after refused arming"
    );

    assert(
        !graph.orchestrator._pendingRecoveredClocks.has(GAME_ID),
        "G: pending entry must be cleaned up after fail-closed refusal"
    );

    // No deadline extension, no phase restart, no invented recovery state.
    const expectedDeadline = payload.phaseStartedAt
        + payload.configuration.timers.READY.durationMs;

    assert(
        record.phaseEndsAt === expectedDeadline,
        "G: original deadline must remain untouched"
    );

    assert(
        graph.lifecycleEvents() === 0,
        "G: late arming attempt must cause zero gameplay events"
    );

    graph.gameClockEngine.removeClock(GAME_ID);

}

// ---------------------------------------------------------------------------
// H. Disconnect after successful arming
// ---------------------------------------------------------------------------

(function testCaseH() {

    const graph = buildGraph();

    const result = graph.orchestrator.recoverCandidate(buildPayload());

    assert(result.status === RECOVERY_RESULT_STATUS.SUCCESS, "H: success");

    connectPlayers(graph, 3);

    const record = graph.gameClockEngine._clocks.get(GAME_ID);

    assert(record.running === true, "H: clock should be armed");

    const handleBefore = record.timeoutHandle;

    const endsAtBefore = record.phaseEndsAt;

    // Disconnect a player after arming: deliberate no-op for recovered clocks.
    graph.playerManager.setConnectionState(PLAYER_IDS[0], "DISCONNECTED");

    assert(
        record.running === true,
        "H: PLAYER_DISCONNECTED must NOT pause/disarm the recovered clock"
    );

    assert(
        record.timeoutHandle === handleBefore,
        "H: timeout handle must be unchanged"
    );

    assert(
        record.phaseEndsAt === endsAtBefore,
        "H: authoritative deadline must be unchanged"
    );

    graph.gameClockEngine.removeClock(GAME_ID);

})();

// ---------------------------------------------------------------------------
// I. RESULT recovery
// ---------------------------------------------------------------------------

(function testCaseI() {

    const graph = buildGraph();

    const result = graph.orchestrator.recoverCandidate(
        buildPayload({ gameState: "RESULT" })
    );

    assert(
        result.status === RECOVERY_RESULT_STATUS.SUCCESS,
        `I: RESULT recovery should succeed, got ${result.status}`
    );

    assert(
        graph.gameClockEngine.getClock(GAME_ID) === null,
        "I: no clock may be attached for terminal RESULT recovery"
    );

    assert(
        !graph.orchestrator._pendingRecoveredClocks.has(GAME_ID),
        "I: no pending clock state for RESULT recovery"
    );

})();

// ---------------------------------------------------------------------------
// J. Unsupported phase
// ---------------------------------------------------------------------------

["SELF_TEST", "SPEED", "BRAKE"].forEach((phase) => {

    (function testCaseJ() {

        const graph = buildGraph();

        const result = graph.orchestrator.recoverCandidate(
            buildPayload({ gameState: phase })
        );

        assert(
            result.status === RECOVERY_RESULT_STATUS.SKIPPED_NOT_RECOVERABLE,
            `J(${phase}): unsupported phase must fail closed`
        );

        assert(
            graph.orchestrator._pendingRecoveredClocks.size === 0,
            `J(${phase}): no pending clock state may remain`
        );

    })();

});

// ---------------------------------------------------------------------------
// K. Candidate rollback leaves no pending residue
// ---------------------------------------------------------------------------

(function testCaseK() {

    const graph = buildGraph();

    graph.physicsEngine.attachSimulation = () => null;

    const result = graph.orchestrator.recoverCandidate(buildPayload());

    assert(
        result.status === RECOVERY_RESULT_STATUS.FAILED_PHYSICS,
        `K: injected failure must roll back, got ${result.status}`
    );

    assert(
        graph.roomManager.hasRoom(ROOM_ID) === false
            && graph.gameManager.hasGame(GAME_ID) === false
            && graph.gameClockEngine.getClock(GAME_ID) === null,
        "K: no runtime residue after rollback"
    );

    assert(
        graph.orchestrator._pendingRecoveredClocks.size === 0,
        "K: no pending clock residue after rollback"
    );

    assert(
        graph.lifecycleEvents() === 0,
        "K: rollback must emit zero gameplay lifecycle events"
    );

})();

// ---------------------------------------------------------------------------
// L. Second recovery pass (idempotency)
// ---------------------------------------------------------------------------

(function testCaseL() {

    const graph = buildGraph();

    const payload = buildPayload();

    const first = graph.orchestrator.recoverCandidate(payload);

    assert(first.status === RECOVERY_RESULT_STATUS.SUCCESS, "L: first pass");

    const second = graph.orchestrator.recoverCandidate(payload);

    assert(
        second.status === RECOVERY_RESULT_STATUS.ALREADY_RECOVERED,
        `L: second pass must be idempotent, got ${second.status}`
    );

    assert(
        [...graph.orchestrator._pendingRecoveredClocks.keys()]
            .filter((id) => id === GAME_ID).length === 1,
        "L: exactly one pending entry after duplicate pass"
    );

    connectPlayers(graph, 3);

    const record = graph.gameClockEngine._clocks.get(GAME_ID);

    assert(
        record.running === true && record.timeoutHandle !== null,
        "L: clock arms exactly once despite duplicate recovery pass"
    );

    graph.gameClockEngine.removeClock(GAME_ID);

})();

// ---------------------------------------------------------------------------
// M. Normal game isolation
// ---------------------------------------------------------------------------

(function testCaseM() {

    const graph = buildGraph();

    // Build a NORMAL (non-recovered) game runtime directly through the
    // existing manager/engine APIs.
    const normalGameId = "game_normal_isolation_001";

    const normalRoomId = "room_normal_isolation_001";

    const normalPlayerIds = ["player_norm_a", "player_norm_b", "player_norm_c"];

    graph.roomManager.attachRoom({
        roomId: normalRoomId,
        createdAt: Date.now(),
        status: "FULL",
        maxPlayers: 3,
        players: [...normalPlayerIds]
    });

    normalPlayerIds.forEach((playerId, index) => {

        graph.playerManager.attachPlayer({
            playerId,
            playerIndex: index,
            identity: {
                playerId,
                nickname: `N${index}`,
                wallet: `EQn${index}`,
                icon: null,
                age: null,
                color: null,
                colorSector2: null,
                sectorCount: 1,
                sectorArrangement: null,
                baseStake: 1,
                createdAt: null
            },
            runtime: new PlayerRuntime({
                roomId: normalRoomId,
                gameId: normalGameId
            })
        });

    });

    graph.gameManager.attachGame({
        gameId: normalGameId,
        roomId: normalRoomId,
        createdAt: Date.now(),
        status: "RUNNING",
        players: [...normalPlayerIds],
        metadata: {}
    });

    const created = graph.gameClockEngine.createClock(normalGameId);

    assert(created, "M: normal clock creation must work");

    const started = graph.gameClockEngine.startClock(normalGameId, "READY");

    assert(started, "M: normal clock start must work");

    const normalRecord = graph.gameClockEngine._clocks.get(normalGameId);

    const endsAtBefore = normalRecord.phaseEndsAt;

    const handleBefore = normalRecord.timeoutHandle;

    // Fire PLAYER_CONNECTED events for the normal game's players.
    for (const playerId of normalPlayerIds) {

        graph.playerManager.setConnectionState(playerId, "CONNECTED");

    }

    assert(
        normalRecord.running === true,
        "M: normal clock must keep running"
    );

    assert(
        normalRecord.timeoutHandle === handleBefore,
        "M: normal clock timeout must be untouched by PLAYER_CONNECTED"
    );

    assert(
        normalRecord.phaseEndsAt === endsAtBefore,
        "M: normal clock deadline must be untouched by PLAYER_CONNECTED"
    );

    assert(
        !graph.orchestrator._pendingRecoveredClocks.has(normalGameId),
        "M: normal games must never enter pending recovered-clock state"
    );

    graph.gameClockEngine.removeClock(normalGameId);

})();

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

testCaseG()
    .then(() => {

        logger.info(
            "R17.9T.6 OPTION B connectivity-aware recovered clock arming "
                + "tests passed"
        );

    })
    .catch((error) => {

        logger.error(`Connectivity arming tests FAILED: ${error?.message}`);

        process.exitCode = 1;

    });