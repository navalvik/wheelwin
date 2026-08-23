/**
 * R17.9T.6 — RecoveryCheckpointManager focused tests.
 *
 * Covers:
 *   A.  PRE_GAME_READY CREATE (valid record, exact payload, config hash,
 *       players/playerIndex, clock, CREATED physics, no financial writes);
 *   B.  READY UPDATE (same recordId, gameState advances, no new record);
 *   C.  RESULT UPDATE (STOPPED physics, finite angles, winnerId,
 *       TERMINAL envelope);
 *   D/E/F. SELF_TEST / SPEED / BRAKE produce NO write;
 *   G.  PAUSED CLOCK → no write, warning, gameplay unaffected;
 *   H.  INVALID CONFIGURATION → no write;
 *   I.  INVALID PLAYERS → no write;
 *   J.  INVALID PLAYER INDEX (duplicate id in room order) → no write;
 *   K.  INVALID PHYSICS (not CREATED at pre-motion checkpoint) → no write;
 *   L.  RESULT WITHOUT STOPPED PHYSICS → no write;
 *   M.  DUPLICATE PRE_GAME_READY → idempotent, single record;
 *   N.  DUPLICATE READY → idempotent, single record;
 *   O.  OUT-OF-ORDER PRE_GAME_READY AFTER READY → ignored, stays READY;
 *   P.  OUT-OF-ORDER READY AFTER RESULT → ignored, stays RESULT;
 *   Q.  REPEATED RESULT → idempotent terminal no-op;
 *   R.  CONFLICTING EXISTING RECORD → no overwrite;
 *   S.  PERSISTENCE FAILURE → caught, logged, handler does not throw;
 *   T.  ZERO GAMEPLAY EVENTS emitted by the writer;
 *   U.  ZERO FINANCIAL WRITES (only RECOVERY_DATA touched);
 *   V.  RECOVERY ORCHESTRATOR COMPATIBILITY for PRE_GAME_READY / READY /
 *       RESULT records produced through the writer.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { Room } from "../models/Room.js";
import { ROOM_STATUS } from "../models/RoomStatus.js";
import { Game } from "../models/Game.js";
import { PlayerIdentity } from "../models/PlayerIdentity.js";
import { PlayerRuntime } from "../models/PlayerRuntime.js";
import {
    TonFinancialPersistence,
    TON_FINANCIAL_RECORD_TYPES
} from "../persistence/TonFinancialPersistence.js";
import {
    RecoveryDataPersistence,
    RECOVERY_CONTRACT_VERSION
} from "../persistence/RecoveryDataPersistence.js";
import { computePayloadChecksum } from "../persistence/tonFinancialRecordUtils.js";
import { RecoveryCheckpointManager } from "../recovery/RecoveryCheckpointManager.js";
import {
    RecoveryOrchestrator,
    RECOVERY_RESULT_STATUS
} from "../recovery/RecoveryOrchestrator.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

// ---------------------------------------------------------------------------
// Fixture constants
// ---------------------------------------------------------------------------

const logger = new LoggerService();

logger.initialize();

const CONTRACT_ID = "contract_r179t6_writer_001";

const PAYMENT_SESSION_ID = "pay_r179t6_writer_001";

const SNAPSHOT_HASH = "snapshot-hash-writer-001";

// ---------------------------------------------------------------------------
// Graph construction (fresh isolated graph per section)
// ---------------------------------------------------------------------------

function buildGraph(prefix) {

    const gameId = `game_${prefix}`;

    const roomId = `room_${prefix}`;

    const playerIds = [
        `player_${prefix}_a`,
        `player_${prefix}_b`,
        `player_${prefix}_c`
    ];

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const gameCatalog = new GameCatalog({ logger });

    gameCatalog.initialize();

    // Gameplay-event emission counter (used for test T).
    const gameplayEventTypes = Object.freeze([
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

    const eventCounts = new Map();

    for (const eventType of gameplayEventTypes) {

        eventCounts.set(eventType, 0);

        eventBus.subscribe(eventType, () => {

            eventCounts.set(
                eventType,
                (eventCounts.get(eventType) ?? 0) + 1
            );

        });

    }

    const resetEventCounts = () => {

        for (const eventType of gameplayEventTypes) {

            eventCounts.set(eventType, 0);

        }

    };

    const assertZeroGameplayEvents = (label) => {

        for (const [eventType, count] of eventCounts) {

            assert(
                count === 0,
                `${label}: gameplay event ${eventType} was emitted `
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

            throw new Error(
                "randomService must never be called by the checkpoint writer"
            );

        },
        nextInt() {

            throw new Error(
                "randomService must never be called by the checkpoint writer"
            );

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

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r179t6-writer-"));

    const financialPersistence = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint: false
    });

    financialPersistence.initialize();

    const recoveryDataPersistence = new RecoveryDataPersistence({
        financialPersistence
    });

    // Financial reference stubs (references ONLY — mirrors how app.js injects
    // the real GameContractManager / PaymentSessionManager).
    const gameContractManager = {
        getContractByGameId(id) {

            if (id !== gameId) {

                return null;

            }

            return {
                contractId: CONTRACT_ID,
                tonNetwork: "testnet",
                snapshotHash: SNAPSHOT_HASH,
                correlationId: "corr-writer-001"
            };

        }
    };

    const paymentSessionManager = {
        getSessionByGameId(id) {

            if (id !== gameId) {

                return null;

            }

            return {
                paymentSessionId: PAYMENT_SESSION_ID,
                participants: playerIds.map((playerId, index) => ({
                    playerId,
                    wallet: `EQwallet_${prefix}_${index}`
                }))
            };

        }
    };

    const checkpointManager = new RecoveryCheckpointManager({
        logger,
        eventBus,
        recoveryDataPersistence,
        roomManager,
        playerManager,
        gameManager,
        configurationEngine,
        gameStateEngine,
        gameClockEngine,
        physicsEngine,
        winnerEngine,
        inputAuthority,
        gameContractManager,
        paymentSessionManager
    });

    checkpointManager.initialize();

    /**
     * Attach the full authoritative live runtime for one game WITHOUT
     * initializing game state (so the PRE_GAME_READY checkpoint moment can
     * be controlled precisely by the caller).
     */
    function attachLiveRuntime({
        playerIdsOverride = null,
        withConfiguration = true,
        withSimulation = true,
        withInputRegistry = true
    } = {}) {

        const orderedPlayerIds = playerIdsOverride ?? playerIds;

        roomManager.attachRoom(new Room({
            roomId,
            createdAt: Date.now(),
            status: ROOM_STATUS.FULL,
            maxPlayers: 3,
            players: [...orderedPlayerIds]
        }));

        for (let index = 0; index < orderedPlayerIds.length; index += 1) {

            const playerId = orderedPlayerIds[index];

            playerManager.attachPlayer({
                playerId,
                identity: new PlayerIdentity({
                    playerId,
                    nickname: `Player${index}`,
                    wallet: `EQwallet_${prefix}_${index}`,
                    icon: ["dice", "spade", "queen"][index],
                    age: 20 + index,
                    color: ["RED", "GREEN", "BLUE"][index],
                    colorSector2: null,
                    sectorCount: 1,
                    sectorArrangement: "single",
                    baseStake: 10,
                    createdAt: Date.now()
                }),
                runtime: new PlayerRuntime({ lastSeen: Date.now() })
            });

        }

        gameManager.attachGame(new Game({
            gameId,
            roomId,
            createdAt: Date.now(),
            status: "RUNNING",
            players: [...orderedPlayerIds],
            metadata: {}
        }));

        if (withConfiguration) {

            configurationEngine.commitConfiguration(Object.freeze({
                gameId,
                configurationVersion: "1.0",
                createdAt: Date.now(),
                traceSeed: `trace-seed-${prefix}`,
            sectors: orderedPlayerIds.map((ownerId, index) => ({
                sectorId: `sector-${index}`,
                ownerId,
                color: ["#d62828", "#00aa44", "#1c73d0"][index],
                icon: ["dice", "spade", "queen"][index],
                sectorIndexForPlayer: 0,
                angleStart: index * 120,
                angleEnd: (index + 1) * 120
            })),
            players: orderedPlayerIds.map((playerId, index) => ({
                playerId,
                nickname: `Player${index}`,
                color: ["RED", "GREEN", "BLUE"][index],
                colors: [["RED"], ["GREEN"], ["BLUE"]][index],
                icon: ["dice", "spade", "queen"][index],
                sectorCount: 1,
                sectorArrangement: null
            })),
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
                    roomId,
                    catalogVersion: "1.0"
                }
            }));

        }

        gameClockEngine.createClock(gameId);

        gameClockEngine.startClock(gameId);

        if (withSimulation) {

            physicsEngine.createSimulation(gameId);

        }

        if (withInputRegistry) {

            inputAuthority.registerPlayers(gameId, orderedPlayerIds);

        }

        return { gameId, roomId, playerIds: orderedPlayerIds };

    }

    function cleanupRuntime(gameIdToClean) {

        try {

            gameClockEngine.removeClock(gameIdToClean);

        } catch {

            // best-effort cleanup

        }

        try {

            physicsEngine.removeSimulation(gameIdToClean);

        } catch {

            // best-effort cleanup

        }

        try {

            inputAuthority.removeGame(gameIdToClean);

        } catch {

            // best-effort cleanup

        }

        try {

            gameStateEngine.removeState(gameIdToClean);

        } catch {

            // best-effort cleanup

        }

        try {

            configurationEngine.removeConfiguration(gameIdToClean);

        } catch {

            // best-effort cleanup

        }

        try {

            winnerEngine.detachResult(gameIdToClean);

        } catch {

            // best-effort cleanup

        }

    }

    return {
        prefix,
        gameId,
        roomId,
        playerIds,
        eventBus,
        eventCounts,
        resetEventCounts,
        assertZeroGameplayEvents,
        roomManager,
        playerManager,
        gameManager,
        configurationEngine,
        gameStateEngine,
        gameClockEngine,
        physicsEngine,
        winnerEngine,
        inputAuthority,
        financialPersistence,
        recoveryDataPersistence,
        checkpointManager,
        attachLiveRuntime,
        cleanupRuntime
    };

}

/**
 * Drive the authoritative PRE_GAME_READY → READY → … → RESULT chain through
 * the real GameStateEngine so every checkpoint happens exactly as it would
 * in production (post-transition, via existing events).
 */
function advanceThroughPhases(graph, { stopPhysicsAtEnd = false } = {}) {

    const { gameId, gameStateEngine, physicsEngine, winnerEngine, eventBus }
        = graph;

    // PRE_GAME_READY checkpoint fires from initializeGameState automatically.
    gameStateEngine.initializeGameState(gameId);

    // Production ordering: GameClockEngine advances the phase FIRST
    // (completePreGameReadyPhase / phase timeout), THEN GameplayPhaseLifecycle
    // performs the matching GameStateEngine transition.
    graph.gameClockEngine.completePreGameReadyPhase(gameId);

    gameStateEngine.transition(gameId, "READY");

    // Non-checkpointed active phases (writer must ignore these).
    gameStateEngine.transition(gameId, "SELF_TEST");

    gameStateEngine.transition(gameId, "SPEED");

    gameStateEngine.transition(gameId, "BRAKE");

    if (stopPhysicsAtEnd) {

        physicsEngine.startSimulation(gameId);

        physicsEngine.applyAcceleration(gameId, 2);

        physicsEngine.updateSimulation(gameId, 120);

        physicsEngine.stopSimulation(gameId);

        // Winner resolution emits its own early GAME_RESULT_READY (state is
        // still BRAKE here) — the writer must ignore that emission.
        winnerEngine.resolveResult(gameId);

    }

    gameStateEngine.transition(gameId, "RESULT");

    // Authoritative post-transition RESULT trigger (GameplayPhaseLifecycle
    // emits this on RESULT_COMPLETED in production).
    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAME_RESULT_READY,
        payload: { gameId, timestamp: Date.now() }
    });

}

// ---------------------------------------------------------------------------
// A/B/C/T/U — happy path through the real event chain
// ---------------------------------------------------------------------------

{

    const graph = buildGraph("happy");

    const {
        gameId,
        roomId,
        playerIds,
        recoveryDataPersistence,
        financialPersistence,
        checkpointManager,
        configurationEngine,
        physicsEngine,
        winnerEngine,
        gameStateEngine
    } = graph;

    graph.attachLiveRuntime();

    // --- A. PRE_GAME_READY CREATE ----------------------------------------

    // Step 1: authoritative PRE_GAME_READY entry (checkpoint fires from
    // initializeGameState automatically, post-transition).
    gameStateEngine.initializeGameState(gameId);

    let record = recoveryDataPersistence.loadRecoveryRecord(gameId);

    assert(record, "A: PRE_GAME_READY record was not created");

    assert(record.recordId === gameId, "A: recordId must equal gameId");

    assert(
        record.status === "ACTIVE",
        `A: expected ACTIVE status, got ${record.status}`
    );

    let payload = record.payload;

    assert(
        payload.recoveryContractVersion === RECOVERY_CONTRACT_VERSION,
        "A: recoveryContractVersion mismatch"
    );

    assert(payload.roomId === roomId, "A: roomId mismatch");
    assert(payload.gameId === gameId, "A: gameId mismatch");
    assert(payload.contractId === CONTRACT_ID, "A: contractId mismatch");
    assert(
        payload.paymentSessionId === PAYMENT_SESSION_ID,
        "A: paymentSessionId mismatch"
    );
    assert(payload.tonNetwork === "testnet", "A: tonNetwork mismatch");
    assert(payload.correlationId === "corr-writer-001", "A: correlationId mismatch");

    const configuration = configurationEngine.getConfiguration(gameId);

    assert(payload.configuration === configuration || JSON.stringify(payload.configuration) === JSON.stringify(configuration),
        "A: persisted configuration differs from frozen engine configuration");

    assert(
        payload.configurationHash === computePayloadChecksum(configuration),
        "A: configurationHash mismatch"
    );

    assert(payload.configurationVersion === "1.0", "A: configurationVersion mismatch");
    assert(payload.traceSeed === configuration.traceSeed, "A: traceSeed mismatch");
    assert(payload.snapshotHash === SNAPSHOT_HASH, "A: snapshotHash mismatch");

    assert(payload.gameState === "PRE_GAME_READY", "A: gameState mismatch");
    assert(payload.gameStatus === "RUNNING", "A: gameStatus mismatch");
    assert(
        Number.isFinite(payload.serverTimestampAtCheckpoint),
        "A: serverTimestampAtCheckpoint missing"
    );

    assert(Array.isArray(payload.players) && payload.players.length === 3,
        "A: players must contain exactly 3 entries");

    payload.players.forEach((player, index) => {

        assert(player.playerId === playerIds[index], `A: player order ${index}`);
        assert(player.playerIndex === index, `A: playerIndex ${index}`);
        assert(Boolean(player.wallet), `A: wallet missing ${index}`);
        assert("nickname" in player && "baseStake" in player
            && "sectorCount" in player && "color" in player
            && "colorSector2" in player && "icon" in player
            && "sectorArrangement" in player && "age" in player,
            `A: identity field missing on player ${index}`);

    });

    assert(Number.isFinite(payload.phaseStartedAt), "A: phaseStartedAt missing");
    assert(Number.isFinite(payload.clockStartedAt), "A: clockStartedAt missing");
    assert(payload.clockPaused === false, "A: clockPaused must be false");
    assert(payload.clockTotalPausedMs === 0, "A: clockTotalPausedMs must be 0");
    assert(payload.awaitingResultActivation === false, "A: awaitingResultActivation");
    assert(payload.resultPhaseStarted === false, "A: resultPhaseStarted");

    assert(!("physicsFinalAngle" in payload),
        "A: terminal physics must not be present on pre-motion record");
    assert(!("winnerId" in payload),
        "A: winnerId must not be present on pre-motion record");

    for (const forbidden of [
        "paymentStatus", "paidAmount", "confirmationStatus", "refundTxHash",
        "settlementTransactionHash", "prizeAmount", "organizerAmount",
        "totalPot", "requiredGram"
    ]) {

        assert(!(forbidden in payload), `A: forbidden financial field ${forbidden}`);

    }

    // --- B. READY UPDATE ---------------------------------------------------

    // Step 2: production ordering — clock advances first, then state.
    graph.gameClockEngine.completePreGameReadyPhase(gameId);

    gameStateEngine.transition(gameId, "READY");

    record = recoveryDataPersistence.loadRecoveryRecord(gameId);

    assert(record.payload.gameState === "READY", "B: gameState must be READY");
    assert(record.recordId === gameId, "B: same recordId required");
    assert(
        record.updatedAt >= record.createdAt,
        "B: updatedAt must be >= createdAt"
    );

    // --- C. RESULT UPDATE --------------------------------------------------

    // Step 3: non-checkpointed active phases, terminal physics, winner
    // resolution, RESULT transition, and the authoritative GAME_RESULT_READY.
    gameStateEngine.transition(gameId, "SELF_TEST");

    gameStateEngine.transition(gameId, "SPEED");

    gameStateEngine.transition(gameId, "BRAKE");

    physicsEngine.startSimulation(gameId);

    physicsEngine.applyAcceleration(gameId, 2);

    physicsEngine.updateSimulation(gameId, 120);

    physicsEngine.stopSimulation(gameId);

    winnerEngine.resolveResult(gameId);

    gameStateEngine.transition(gameId, "RESULT");

    graph.eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAME_RESULT_READY,
        payload: { gameId, timestamp: Date.now() }
    });

    record = recoveryDataPersistence.loadRecoveryRecord(gameId);

    assert(record, "C: record missing after RESULT checkpoint");

    assert(
        record.status === "TERMINAL",
        `C: expected TERMINAL envelope, got ${record.status}`
    );

    assert(record.immutable === true, "C: terminal record must be immutable");

    payload = record.payload;

    assert(payload.gameState === "RESULT", "C: gameState must be RESULT");

    assert(
        payload.physicsSimulationState === "STOPPED",
        "C: physicsSimulationState must be STOPPED"
    );

    assert(
        Number.isFinite(payload.physicsFinalAngle)
            && Number.isFinite(payload.physicsFinalTriangleAngle),
        "C: final angles must be finite"
    );

    const winnerResult = winnerEngine.getResult(gameId);

    assert(winnerResult, "C: winner result missing from WinnerEngine");

    assert(
        payload.winnerId === winnerResult.winnerPlayerId,
        "C: winnerId must match WinnerEngine result"
    );

    // --- T. ZERO GAMEPLAY EVENTS from the writer ---------------------------

    graph.resetEventCounts();

    const directResult = checkpointManager.checkpoint(gameId, "READY");

    // Stale (RESULT already persisted) — but crucially NO events emitted.
    assert(
        directResult.status === "skipped",
        "T: stale READY re-checkpoint should be skipped"
    );

    graph.assertZeroGameplayEvents("T: writer emitted gameplay events");

    // --- U. ZERO FINANCIAL WRITES ------------------------------------------

    const financialTypes = [
        TON_FINANCIAL_RECORD_TYPES.GAME_CONTRACT,
        TON_FINANCIAL_RECORD_TYPES.PAYMENT_SESSION,
        TON_FINANCIAL_RECORD_TYPES.WALLET_SESSION,
        TON_FINANCIAL_RECORD_TYPES.SETTLEMENT,
        TON_FINANCIAL_RECORD_TYPES.SNAPSHOT,
        TON_FINANCIAL_RECORD_TYPES.RECOVERY_CHECKPOINT,
        TON_FINANCIAL_RECORD_TYPES.AUDIT
    ];

    for (const recordType of financialTypes) {

        const listed = financialPersistence.listActive(recordType);

        assert(
            Array.isArray(listed) && listed.length === 0,
            `U: unexpected financial writes of type ${recordType}`
        );

    }

    const recoveryRecords = financialPersistence.listActive(
        TON_FINANCIAL_RECORD_TYPES.RECOVERY_DATA
    );

    assert(
        recoveryRecords.length === 1,
        `U: expected exactly 1 RECOVERY_DATA record, got ${recoveryRecords.length}`
    );

    graph.cleanupRuntime(gameId);

}

// ---------------------------------------------------------------------------
// D/E/F — SELF_TEST / SPEED / BRAKE produce no write
// ---------------------------------------------------------------------------

{

    const graph = buildGraph("nomotion");

    const { gameId, recoveryDataPersistence, gameStateEngine } = graph;

    graph.attachLiveRuntime();

    gameStateEngine.initializeGameState(gameId); // creates PRE_GAME_READY record

    assert(recoveryDataPersistence.loadRecoveryRecord(gameId),
        "D-precondition: PRE_GAME_READY record expected");

    const before = recoveryDataPersistence.loadRecoveryRecord(gameId);

    gameStateEngine.transition(gameId, "SELF_TEST");

    gameStateEngine.transition(gameId, "SPEED");

    gameStateEngine.transition(gameId, "BRAKE");

    const after = recoveryDataPersistence.loadRecoveryRecord(gameId);

    assert(
        after.payload.gameState === before.payload.gameState,
        "D/E/F: record must remain at PRE_GAME_READY"
    );

    assert(
        after.updatedAt === before.updatedAt,
        "D/E/F: no write may occur during SELF_TEST/SPEED/BRAKE"
    );

    graph.cleanupRuntime(gameId);

}

// ---------------------------------------------------------------------------
// G — paused clock: no write, warning, gameplay unaffected
// ---------------------------------------------------------------------------

{

    const graph = buildGraph("paused");

    const { gameId, recoveryDataPersistence, gameClockEngine, gameStateEngine }
        = graph;

    graph.attachLiveRuntime();

    gameClockEngine.pauseClock(gameId);

    gameStateEngine.initializeGameState(gameId); // checkpoint moment, paused

    assert(
        recoveryDataPersistence.loadRecoveryRecord(gameId) === null,
        "G: paused-clock checkpoint must NOT be written"
    );

    // Gameplay unaffected: state transitioned normally.
    assert(
        gameStateEngine.getState(gameId) === "PRE_GAME_READY",
        "G: gameplay state must be unaffected by skipped checkpoint"
    );

    graph.cleanupRuntime(gameId);

}

// ---------------------------------------------------------------------------
// H — invalid configuration: no write
// ---------------------------------------------------------------------------

{

    const graph = buildGraph("noconfig");

    const { gameId, recoveryDataPersistence, gameStateEngine } = graph;

    graph.attachLiveRuntime({ withConfiguration: false });

    gameStateEngine.initializeGameState(gameId);

    assert(
        recoveryDataPersistence.loadRecoveryRecord(gameId) === null,
        "H: checkpoint without configuration must NOT be written"
    );

    graph.cleanupRuntime(gameId);

}

// ---------------------------------------------------------------------------
// I — invalid players (wrong count): no write
// ---------------------------------------------------------------------------

{

    const graph = buildGraph("twoplayers");

    const { gameId, recoveryDataPersistence, gameStateEngine } = graph;

    graph.attachLiveRuntime({
        playerIdsOverride: [graph.playerIds[0], graph.playerIds[1]]
    });

    gameStateEngine.initializeGameState(gameId);

    assert(
        recoveryDataPersistence.loadRecoveryRecord(gameId) === null,
        "I: checkpoint with wrong player count must NOT be written"
    );

    graph.cleanupRuntime(gameId);

}

// ---------------------------------------------------------------------------
// J — invalid player index (duplicate id in room order): no write
// ---------------------------------------------------------------------------

{

    const graph = buildGraph("dupid");

    const { gameId, recoveryDataPersistence, gameStateEngine } = graph;

    graph.attachLiveRuntime({
        playerIdsOverride: [
            graph.playerIds[0],
            graph.playerIds[0],
            graph.playerIds[1]
        ]
    });

    gameStateEngine.initializeGameState(gameId);

    assert(
        recoveryDataPersistence.loadRecoveryRecord(gameId) === null,
        "J: checkpoint with duplicate player id must NOT be written"
    );

    graph.cleanupRuntime(gameId);

}

// ---------------------------------------------------------------------------
// K — invalid physics (not CREATED at pre-motion checkpoint): no write
// ---------------------------------------------------------------------------

{

    const graph = buildGraph("runningphys");

    const { gameId, recoveryDataPersistence, physicsEngine, gameStateEngine }
        = graph;

    graph.attachLiveRuntime();

    physicsEngine.startSimulation(gameId); // physics RUNNING before checkpoint

    gameStateEngine.initializeGameState(gameId);

    assert(
        recoveryDataPersistence.loadRecoveryRecord(gameId) === null,
        "K: checkpoint with non-CREATED physics must NOT be written"
    );

    graph.cleanupRuntime(gameId);

}

// ---------------------------------------------------------------------------
// L — RESULT without STOPPED physics: no write
// ---------------------------------------------------------------------------

{

    const graph = buildGraph("resultcreated");

    const { gameId, recoveryDataPersistence, gameStateEngine, eventBus } = graph;

    graph.attachLiveRuntime();

    gameStateEngine.initializeGameState(gameId);

    gameStateEngine.transition(gameId, "READY");

    gameStateEngine.transition(gameId, "SELF_TEST");

    gameStateEngine.transition(gameId, "SPEED");

    gameStateEngine.transition(gameId, "BRAKE");

    gameStateEngine.transition(gameId, "RESULT"); // physics still CREATED

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAME_RESULT_READY,
        payload: { gameId, timestamp: Date.now() }
    });

    const record = recoveryDataPersistence.loadRecoveryRecord(gameId);

    assert(record, "L-precondition: PRE_GAME_READY record should exist");

    assert(
        record.payload.gameState === "PRE_GAME_READY",
        "L: RESULT checkpoint with non-STOPPED physics must NOT write"
    );

    graph.cleanupRuntime(gameId);

}

// ---------------------------------------------------------------------------
// M/N — duplicate PRE_GAME_READY / READY are idempotent
// ---------------------------------------------------------------------------

{

    const graph = buildGraph("dupes");

    const { gameId, recoveryDataPersistence, gameStateEngine, eventBus } = graph;

    graph.attachLiveRuntime();

    gameStateEngine.initializeGameState(gameId);

    // Duplicate PRE_GAME_READY delivery (repeat of the same event).
    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAME_STATE_CHANGED,
        payload: {
            gameId,
            previousState: null,
            currentState: "PRE_GAME_READY",
            timestamp: Date.now()
        }
    });

    let records = recoveryDataPersistence.listRecoveryRecords();

    assert(records.length === 1, "M: duplicate PRE_GAME_READY created duplicates");

    graph.gameClockEngine.completePreGameReadyPhase(gameId);

    gameStateEngine.transition(gameId, "READY");

    // Duplicate READY delivery.
    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAME_STATE_CHANGED,
        payload: {
            gameId,
            previousState: "PRE_GAME_READY",
            currentState: "READY",
            timestamp: Date.now()
        }
    });

    records = recoveryDataPersistence.listRecoveryRecords();

    assert(records.length === 1, "N: duplicate READY created duplicates");

    assert(
        records[0].payload.gameState === "READY",
        "N: record must remain READY"
    );

    graph.cleanupRuntime(gameId);

}

// ---------------------------------------------------------------------------
// O/P — out-of-order older-phase events are ignored
// ---------------------------------------------------------------------------

{

    const graph = buildGraph("stale");

    const { gameId, recoveryDataPersistence, gameStateEngine, eventBus } = graph;

    graph.attachLiveRuntime();

    advanceThroughPhases(graph, { stopPhysicsAtEnd: true });

    const terminal = recoveryDataPersistence.loadRecoveryRecord(gameId);

    assert(
        terminal.payload.gameState === "RESULT",
        "O/P precondition: terminal RESULT record expected"
    );

    // O-equivalent at terminal level: stale PRE_GAME_READY after RESULT.
    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAME_STATE_CHANGED,
        payload: {
            gameId,
            previousState: null,
            currentState: "PRE_GAME_READY",
            timestamp: Date.now()
        }
    });

    let after = recoveryDataPersistence.loadRecoveryRecord(gameId);

    assert(
        after.payload.gameState === "RESULT"
            && after.updatedAt === terminal.updatedAt,
        "O: stale PRE_GAME_READY must be ignored without any write"
    );

    // P: stale READY after RESULT.
    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAME_STATE_CHANGED,
        payload: {
            gameId,
            previousState: "PRE_GAME_READY",
            currentState: "READY",
            timestamp: Date.now()
        }
    });

    after = recoveryDataPersistence.loadRecoveryRecord(gameId);

    assert(
        after.payload.gameState === "RESULT"
            && after.updatedAt === terminal.updatedAt,
        "P: stale READY must be ignored without any write"
    );

    graph.cleanupRuntime(gameId);

}

// ---------------------------------------------------------------------------
// Q — repeated RESULT is an idempotent terminal no-op
// ---------------------------------------------------------------------------

{

    const graph = buildGraph("represult");

    const { gameId, recoveryDataPersistence, eventBus } = graph;

    graph.attachLiveRuntime();

    advanceThroughPhases(graph, { stopPhysicsAtEnd: true });

    const terminal = recoveryDataPersistence.loadRecoveryRecord(gameId);

    assert(terminal.status === "TERMINAL", "Q precondition: TERMINAL expected");

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAME_RESULT_READY,
        payload: { gameId, timestamp: Date.now() }
    });

    const after = recoveryDataPersistence.loadRecoveryRecord(gameId);

    assert(after, "Q: record must survive repeated RESULT");

    assert(
        after.status === "TERMINAL"
            && after.payload.gameState === "RESULT"
            && after.checksum === terminal.checksum,
        "Q: repeated RESULT must be an idempotent no-op"
    );

    graph.cleanupRuntime(gameId);

}

// ---------------------------------------------------------------------------
// R — conflicting existing record is never overwritten
// ---------------------------------------------------------------------------

{

    const graph = buildGraph("conflict");

    const { gameId, roomId, playerIds, recoveryDataPersistence, gameStateEngine }
        = graph;

    graph.attachLiveRuntime();

    // Seed a foreign ACTIVE record with materially different content.
    const foreignConfiguration = {
        ...JSON.parse(JSON.stringify(
            graph.configurationEngine.getConfiguration(gameId)
        )),
        traceSeed: "foreign-trace-seed"
    };

    recoveryDataPersistence.createRecoveryRecord({
        recoveryContractVersion: 1,
        schemaVersion: 1,
        recoveryRecordId: gameId,
        roomId,
        gameId,
        contractId: "contract_FOREIGN",
        paymentSessionId: PAYMENT_SESSION_ID,
        tonNetwork: "testnet",
        configuration: foreignConfiguration,
        configurationHash: computePayloadChecksum(foreignConfiguration),
        configurationVersion: "1.0",
        traceSeed: "foreign-trace-seed",
        snapshotHash: SNAPSHOT_HASH,
        gameState: "PRE_GAME_READY",
        gameStatus: "RUNNING",
        serverTimestampAtCheckpoint: Date.now(),
        players: playerIds.map((playerId, index) => ({
            playerId,
            playerIndex: index,
            wallet: `EQwallet_conflict_${index}`,
            nickname: `P${index}`,
            baseStake: 10,
            sectorCount: 1,
            color: "RED",
            colorSector2: null,
            icon: "dice",
            sectorArrangement: "single",
            age: 30
        })),
        phaseStartedAt: Date.now(),
        clockStartedAt: Date.now(),
        clockPaused: false,
        clockTotalPausedMs: 0,
        awaitingResultActivation: false,
        resultPhaseStarted: false
    }, { status: "ACTIVE" });

    const before = recoveryDataPersistence.loadRecoveryRecord(gameId);

    gameStateEngine.initializeGameState(gameId); // conflicting checkpoint attempt

    const after = recoveryDataPersistence.loadRecoveryRecord(gameId);

    assert(
        after.payload.contractId === "contract_FOREIGN",
        "R: conflicting record must NOT be overwritten"
    );

    assert(
        after.configurationHash === before.configurationHash,
        "R: conflicting record content must remain untouched"
    );

    graph.cleanupRuntime(gameId);

}

// ---------------------------------------------------------------------------
// S — persistence failure is caught; handler does not throw
// ---------------------------------------------------------------------------

{

    const graph = buildGraph("fail");

    const { gameId, eventBus } = graph;

    graph.attachLiveRuntime();

    // Inject a failing persistence layer beneath the manager.
    const failingPersistence = {
        loadRecoveryRecord: () => null,
        createRecoveryRecord: () => {

            throw new Error("injected_storage_failure");

        },
        updateRecoveryRecord: () => {

            throw new Error("injected_storage_failure");

        }
    };

    const failingManager = new RecoveryCheckpointManager({
        logger,
        eventBus,
        recoveryDataPersistence: failingPersistence,
        roomManager: graph.roomManager,
        playerManager: graph.playerManager,
        gameManager: graph.gameManager,
        configurationEngine: graph.configurationEngine,
        gameStateEngine: graph.gameStateEngine,
        gameClockEngine: graph.gameClockEngine,
        physicsEngine: graph.physicsEngine,
        winnerEngine: graph.winnerEngine,
        inputAuthority: graph.inputAuthority,
        gameContractManager: {
            getContractByGameId: () => ({
                contractId: CONTRACT_ID,
                tonNetwork: "testnet",
                snapshotHash: SNAPSHOT_HASH,
                correlationId: null
            })
        },
        paymentSessionManager: {
            getSessionByGameId: () => ({
                paymentSessionId: PAYMENT_SESSION_ID,
                participants: graph.playerIds.map((playerId, index) => ({
                    playerId,
                    wallet: `EQwallet_fail_${index}`
                }))
            })
        }
    });

    // Authoritative gameplay proceeds normally before/around the failure.
    graph.gameStateEngine.initializeGameState(gameId);

    failingManager.initialize();

    let thrown = null;

    try {

        // Emitted through the EventBus exactly like production gameplay does.
        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.GAME_STATE_CHANGED,
            payload: {
                gameId,
                previousState: null,
                currentState: "PRE_GAME_READY",
                timestamp: Date.now()
            }
        });

    } catch (error) {

        thrown = error;

    }

    assert(thrown === null, "S: persistence failure escaped the EventBus");

    // Gameplay unaffected: state remains authoritative and intact.
    assert(
        graph.gameStateEngine.getState(gameId) === "PRE_GAME_READY",
        "S: gameplay state must be unaffected by persistence failure"
    );

    graph.cleanupRuntime(gameId);

}

// ---------------------------------------------------------------------------
// V — RecoveryOrchestrator compatibility for writer-produced records
// ---------------------------------------------------------------------------

function buildOrchestratorGraph(prefix) {

    const graph = buildGraph(prefix);

    const orchestrator = new RecoveryOrchestrator({
        logger,
        recoveryDataPersistence: graph.recoveryDataPersistence,
        roomManager: graph.roomManager,
        playerManager: graph.playerManager,
        gameManager: graph.gameManager,
        configurationEngine: graph.configurationEngine,
        gameStateEngine: graph.gameStateEngine,
        gameClockEngine: graph.gameClockEngine,
        physicsEngine: graph.physicsEngine,
        inputAuthority: graph.inputAuthority,
        winnerEngine: graph.winnerEngine
    });

    return { graph, orchestrator };

}

{

    /**
     * Produce a writer-created record payload at the requested phase using an
     * isolated producer graph, then consume it with a FRESH orchestrator graph
     * (empty runtime) — exactly like a post-restart RecoveryOrchestrator.
     */
    function producePayload(prefix, phase) {

        const producer = buildGraph(`prod_${prefix}`);

        producer.attachLiveRuntime();

        if (phase === "PRE_GAME_READY") {

            producer.gameStateEngine.initializeGameState(producer.gameId);

        } else if (phase === "READY") {

            producer.gameStateEngine.initializeGameState(producer.gameId);

            producer.gameClockEngine.completePreGameReadyPhase(producer.gameId);

            producer.gameStateEngine.transition(producer.gameId, "READY");

        } else {

            advanceThroughPhases(producer, { stopPhysicsAtEnd: true });

        }

        const record = producer.recoveryDataPersistence.loadRecoveryRecord(
            producer.gameId
        );

        assert(record, `V(${phase}): producer record missing`);

        // Structural compatibility: the writer-produced record must pass the
        // existing RecoveryDataPersistence validation unchanged.
        const validation = producer.recoveryDataPersistence
            .validateRecoveryRecord(record);

        assert(
            validation.valid,
            `V(${phase}): writer record fails persistence validation: `
                + `${validation.errors.join(",")}`
        );

        const payload = JSON.parse(JSON.stringify(record.payload));

        producer.cleanupRuntime(producer.gameId);

        return payload;

    }

    // V1 — PRE_GAME_READY record produced by the writer is consumable.
    {

        const payload = producePayload("pre", "PRE_GAME_READY");

        const { graph, orchestrator } = buildOrchestratorGraph("cons_pre");

        const result = orchestrator.recoverCandidate(payload);

        assert(
            result.status === RECOVERY_RESULT_STATUS.SUCCESS,
            `V1: orchestrator failed to consume PRE_GAME_READY record `
                + `(${result.status}: ${result.reason ?? ""})`
        );

        // R17.9T.6 OPTION B (deliberate architecture change): arming gated on
        // full-player connectivity.
        for (const player of payload.players) {

            graph.playerManager.setConnectionState(player.playerId, "CONNECTED");

        }

        assert(
            graph.gameClockEngine.isRunning(payload.gameId),
            "V1: recovered clock must be armed"
        );

        graph.cleanupRuntime(payload.gameId);

    }

    // V2 — READY record produced by the writer is consumable.
    {

        const payload = producePayload("ready", "READY");

        const { graph, orchestrator } = buildOrchestratorGraph("cons_ready");

        const result = orchestrator.recoverCandidate(payload);

        assert(
            result.status === RECOVERY_RESULT_STATUS.SUCCESS,
            `V2: orchestrator failed to consume READY record `
                + `(${result.status}: ${result.reason ?? ""})`
        );

        // R17.9T.6 OPTION B (deliberate architecture change): arming gated on
        // full-player connectivity.
        for (const player of payload.players) {

            graph.playerManager.setConnectionState(player.playerId, "CONNECTED");

        }

        assert(
            graph.gameClockEngine.isRunning(payload.gameId),
            "V2: recovered clock must be armed"
        );

        graph.cleanupRuntime(payload.gameId);

    }

    // V3 — RESULT record produced by the writer is consumable (terminal).
    {

        const payload = producePayload("result", "RESULT");

        const { graph, orchestrator } = buildOrchestratorGraph("cons_result");

        const result = orchestrator.recoverCandidate(payload);

        assert(
            result.status === RECOVERY_RESULT_STATUS.SUCCESS,
            `V3: orchestrator failed terminal reconstruction `
                + `(${result.status}: ${result.reason ?? ""})`
        );

        const restoredWinner = graph.winnerEngine.getResult(payload.gameId);

        assert(restoredWinner, "V3: silent winner restore did not run");

        assert(
            restoredWinner.winnerPlayerId === payload.winnerId,
            "V3: restored winner must match persisted winnerId"
        );

        graph.cleanupRuntime(payload.gameId);

    }

}

console.log("recoveryCheckpointWriter.r179t6.test.js: ALL TESTS PASSED");
