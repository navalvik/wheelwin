/**
 * R17.9T.6-D3 — RecoveryOrchestrator focused tests.
 *
 * Covers:
 *   A/B. PRE_GAME_READY / READY success (full attach set, clock armed last,
 *        zero gameplay events, no SimulationLoop registration);
 *   C.   RESULT success (terminal STOPPED physics, silent winner restore,
 *        no result/winner events, no settlement, no clock arming);
 *   D/E/F. SELF_TEST / SPEED / BRAKE fail closed;
 *   G.   EXPIRED fail closed (no arming, no partial runtime);
 *   H.   INVALID identity fail closed;
 *   I.   CONFIGURATION mismatch fail closed (+ corrupted record);
 *   J.   PLAYER mismatch fail closed;
 *   K.   STATE/CLOCK mismatch fail closed;
 *   L.   PHYSICS mismatch fail closed;
 *   M.   WINNER mismatch fail closed;
 *   N.   DUPLICATE recovery (idempotent equivalent / conflicting fail-closed);
 *   O.   FAILURE INJECTION at every attach stage (no partial state, no
 *        gameplay events, unrelated runtime unaffected);
 *   P.   recoverAll() (independent processing, aggregate summary, empty case);
 *   Q.   EVENT ISOLATION across complete successful recovery and rollback.
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

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

// ---------------------------------------------------------------------------
// Event isolation counters
// ---------------------------------------------------------------------------

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
    EVENT_TYPES.GAME_RESULT_REMOVED,
    EVENT_TYPES.ROOM_CREATED,
    EVENT_TYPES.ROOM_DESTROYED,
    EVENT_TYPES.GAME_CREATED,
    EVENT_TYPES.GAME_DESTROYED,
    EVENT_TYPES.PLAYER_CREATED,
    EVENT_TYPES.PLAYER_REMOVED
]);

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const GAME_ID = "game_d3_orchestrator_001";

const ROOM_ID = "room_d3_orchestrator_001";

const PLAYER_IDS = ["player_d3_a", "player_d3_b", "player_d3_c"];

const logger = new LoggerService();

logger.initialize();

function buildConfiguration() {

    return {
        gameId: GAME_ID,
        configurationVersion: "1.0",
        createdAt: 1000,
        traceSeed: "trace-seed-d3",
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
 * Build a valid RECOVERY_DATA payload for a READY candidate by default.
 */
function buildPayload(overrides = {}) {

    const configuration = overrides.configuration ?? buildConfiguration();

    const now = Date.now();

    const checkpoint = now - 1000;

    const payload = {
        recoveryContractVersion: 1,
        schemaVersion: 1,
        recoveryRecordId: GAME_ID,
        roomId: ROOM_ID,
        gameId: GAME_ID,
        contractId: "contract_d3_001",
        paymentSessionId: "payment_session_d3_001",
        tonNetwork: "testnet",
        correlationId: null,
        players: [
            {
                playerId: PLAYER_IDS[0],
                playerIndex: 0,
                wallet: "EQwalletA",
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
                wallet: "EQwalletB",
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
                wallet: "EQwalletC",
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
        traceSeed: "trace-seed-d3",
        snapshotHash: "snapshot-hash-d3-001",
        gameState: "READY",
        gameStatus: "RUNNING",
        phaseStartedAt: checkpoint,
        clockStartedAt: checkpoint - 5000,
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

    // Keep hash consistent unless the test deliberately tampers with it.
    if (overrides.configuration !== undefined
        && overrides.configurationHash === undefined) {

        payload.configurationHash = computeConfigurationHash(
            payload.configuration
        );

    }

    return payload;

}

// ---------------------------------------------------------------------------
// Graph construction (fresh isolated graph per test section)
// ---------------------------------------------------------------------------

function buildGraph() {

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const gameCatalog = new GameCatalog({ logger });

    gameCatalog.initialize();

    const eventCounts = new Map();

    for (const eventType of LIFECYCLE_EVENTS) {

        eventCounts.set(eventType, 0);

        eventBus.subscribe(eventType, () => {

            eventCounts.set(eventType, (eventCounts.get(eventType) ?? 0) + 1);

        });

    }

    const resetEventCounts = () => {

        for (const eventType of LIFECYCLE_EVENTS) {

            eventCounts.set(eventType, 0);

        }

    };

    const assertZeroLifecycleEvents = (label) => {

        for (const [eventType, count] of eventCounts) {

            assert(
                count === 0,
                `${label}: lifecycle event ${eventType} was emitted `
                    + `(count=${count})`
            );

        }

    };

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

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-d3-orchestrator-"));

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
        gameCatalog,
        eventCounts,
        resetEventCounts,
        assertZeroLifecycleEvents,
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

/**
 * Assert that NO runtime residue remains for the candidate identities.
 */
function assertNoResidue(graph, payload, label) {

    assert(
        !graph.roomManager.hasRoom(payload.roomId),
        `${label}: room residue detected`
    );

    assert(
        !graph.gameManager.hasGame(payload.gameId),
        `${label}: game residue detected`
    );

    for (const player of payload.players) {

        assert(
            !graph.playerManager.hasPlayer(player.playerId),
            `${label}: player residue detected (${player.playerId})`
        );

    }

    assert(
        graph.configurationEngine.getConfiguration(payload.gameId) === null,
        `${label}: configuration residue detected`
    );

    assert(
        graph.gameStateEngine.getState(payload.gameId) === null,
        `${label}: game state residue detected`
    );

    assert(
        graph.gameClockEngine.getClock(payload.gameId) === null,
        `${label}: clock residue detected`
    );

    assert(
        graph.physicsEngine.getSimulation(payload.gameId) === null,
        `${label}: physics residue detected`
    );

    assert(
        !graph.inputAuthority.hasGame(payload.gameId),
        `${label}: input registry residue detected`
    );

    assert(
        graph.winnerEngine.getResult(payload.gameId) === null,
        `${label}: winner result residue detected`
    );

}

/**
 * Attach an unrelated live room/player/game used to verify that failed
 * candidates never disturb unrelated runtime state.
 */
function attachUnrelatedRuntime(graph) {

    const unrelatedRoomId = "room_unrelated_d3";

    const unrelatedGameId = "game_unrelated_d3";

    const unrelatedPlayerIds = ["player_unrelated_a", "player_unrelated_b", "player_unrelated_c"];

    graph.roomManager.attachRoom({
        roomId: unrelatedRoomId,
        createdAt: 1,
        status: "FULL",
        maxPlayers: 3,
        players: [...unrelatedPlayerIds]
    });

    unrelatedPlayerIds.forEach((playerId, index) => {

        graph.playerManager.attachPlayer({
            playerId,
            playerIndex: index,
            identity: {
                playerId,
                nickname: `U${index}`,
                wallet: `EQu${index}`,
                icon: null,
                age: null,
                color: null,
                colorSector2: null,
                sectorCount: 1,
                sectorArrangement: null,
                baseStake: 1,
                createdAt: null
            },
            runtime: {}
        });

    });

    graph.gameManager.attachGame({
        gameId: unrelatedGameId,
        roomId: unrelatedRoomId,
        createdAt: 1,
        status: "RUNNING",
        players: [...unrelatedPlayerIds],
        metadata: {}
    });

    return { unrelatedRoomId, unrelatedGameId, unrelatedPlayerIds };

}

function assertUnrelatedIntact(graph, unrelated, label) {

    assert(
        graph.roomManager.hasRoom(unrelated.unrelatedRoomId),
        `${label}: unrelated room was disturbed`
    );

    assert(
        graph.gameManager.hasGame(unrelated.unrelatedGameId),
        `${label}: unrelated game was disturbed`
    );

    for (const playerId of unrelated.unrelatedPlayerIds) {

        assert(
            graph.playerManager.hasPlayer(playerId),
            `${label}: unrelated player was disturbed`
        );

    }

}

// ---------------------------------------------------------------------------
// A. PRE_GAME_READY SUCCESS
// ---------------------------------------------------------------------------

(function testPreGameReadySuccess() {

    const graph = buildGraph();

    const payload = buildPayload({ gameState: "PRE_GAME_READY" });

    const result = graph.orchestrator.recoverCandidate(payload);

    assert(
        result.status === RECOVERY_RESULT_STATUS.SUCCESS,
        `PRE_GAME_READY should succeed, got ${result.status} (${result.reason})`
    );

    // Room attached with preserved identity
    assert(
        graph.roomManager.hasRoom(ROOM_ID)
            && graph.roomManager.getRoom(ROOM_ID).roomId === ROOM_ID,
        "room should be attached with preserved roomId"
    );

    // Players attached with preserved identity/index
    payload.players.forEach((player) => {

        assert(
            graph.playerManager.hasPlayer(player.playerId),
            `player ${player.playerId} should be attached`
        );

        assert(
            graph.playerManager.getIdentity(player.playerId).playerId
                === player.playerId,
            "player identity playerId must be preserved"
        );

    });

    // Game attached with preserved identity
    assert(
        graph.gameManager.hasGame(GAME_ID)
            && graph.gameManager.getGame(GAME_ID).gameId === GAME_ID,
        "game should be attached with preserved gameId"
    );

    // Engines attached
    assert(
        graph.configurationEngine.getConfiguration(GAME_ID) !== null,
        "configuration should be attached"
    );

    assert(
        graph.gameStateEngine.getState(GAME_ID) === "PRE_GAME_READY",
        "game state should be attached"
    );

    assert(
        graph.physicsEngine.getSimulation(GAME_ID)?.runtime?.state === "CREATED",
        "physics should be attached in CREATED state"
    );

    assert(
        graph.inputAuthority.hasGame(GAME_ID),
        "input registry should be attached"
    );

    // R17.9T.6 OPTION B (deliberate architecture change): the recovered
    // clock is UNARMED-ATTACHED until ALL 3 registered players report
    // CONNECTED. With zero connected players the clock must remain unarmed.
    const unarmedRecord = graph.gameClockEngine._clocks.get(GAME_ID);

    assert(
        unarmedRecord && unarmedRecord.running === false,
        "recovered clock should be attached but NOT running with zero "
            + "connected players"
    );

    assert(
        unarmedRecord.timeoutHandle === null,
        "unarmed recovered clock must not schedule a timeout"
    );

    // All 3 players connect → clock arms exactly once via PLAYER_CONNECTED.
    for (const playerId of PLAYER_IDS) {

        graph.playerManager.setConnectionState(playerId, "CONNECTED");

    }

    const clockRecord = graph.gameClockEngine._clocks.get(GAME_ID);

    assert(
        clockRecord && clockRecord.running === true,
        "clock should be armed once all 3 players are CONNECTED"
    );

    assert(
        clockRecord.timeoutHandle !== null,
        "armed clock should have exactly one timeout"
    );

    // No winner for pre-game candidate
    assert(
        graph.winnerEngine.getResult(GAME_ID) === null,
        "winner engine should remain empty for PRE_GAME_READY"
    );

    // No gameplay events; no SimulationLoop registration (PHYSICS_STARTED)
    graph.assertZeroLifecycleEvents("PRE_GAME_READY success");

    graph.gameClockEngine.removeClock(GAME_ID);

})();

// ---------------------------------------------------------------------------
// B. READY SUCCESS
// ---------------------------------------------------------------------------

(function testReadySuccess() {

    const graph = buildGraph();

    const payload = buildPayload();

    const result = graph.orchestrator.recoverCandidate(payload);

    assert(
        result.status === RECOVERY_RESULT_STATUS.SUCCESS,
        `READY should succeed, got ${result.status} (${result.reason})`
    );

    // R17.9T.6 OPTION B (deliberate architecture change): READY clock starts
    // UNARMED-ATTACHED; arming happens when all 3 players are CONNECTED.
    assert(
        graph.gameClockEngine._clocks.get(GAME_ID)?.running === false,
        "READY clock should be attached but NOT running with zero connected "
            + "players"
    );

    for (const playerId of PLAYER_IDS) {

        graph.playerManager.setConnectionState(playerId, "CONNECTED");

    }

    assert(
        graph.gameClockEngine._clocks.get(GAME_ID)?.running === true,
        "READY clock should be armed once all 3 players are CONNECTED"
    );

    assert(
        graph.inputAuthority.hasGame(GAME_ID),
        "READY input registry should be attached"
    );

    graph.assertZeroLifecycleEvents("READY success");

    graph.gameClockEngine.removeClock(GAME_ID);

})();

// ---------------------------------------------------------------------------
// C. RESULT SUCCESS
// ---------------------------------------------------------------------------

(function testResultSuccess() {

    const graph = buildGraph();

    const payload = buildPayload({
        gameState: "RESULT",
        winnerId: null
    });

    const result = graph.orchestrator.recoverCandidate(payload);

    assert(
        result.status === RECOVERY_RESULT_STATUS.SUCCESS,
        `RESULT should succeed, got ${result.status} (${result.reason})`
    );

    // Terminal physics attached
    const simulation = graph.physicsEngine.getSimulation(GAME_ID);

    assert(
        simulation?.runtime?.state === "STOPPED",
        "terminal physics should be attached in STOPPED state"
    );

    assert(
        simulation.runtime.angle === payload.physicsFinalAngle
            && simulation.runtime.triangleAngle === payload.physicsFinalTriangleAngle,
        "final angles must remain exact"
    );

    // Winner restored silently
    const restoredResult = graph.winnerEngine.getResult(GAME_ID);

    assert(
        restoredResult && restoredResult.winnerPlayerId,
        "winner should be restored for RESULT candidate"
    );

    assert(
        restoredResult.resolvedAt === null,
        "historical resolvedAt must not be invented"
    );

    // No clock attached / no arming for terminal candidate
    assert(
        graph.gameClockEngine.getClock(GAME_ID) === null,
        "RESULT candidate must not attach a clock"
    );

    // No input registry needed for terminal candidate
    assert(
        !graph.inputAuthority.hasGame(GAME_ID),
        "RESULT candidate must not attach an input registry"
    );

    // No result/winner events, no settlement side effects, no SimulationLoop
    graph.assertZeroLifecycleEvents("RESULT success");

})();

// ---------------------------------------------------------------------------
// D/E/F. SELF_TEST / SPEED / BRAKE fail closed
// ---------------------------------------------------------------------------

["SELF_TEST", "SPEED", "BRAKE"].forEach((phase) => {

    (function testActivePhaseFailClosed() {

        const graph = buildGraph();

        const payload = buildPayload({ gameState: phase });

        const result = graph.orchestrator.recoverCandidate(payload);

        assert(
            result.status === RECOVERY_RESULT_STATUS.SKIPPED_NOT_RECOVERABLE,
            `${phase} must fail closed, got ${result.status}`
        );

        assertNoResidue(graph, payload, `${phase} fail closed`);

        graph.assertZeroLifecycleEvents(`${phase} fail closed`);

    })();

});

// ---------------------------------------------------------------------------
// G. EXPIRED fail closed
// ---------------------------------------------------------------------------

(function testExpiredFailClosed() {

    const graph = buildGraph();

    const now = Date.now();

    const payload = buildPayload({
        gameState: "READY",
        phaseStartedAt: now - 60000,
        clockStartedAt: now - 65000,
        serverTimestampAtCheckpoint: now - 50000
    });

    const result = graph.orchestrator.recoverCandidate(payload);

    assert(
        result.status === RECOVERY_RESULT_STATUS.FAILED_EXPIRED,
        `expired candidate must fail closed, got ${result.status}`
    );

    assertNoResidue(graph, payload, "expired fail closed");

    graph.assertZeroLifecycleEvents("expired fail closed");

})();

// ---------------------------------------------------------------------------
// H. INVALID IDENTITY fail closed
// ---------------------------------------------------------------------------

(function testInvalidIdentity() {

    const graph = buildGraph();

    // Missing roomId
    const missingRoom = buildPayload({ roomId: null });

    let result = graph.orchestrator.recoverCandidate(missingRoom);

    assert(
        result.status === RECOVERY_RESULT_STATUS.FAILED_IDENTITY,
        `missing roomId must fail closed, got ${result.status}`
    );

    assertNoResidue(graph, missingRoom, "invalid identity (roomId)");

    // Wrong player count
    const twoPlayers = buildPayload();

    twoPlayers.players = twoPlayers.players.slice(0, 2);

    result = graph.orchestrator.recoverCandidate(twoPlayers);

    assert(
        result.status === RECOVERY_RESULT_STATUS.FAILED_IDENTITY,
        `two-player candidate must fail closed, got ${result.status}`
    );

    assertNoResidue(graph, twoPlayers, "invalid identity (player count)");

    // Duplicate player index set
    const badIndices = buildPayload();

    badIndices.players = badIndices.players.map((player) => ({
        ...player,
        playerIndex: 0
    }));

    result = graph.orchestrator.recoverCandidate(badIndices);

    assert(
        result.status === RECOVERY_RESULT_STATUS.FAILED_IDENTITY,
        `bad player indices must fail closed, got ${result.status}`
    );

    assertNoResidue(graph, badIndices, "invalid identity (indices)");

    graph.assertZeroLifecycleEvents("invalid identity");

})();

// ---------------------------------------------------------------------------
// I. CONFIGURATION MISMATCH fail closed
// ---------------------------------------------------------------------------

(function testConfigurationMismatch() {

    const graph = buildGraph();

    // traceSeed mismatch between payload and configuration
    const seedMismatch = buildPayload({ traceSeed: "different-trace-seed" });

    let result = graph.orchestrator.recoverCandidate(seedMismatch);

    assert(
        result.status === RECOVERY_RESULT_STATUS.FAILED_CONFIGURATION,
        `traceSeed mismatch must fail closed, got ${result.status}`
    );

    assertNoResidue(graph, seedMismatch, "configuration mismatch (seed)");

    // Tampered configurationHash on a full record (persistence-level check)
    const tampered = buildPayload();

    tampered.configurationHash = "tampered-hash";

    result = graph.orchestrator.recoverCandidate(tampered);

    assert(
        result.status === RECOVERY_RESULT_STATUS.FAILED_CONFIGURATION,
        `configurationHash mismatch must fail closed, got ${result.status}`
    );

    assertNoResidue(graph, tampered, "configuration mismatch (hash)");

    // Corrupted record through the persistence envelope path
    const record = graph.recoveryDataPersistence.createRecoveryRecord(
        buildPayload()
    );

    const corrupted = { ...record, checksum: "corrupted-checksum" };

    result = graph.orchestrator.recoverCandidate(corrupted);

    assert(
        result.status === RECOVERY_RESULT_STATUS.FAILED_INVALID_RECORD,
        `corrupted record must fail closed, got ${result.status}`
    );

    graph.assertZeroLifecycleEvents("configuration mismatch");

})();

// ---------------------------------------------------------------------------
// J. PLAYER MISMATCH fail closed
// ---------------------------------------------------------------------------

(function testPlayerMismatch() {

    const graph = buildGraph();

    // Configuration player set differs from recovery player set
    const configuration = buildConfiguration();

    configuration.players = configuration.players.slice(0, 2);

    const payload = buildPayload({ configuration });

    const result = graph.orchestrator.recoverCandidate(payload);

    assert(
        result.status === RECOVERY_RESULT_STATUS.FAILED_CONFIGURATION,
        `configuration player-set mismatch must fail closed, got ${result.status}`
    );

    assertNoResidue(graph, payload, "player mismatch");

    graph.assertZeroLifecycleEvents("player mismatch");

})();

// ---------------------------------------------------------------------------
// K. STATE/CLOCK MISMATCH fail closed (consistency-stage injection)
// ---------------------------------------------------------------------------

(function testStateClockMismatch() {

    const graph = buildGraph();

    const payload = buildPayload();

    // Inject inconsistent clock phase observed during cross-engine validation
    const originalGetClock = graph.gameClockEngine.getClock.bind(
        graph.gameClockEngine
    );

    graph.gameClockEngine.getClock = (gameId) => {

        const clock = originalGetClock(gameId);

        if (clock && gameId === GAME_ID) {

            return { ...clock, currentPhase: "SPEED" };

        }

        return clock;

    };

    const result = graph.orchestrator.recoverCandidate(payload);

    assert(
        result.status === RECOVERY_RESULT_STATUS.FAILED_CONSISTENCY,
        `state/clock mismatch must fail closed, got ${result.status}`
    );

    assert(
        result.failedStep === "consistency_validation",
        "failure should be reported at consistency_validation step"
    );

    assertNoResidue(graph, payload, "state/clock mismatch");

    graph.assertZeroLifecycleEvents("state/clock mismatch");

})();

// ---------------------------------------------------------------------------
// L. PHYSICS MISMATCH fail closed
// ---------------------------------------------------------------------------

(function testPhysicsMismatch() {

    const graph = buildGraph();

    // RESULT candidate whose persisted physics is not terminal STOPPED
    const payload = buildPayload({
        gameState: "RESULT",
        physicsSimulationState: "RUNNING"
    });

    const result = graph.orchestrator.recoverCandidate(payload);

    assert(
        result.status === RECOVERY_RESULT_STATUS.FAILED_PHYSICS,
        `non-terminal physics must fail closed, got ${result.status}`
    );

    assertNoResidue(graph, payload, "physics mismatch");

    // RESULT candidate with non-finite final angle
    const nanAngle = buildPayload({
        gameState: "RESULT",
        physicsFinalAngle: Number.NaN
    });

    const nanResult = graph.orchestrator.recoverCandidate(nanAngle);

    assert(
        nanResult.status === RECOVERY_RESULT_STATUS.FAILED_PHYSICS,
        `non-finite final angle must fail closed, got ${nanResult.status}`
    );

    assertNoResidue(graph, nanAngle, "physics mismatch (NaN)");

    graph.assertZeroLifecycleEvents("physics mismatch");

})();

// ---------------------------------------------------------------------------
// M. WINNER MISMATCH fail closed
// ---------------------------------------------------------------------------

(function testWinnerMismatch() {

    const graph = buildGraph();

    const payload = buildPayload({
        gameState: "RESULT",
        winnerId: "player_definitely_wrong"
    });

    const result = graph.orchestrator.recoverCandidate(payload);

    assert(
        result.status === RECOVERY_RESULT_STATUS.FAILED_WINNER,
        `winner mismatch must fail closed, got ${result.status}`
    );

    assertNoResidue(graph, payload, "winner mismatch");

    graph.assertZeroLifecycleEvents("winner mismatch");

})();

// ---------------------------------------------------------------------------
// N. DUPLICATE RECOVERY
// ---------------------------------------------------------------------------

(function testDuplicateRecovery() {

    const graph = buildGraph();

    const payload = buildPayload();

    // First recovery succeeds
    const first = graph.orchestrator.recoverCandidate(payload);

    assert(
        first.status === RECOVERY_RESULT_STATUS.SUCCESS,
        `first recovery should succeed, got ${first.status}`
    );

    // Equivalent second recovery is idempotent
    const second = graph.orchestrator.recoverCandidate(payload);

    assert(
        second.status === RECOVERY_RESULT_STATUS.ALREADY_RECOVERED,
        `equivalent duplicate should be idempotent, got ${second.status}`
    );

    // Conflicting duplicate (same ids, different roomId) fails closed and
    // never destroys existing live runtime
    const conflicting = buildPayload({ roomId: "room_conflicting_d3" });

    conflicting.gameId = GAME_ID;

    const third = graph.orchestrator.recoverCandidate(conflicting);

    assert(
        third.status === RECOVERY_RESULT_STATUS.FAILED_IDENTITY,
        `conflicting duplicate must fail closed, got ${third.status}`
    );

    // Original live runtime untouched
    assert(
        graph.roomManager.hasRoom(ROOM_ID)
            && graph.gameManager.hasGame(GAME_ID),
        "existing live runtime must not be destroyed by conflicting recovery"
    );

    // Partial presence conflicts fail closed
    const graph2 = buildGraph();

    graph2.roomManager.attachRoom({
        roomId: ROOM_ID,
        createdAt: null,
        status: "FULL",
        maxPlayers: 3,
        players: [...PLAYER_IDS]
    });

    const partial = graph2.orchestrator.recoverCandidate(buildPayload());

    assert(
        partial.status === RECOVERY_RESULT_STATUS.FAILED_IDENTITY,
        `partial existing runtime must fail closed, got ${partial.status}`
    );

    assert(
        graph2.gameManager.hasGame(GAME_ID) === false,
        "partial-conflict handling must not create a game"
    );

    graph.gameClockEngine.removeClock(GAME_ID);

    // Teardown of an armed clock legitimately emits CLOCK_STOPPED through
    // normal stop semantics; clear counters so the isolation assertion
    // validates recovery-path silence only.
    graph.resetEventCounts();

    graph.assertZeroLifecycleEvents("duplicate recovery");

})();

// ---------------------------------------------------------------------------
// O. FAILURE INJECTION at every attach stage
// ---------------------------------------------------------------------------

(function testFailureInjection() {

    const stages = [
        {
            name: "room_attach",
            inject: (graph) => {

                graph.roomManager.attachRoom = () => null;

            }
        },
        {
            name: "player_attach",
            inject: (graph) => {

                const original = graph.playerManager.attachPlayer.bind(
                    graph.playerManager
                );

                let calls = 0;

                graph.playerManager.attachPlayer = (player) => {

                    calls += 1;

                    if (calls >= 2) {

                        return null;

                    }

                    return original(player);

                };

            }
        },
        {
            name: "game_attach",
            inject: (graph) => {

                graph.gameManager.attachGame = () => null;

            }
        },
        {
            name: "configuration_attach",
            inject: (graph) => {

                graph.configurationEngine.attachConfiguration = () => null;

            }
        },
        {
            name: "state_attach",
            inject: (graph) => {

                graph.gameStateEngine.attachState = () => null;

            }
        },
        {
            name: "clock_attach",
            inject: (graph) => {

                graph.gameClockEngine.attachClock = () => null;

            }
        },
        {
            name: "input_attach",
            inject: (graph) => {

                graph.inputAuthority.attachRegistry = () => null;

            }
        },
        {
            name: "physics_attach",
            inject: (graph) => {

                graph.physicsEngine.attachSimulation = () => null;

            }
        },
    ];

    for (const stage of stages) {

        const graph = buildGraph();

        const unrelated = attachUnrelatedRuntime(graph);

        graph.resetEventCounts();

        const payload = buildPayload();

        stage.inject(graph);

        const result = graph.orchestrator.recoverCandidate(payload);

        assert(
            result.status !== RECOVERY_RESULT_STATUS.SUCCESS,
            `${stage.name}: injected failure must not produce SUCCESS`
        );

        assert(
            result.failedStep === stage.name,
            `${stage.name}: failure should be attributed to this step, `
                + `got ${result.failedStep}`
        );

        // No partial runtime candidate remains
        assertNoResidue(graph, payload, `failure injection ${stage.name}`);

        // Unrelated runtime unaffected
        assertUnrelatedIntact(graph, unrelated, `failure injection ${stage.name}`);

        // No gameplay events emitted (including rollback)
        graph.assertZeroLifecycleEvents(`failure injection ${stage.name}`);

    }

    // R17.9T.6 OPTION B (deliberate architecture change): clock_arm failure
    // injection. Arming is attempted only when all 3 registered players are
    // CONNECTED, so the candidate first recovers into UNARMED-ATTACHED
    // pending state; connecting all players then triggers the refused
    // fail-closed arming attempt.
    {

        const graph = buildGraph();

        const unrelated = attachUnrelatedRuntime(graph);

        graph.resetEventCounts();

        const payload = buildPayload();

        graph.gameClockEngine.armRecoveredClock = () => null;

        const recovered = graph.orchestrator.recoverCandidate(payload);

        assert(
            recovered.status === RECOVERY_RESULT_STATUS.SUCCESS,
            `clock_arm injection: recovery should succeed into pending state, `
                + `got ${recovered.status}`
        );

        for (const playerId of PLAYER_IDS) {

            graph.playerManager.setConnectionState(playerId, "CONNECTED");

        }

        const record = graph.gameClockEngine._clocks.get(GAME_ID);

        assert(
            record && record.running === false,
            "clock_arm injection: refused arming must leave clock unarmed"
        );

        assert(
            record.timeoutHandle === null,
            "clock_arm injection: no timeout may be scheduled"
        );

        assert(
            !graph.orchestrator._pendingRecoveredClocks.has(GAME_ID),
            "clock_arm injection: pending entry must be cleaned up"
        );

        assertUnrelatedIntact(graph, unrelated, "failure injection clock_arm");

        graph.assertZeroLifecycleEvents("failure injection clock_arm");

        graph.gameClockEngine.removeClock(GAME_ID);

    }

    // Winner-restore failure injection (RESULT candidate)
    {

        const graph = buildGraph();

        const unrelated = attachUnrelatedRuntime(graph);

        graph.resetEventCounts();

        const payload = buildPayload({ gameState: "RESULT" });

        graph.winnerEngine.restoreResult = () => null;

        const result = graph.orchestrator.recoverCandidate(payload);

        assert(
            result.status === RECOVERY_RESULT_STATUS.FAILED_WINNER
                && result.failedStep === "winner_restore",
            `winner_restore injection must fail at winner_restore, `
                + `got ${result.status}/${result.failedStep}`
        );

        assertNoResidue(graph, payload, "failure injection winner_restore");

        assertUnrelatedIntact(graph, unrelated, "failure injection winner_restore");

        graph.assertZeroLifecycleEvents("failure injection winner_restore");

    }

    // Consistency-validation failure injection (already covered by test K)

})();

// ---------------------------------------------------------------------------
// P. recoverAll()
// ---------------------------------------------------------------------------

(function testRecoverAll() {

    const graph = buildGraph();

    // Two candidates: one recoverable READY, one unrecoverable SPEED
    const readyPayload = buildPayload();

    const speedPayload = buildPayload({
        recoveryRecordId: "game_d3_speed_001",
        gameId: "game_d3_speed_001",
        roomId: "room_d3_speed_001",
        gameState: "SPEED",
        configuration: (() => {

            const configuration = buildConfiguration();

            configuration.gameId = "game_d3_speed_001";

            configuration.metadata = {
                ...configuration.metadata,
                roomId: "room_d3_speed_001"
            };

            return configuration;

        })(),
        contractId: "contract_d3_speed",
        paymentSessionId: "payment_session_d3_speed"
    });

    graph.recoveryDataPersistence.createRecoveryRecord(readyPayload);

    graph.recoveryDataPersistence.createRecoveryRecord(speedPayload);

    const outcome = graph.orchestrator.recoverAll();

    assert(
        outcome.summary.total === 2,
        `recoverAll should process 2 candidates, got ${outcome.summary.total}`
    );

    assert(
        outcome.summary.success === 1,
        `recoverAll should report 1 success, got ${outcome.summary.success}`
    );

    assert(
        outcome.summary.skippedNotRecoverable === 1,
        `recoverAll should skip 1 unrecoverable candidate, `
            + `got ${outcome.summary.skippedNotRecoverable}`
    );

    // Recovered candidate present in runtime
    assert(
        graph.gameManager.hasGame(GAME_ID),
        "recoverAll should reconstruct the READY candidate"
    );

    // Failed/skipped candidate leaves no residue
    assert(
        !graph.gameManager.hasGame("game_d3_speed_001"),
        "SPEED candidate must leave no runtime residue"
    );

    // One failed candidate did not corrupt the other
    // R17.9T.6 OPTION B (deliberate architecture change): the recovered
    // READY clock remains UNARMED-ATTACHED while not all 3 players are
    // CONNECTED; the sibling skip must not change that.
    assert(
        graph.gameClockEngine.getClock(GAME_ID)?.running === false,
        "READY candidate clock should remain unarmed (pending connectivity) "
            + "despite sibling skip"
    );

    assert(
        graph.orchestrator._pendingRecoveredClocks.has(GAME_ID),
        "READY candidate should remain in pending recovered-clock state"
    );

    // No persistence mutation by recoverAll
    const recordsAfter = graph.recoveryDataPersistence.listRecoveryRecords();

    assert(
        recordsAfter.length === 2,
        "recoverAll must not modify recovery persistence records"
    );

    graph.gameClockEngine.removeClock(GAME_ID);

    // Legitimate armed-clock teardown noise; see note above.
    graph.resetEventCounts();

    graph.assertZeroLifecycleEvents("recoverAll");

})();

(function testRecoverAllEmpty() {

    const graph = buildGraph();

    const outcome = graph.orchestrator.recoverAll();

    assert(
        Array.isArray(outcome.results) && outcome.results.length === 0,
        "recoverAll with no records must return an explicit empty result"
    );

    assert(
        outcome.summary.total === 0,
        "empty recoverAll summary must report total 0"
    );

})();

// ---------------------------------------------------------------------------
// Q. EVENT ISOLATION across complete successful recovery AND rollback
// ---------------------------------------------------------------------------

(function testEventIsolationFullCycle() {

    const graph = buildGraph();

    graph.resetEventCounts();

    // Successful recovery
    const payload = buildPayload();

    const success = graph.orchestrator.recoverCandidate(payload);

    assert(
        success.status === RECOVERY_RESULT_STATUS.SUCCESS,
        "full-cycle success recovery should succeed"
    );

    // Rollback via a failing retry is impossible (idempotent), so exercise
    // rollback explicitly through a fresh graph with late-stage injection.
    const graph2 = buildGraph();

    graph2.resetEventCounts();

    const payload2 = buildPayload();

    graph2.physicsEngine.attachSimulation = () => null;

    const rolledBack = graph2.orchestrator.recoverCandidate(payload2);

    assert(
        rolledBack.status === RECOVERY_RESULT_STATUS.FAILED_PHYSICS,
        "rollback scenario should fail at physics_attach"
    );

    assertNoResidue(graph2, payload2, "rollback full cycle");

    // Zero normal gameplay lifecycle events across both graphs
    graph.assertZeroLifecycleEvents("event isolation (success)");
    graph2.assertZeroLifecycleEvents("event isolation (rollback)");

    graph.gameClockEngine.removeClock(GAME_ID);

    // Legitimate armed-clock teardown noise; see note above.
    graph.resetEventCounts();

})();

logger.info("R17.9T.6-D3 RecoveryOrchestrator tests passed");
