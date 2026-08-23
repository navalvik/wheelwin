/**
 * R17.9T.6 — Production startup gameplay recovery integration tests.
 *
 * Validates the server/app.js startup integration contract:
 *
 *   A.  SOURCE ORDERING: in server/app.js the RecoveryOrchestrator
 *       construction + recoverAll() invocation occur AFTER
 *       RecoveryDataPersistence/RecoveryCheckpointManager construction and
 *       BEFORE SocketGateway construction and _listen(), so client/socket
 *       access is impossible before startup recovery completes.
 *
 *   B.  EMPTY STORE: empty recovery store is a normal successful startup.
 *
 *   C.  PRE_GAME_READY candidate reconstructed, clock armed last.
 *   D.  READY candidate reconstructed, clock armed last.
 *   E.  RESULT candidate reconstructed as terminal (no clock attach).
 *
 *   F.  INVALID record does not terminate startup (candidate-isolated).
 *   G.  EXPIRED record does not terminate startup (candidate-isolated).
 *   H.  UNSUPPORTED active phase (SPEED) does not terminate startup.
 *
 *   I.  MIXED candidates: one succeeds while another fails independently.
 *
 *   J.  INFRASTRUCTURE FAILURE is startup-fatal:
 *       - RecoveryDataPersistence cannot be constructed;
 *       - RecoveryOrchestrator cannot be constructed;
 *       - candidate discovery through the persistence layer fails.
 *
 *   K.  IDEMPOTENCY: repeated startup recovery reports ALREADY_RECOVERED and
 *       creates NO duplicate runtime objects.
 *
 *   L.  EVENT ISOLATION: no ROOM_CREATED / GAME_CREATED / PLAYER_CREATED or
 *       other gameplay lifecycle events are emitted during startup recovery,
 *       and no financial side effects occur (record count unchanged).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
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
import { LifecycleError } from "../errors/LifecycleError.js";
import { stableStringify } from "../persistence/tonFinancialRecordUtils.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

// ---------------------------------------------------------------------------
// Startup recovery sequence — mirrors the exact app.js integration policy
// (infrastructure failure = fatal; candidate failure = logged, non-fatal).
// ---------------------------------------------------------------------------

function runStartupRecoverySequence({
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
}) {

    let recoveryOrchestrator;

    try {

        recoveryOrchestrator = new RecoveryOrchestrator({
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

    } catch (error) {

        throw new LifecycleError(
            "Startup gameplay recovery infrastructure unavailable: "
                + `${error?.message ?? error}`
        );

    }

    const recoveryOutcome = recoveryOrchestrator.recoverAll();

    if (recoveryOutcome?.summary?.discoveryFailed === true) {

        throw new LifecycleError(
            "Startup gameplay recovery failed: recovery record discovery "
                + `through the persistence layer failed | `
                + `${recoveryOutcome.summary.discoveryError ?? "unknown error"}`
        );

    }

    const failedCandidates = [];

    for (const result of recoveryOutcome.results ?? []) {

        const isSkipped = typeof result?.status === "string"
            && result.status.startsWith("SKIPPED_");

        if (!isSkipped
            && result?.status !== "SUCCESS"
            && result?.status !== "ALREADY_RECOVERED") {

            failedCandidates.push(result);

            logger.error(
                "STARTUP_GAMEPLAY_RECOVERY_CANDIDATE_FAILED"
                    + ` | status=${result?.status}`
                    + ` | gameId=${result?.gameId ?? "unknown"}`
                    + ` | reason=${result?.reason ?? "-"}`
            );

        }

    }

    return { outcome: recoveryOutcome, failedCandidates };

}

// ---------------------------------------------------------------------------
// Event isolation counters
// ---------------------------------------------------------------------------

const LIFECYCLE_EVENTS = Object.freeze([
    EVENT_TYPES.CONFIGURATION_READY,
    EVENT_TYPES.GAME_STATE_CHANGED,
    EVENT_TYPES.CLOCK_STARTED,
    EVENT_TYPES.CLOCK_STOPPED,
    EVENT_TYPES.PHASE_TIMEOUT,
    EVENT_TYPES.PRE_GAME_READY_STARTED,
    EVENT_TYPES.READY_STARTED,
    EVENT_TYPES.SELF_TEST_STARTED,
    EVENT_TYPES.SPEED_STARTED,
    EVENT_TYPES.BRAKE_STARTED,
    EVENT_TYPES.RESULT_STARTED,
    EVENT_TYPES.PHYSICS_STARTED,
    EVENT_TYPES.PLAYER_INPUT_ACCEPTED,
    EVENT_TYPES.WINNING_SECTOR_RESOLVED,
    EVENT_TYPES.GAME_RESULT_READY,
    EVENT_TYPES.ROOM_CREATED,
    EVENT_TYPES.ROOM_DESTROYED,
    EVENT_TYPES.GAME_CREATED,
    EVENT_TYPES.GAME_DESTROYED,
    EVENT_TYPES.PLAYER_CREATED,
    EVENT_TYPES.PLAYER_REMOVED
]);

// ---------------------------------------------------------------------------
// Fixture builders (same contract shape as validated D3 orchestrator tests)
// ---------------------------------------------------------------------------

let fixtureCounter = 0;

function nextFixtureIds() {

    fixtureCounter += 1;

    return {
        gameId: `game_startup_${String(fixtureCounter).padStart(3, "0")}`,
        roomId: `room_startup_${String(fixtureCounter).padStart(3, "0")}`,
        playerIds: [
            `player_startup_${fixtureCounter}_a`,
            `player_startup_${fixtureCounter}_b`,
            `player_startup_${fixtureCounter}_c`
        ]
    };

}

const logger = new LoggerService();

logger.initialize();

function buildConfiguration(ids) {

    return {
        gameId: ids.gameId,
        configurationVersion: "1.0",
        createdAt: 1000,
        traceSeed: `trace-startup-${ids.gameId}`,
        sectors: ids.playerIds.map((playerId, index) => ({
            sectorId: `sector-${index}`,
            ownerId: playerId,
            color: ["#d62828", "#00aa44", "#1c73d0"][index],
            icon: ["dice", "spade", "queen"][index],
            sectorIndexForPlayer: 0,
            angleStart: index * 120,
            angleEnd: (index + 1) * 120
        })),
        players: ids.playerIds.map((playerId, index) => ({
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
            READY: { phase: "READY", durationMs: 30000 },
            SELF_TEST: { phase: "SELF_TEST", durationMs: 1500 },
            SPEED: { phase: "SPEED", durationMs: 8000 },
            BRAKE: { phase: "BRAKE", durationMs: 6000 },
            RESULT: { phase: "RESULT", durationMs: 4000 }
        },
        stake: 10,
        metadata: {
            roomId: ids.roomId,
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
 * Build a valid RECOVERY_DATA payload. Default: READY candidate.
 */
function buildPayload(ids, overrides = {}) {

    const configuration = overrides.configuration ?? buildConfiguration(ids);

    const now = Date.now();

    const checkpoint = overrides.serverTimestampAtCheckpoint ?? (now - 1000);

    const payload = {
        recoveryContractVersion: 1,
        schemaVersion: 1,
        recoveryRecordId: ids.gameId,
        roomId: ids.roomId,
        gameId: ids.gameId,
        contractId: `contract_${ids.gameId}`,
        paymentSessionId: `payment_session_${ids.gameId}`,
        tonNetwork: "testnet",
        correlationId: null,
        players: ids.playerIds.map((playerId, index) => ({
            playerId,
            playerIndex: index,
            wallet: `EQwallet${index}_${ids.gameId}`,
            nickname: `Player${index}`,
            baseStake: 10,
            sectorCount: 1,
            color: ["RED", "GREEN", "BLUE"][index],
            colorSector2: null,
            icon: ["dice", "spade", "queen"][index],
            sectorArrangement: "single",
            age: 25 + index
        })),
        configuration,
        configurationHash: computeConfigurationHash(configuration),
        configurationVersion: "1.0",
        traceSeed: configuration.traceSeed,
        snapshotHash: `snapshot-${ids.gameId}`,
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

    if (overrides.configuration !== undefined
        && overrides.configurationHash === undefined) {

        payload.configurationHash = computeConfigurationHash(
            payload.configuration
        );

    }

    return payload;

}

// ---------------------------------------------------------------------------
// Graph construction (fresh isolated graph per section)
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

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-startup-recovery-"));

    const financialPersistence = new TonFinancialPersistence({
        dataDir,
        autoCheckpoint: false
    });

    financialPersistence.initialize();

    const recoveryDataPersistence = new RecoveryDataPersistence({
        financialPersistence,
        logger
    });

    return {
        logger,
        eventBus,
        eventCounts,
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
        financialPersistence,
        recoveryDataPersistence
    };

}

// ===========================================================================
// A. SOURCE ORDERING — app.js integration point precedes client access
// ===========================================================================

{

    const serverRoot = join(
        dirname(fileURLToPath(import.meta.url)),
        ".."
    );

    const appSource = readFileSync(join(serverRoot, "app.js"), "utf8");

    const idxCheckpointManager =
        appSource.indexOf("this._recoveryCheckpointManager.initialize();");

    const idxOrchestratorConstruct =
        appSource.indexOf("new RecoveryOrchestrator({");

    const idxRecoverAll = appSource.indexOf(".recoverAll()");

    const idxSocketGateway = appSource.indexOf("this._socketGateway = new SocketGateway({");

    const idxListen = appSource.indexOf("await this._listen();");

    assert(idxCheckpointManager !== -1, "A: checkpoint manager init not found");
    assert(idxOrchestratorConstruct !== -1, "A: orchestrator construction not found");
    assert(idxRecoverAll !== -1, "A: recoverAll invocation not found");
    assert(idxSocketGateway !== -1, "A: SocketGateway construction not found");
    assert(idxListen !== -1, "A: listen call not found");

    assert(
        idxCheckpointManager < idxOrchestratorConstruct,
        "A: RecoveryOrchestrator must be constructed after RecoveryCheckpointManager"
    );

    assert(
        idxOrchestratorConstruct < idxRecoverAll,
        "A: recoverAll() must be invoked after orchestrator construction"
    );

    assert(
        idxRecoverAll < idxSocketGateway,
        "A: recoverAll() must complete before SocketGateway construction"
    );

    assert(
        idxSocketGateway < idxListen,
        "A: SocketGateway must be initialized before listen()"
    );

    // The startup recovery block must be fail-closed on infrastructure error.
    assert(
        appSource.includes("Startup gameplay recovery infrastructure unavailable"),
        "A: infrastructure failure must be startup-fatal (LifecycleError)"
    );

    assert(
        appSource.includes("discoveryFailed"),
        "A: discovery failure must be startup-fatal"
    );

    console.log("A. source ordering OK");

}

// ===========================================================================
// B. EMPTY STORE — normal successful startup condition
// ===========================================================================

{

    const graph = buildGraph();

    const { outcome, failedCandidates } = runStartupRecoverySequence(graph);

    assert(outcome.results.length === 0, "B: expected zero results");
    assert(failedCandidates.length === 0, "B: expected zero failures");
    assert(
        !graph.roomManager.getRooms?.().length,
        "B: no rooms should exist"
    );
    graph.assertZeroLifecycleEvents("B");

    console.log("B. empty store OK");

}

// ===========================================================================
// C. VALID PRE_GAME_READY CANDIDATE — reconstructed, clock armed last
// ===========================================================================

{

    const graph = buildGraph();

    const ids = nextFixtureIds();

    graph.recoveryDataPersistence.createRecoveryRecord(
        buildPayload(ids, { gameState: "PRE_GAME_READY" })
    );

    const { outcome, failedCandidates } = runStartupRecoverySequence(graph);

    assert(failedCandidates.length === 0, "C: unexpected failures");
    assert(outcome.summary.success === 1, "C: expected 1 recovered");

    assert(graph.roomManager.hasRoom(ids.roomId), "C: room missing");
    assert(graph.gameManager.hasGame(ids.gameId), "C: game missing");
    for (const playerId of ids.playerIds) {

        assert(
            graph.playerManager.hasPlayer(playerId),
            `C: player missing (${playerId})`
        );

    }
    assert(
        graph.configurationEngine.getConfiguration(ids.gameId) != null,
        "C: configuration missing"
    );
    assert(
        graph.physicsEngine.getSimulation(ids.gameId) != null,
        "C: physics missing"
    );

    // R17.9T.6 OPTION B (deliberate architecture change): the recovered
    // clock is UNARMED-ATTACHED until ALL 3 registered players report
    // CONNECTED; connecting them arms it exactly once.
    const clockRecord = graph.gameClockEngine._clocks.get(ids.gameId);
    assert(clockRecord != null, "C: clock missing");
    assert(clockRecord.running === false, "C: recovered clock must start unarmed");

    for (const playerId of ids.playerIds) {

        graph.playerManager.setConnectionState(playerId, "CONNECTED");

    }

    assert(clockRecord.running === true, "C: recovered clock not armed");

    graph.assertZeroLifecycleEvents("C");

    // Remove the armed clock AFTER the isolation assertion: teardown of an
    // armed clock legitimately emits CLOCK_STOPPED, and its phase timer
    // would otherwise keep the test process alive.
    graph.gameClockEngine.removeClock(ids.gameId);

    console.log("C. PRE_GAME_READY recovery OK");

}

// ===========================================================================
// D. VALID READY CANDIDATE — reconstructed, clock armed last
// ===========================================================================

{

    const graph = buildGraph();

    const ids = nextFixtureIds();

    graph.recoveryDataPersistence.createRecoveryRecord(buildPayload(ids));

    const { outcome, failedCandidates } = runStartupRecoverySequence(graph);

    assert(failedCandidates.length === 0, "D: unexpected failures");
    assert(outcome.summary.success === 1, "D: expected 1 recovered");
    assert(graph.gameManager.hasGame(ids.gameId), "D: game missing");

    // R17.9T.6 OPTION B (deliberate architecture change): arming gated on
    // full-player connectivity.
    const clockRecord = graph.gameClockEngine._clocks.get(ids.gameId);
    assert(clockRecord != null && clockRecord.running === false,
        "D: recovered clock must start unarmed");

    for (const playerId of ids.playerIds) {

        graph.playerManager.setConnectionState(playerId, "CONNECTED");

    }

    assert(clockRecord.running === true,
        "D: recovered clock not armed");

    graph.assertZeroLifecycleEvents("D");

    // Remove the armed clock AFTER the isolation assertion (see section C).
    graph.gameClockEngine.removeClock(ids.gameId);

    console.log("D. READY recovery OK");

}

// ===========================================================================
// E. VALID RESULT CANDIDATE — terminal reconstruction, no clock
// ===========================================================================

{

    const graph = buildGraph();

    const ids = nextFixtureIds();

    graph.recoveryDataPersistence.createRecoveryRecord(
        buildPayload(ids, { gameState: "RESULT" })
    );

    const { outcome, failedCandidates } = runStartupRecoverySequence(graph);

    assert(failedCandidates.length === 0, "E: unexpected failures");
    assert(outcome.summary.success === 1, "E: expected 1 recovered");
    assert(graph.gameManager.hasGame(ids.gameId), "E: game missing");

    assert(
        graph.gameClockEngine.getClock(ids.gameId) === null,
        "E: RESULT candidate must not have a clock attached"
    );

    assert(
        graph.winnerEngine.getResult(ids.gameId) != null,
        "E: RESULT candidate must restore deterministic winner result"
    );

    graph.assertZeroLifecycleEvents("E");

    console.log("E. RESULT recovery OK");

}

// ===========================================================================
// F. INVALID RECORD — candidate-isolated, startup continues
// ===========================================================================

{

    const graph = buildGraph();

    const ids = nextFixtureIds();

    const payload = buildPayload(ids);

    // Corrupt the checksum of an otherwise well-formed envelope so the
    // record reaches the orchestrator but fails structural validation.
    const record = {
        recordId: ids.gameId,
        version: 1,
        status: "ACTIVE",
        immutable: false,
        checksum: "deadbeef".repeat(8),
        payload
    };

    const failingPersistence = {
        listRecoveryRecords: () => [record],
        validateRecoveryRecord: (r) =>
            graph.recoveryDataPersistence.validateRecoveryRecord(r)
    };

    const { outcome, failedCandidates } = runStartupRecoverySequence({
        ...graph,
        logger,
        recoveryDataPersistence: failingPersistence
    });

    assert(outcome.summary.total === 1, "F: expected 1 discovered");
    assert(failedCandidates.length === 1, "F: expected 1 failed candidate");
    assert(
        failedCandidates[0].status
            === RECOVERY_RESULT_STATUS.FAILED_INVALID_RECORD,
        "F: expected FAILED_INVALID_RECORD"
    );

    // No partial runtime may remain after the failed candidate.
    assert(!graph.roomManager.hasRoom(ids.roomId), "F: room residue");
    assert(!graph.gameManager.hasGame(ids.gameId), "F: game residue");

    graph.assertZeroLifecycleEvents("F");

    console.log("F. invalid record isolated OK");

}

// ===========================================================================
// G. EXPIRED RECORD — candidate-isolated, startup continues
// ===========================================================================

{

    const graph = buildGraph();

    const ids = nextFixtureIds();

    const now = Date.now();

    graph.recoveryDataPersistence.createRecoveryRecord(
        buildPayload(ids, {
            gameState: "READY",
            phaseStartedAt: now - 600000,
            serverTimestampAtCheckpoint: now - 100000
        })
    );

    const { outcome, failedCandidates } = runStartupRecoverySequence(graph);

    assert(outcome.summary.total === 1, "G: expected 1 discovered");
    assert(failedCandidates.length === 1, "G: expected 1 failed candidate");
    assert(
        failedCandidates[0].status === RECOVERY_RESULT_STATUS.FAILED_EXPIRED,
        "G: expected FAILED_EXPIRED"
    );

    assert(!graph.roomManager.hasRoom(ids.roomId), "G: room residue");
    assert(!graph.gameManager.hasGame(ids.gameId), "G: game residue");
    assert(
        graph.gameClockEngine.getClock(ids.gameId) === null,
        "G: expired candidate must not arm a clock"
    );

    graph.assertZeroLifecycleEvents("G");

    console.log("G. expired record isolated OK");

}

// ===========================================================================
// H. UNSUPPORTED ACTIVE PHASE (SPEED) — skipped, startup continues
// ===========================================================================

{

    const graph = buildGraph();

    const ids = nextFixtureIds();

    graph.recoveryDataPersistence.createRecoveryRecord(
        buildPayload(ids, { gameState: "SPEED" })
    );

    const { outcome, failedCandidates } = runStartupRecoverySequence(graph);

    assert(outcome.summary.total === 1, "H: expected 1 discovered");
    assert(failedCandidates.length === 0, "H: skip is not a failure");
    assert(
        outcome.results[0].status
            === RECOVERY_RESULT_STATUS.SKIPPED_NOT_RECOVERABLE,
        "H: expected SKIPPED_NOT_RECOVERABLE"
    );

    assert(!graph.roomManager.hasRoom(ids.roomId), "H: room residue");
    assert(!graph.gameManager.hasGame(ids.gameId), "H: game residue");

    graph.assertZeroLifecycleEvents("H");

    console.log("H. unsupported phase skipped OK");

}

// ===========================================================================
// I. MIXED CANDIDATES — independent success/failure processing
// ===========================================================================

{

    const graph = buildGraph();

    const okIds = nextFixtureIds();

    const badIds = nextFixtureIds();

    const now = Date.now();

    graph.recoveryDataPersistence.createRecoveryRecord(
        buildPayload(okIds, { gameState: "READY" })
    );

    graph.recoveryDataPersistence.createRecoveryRecord(
        buildPayload(badIds, {
            gameState: "READY",
            phaseStartedAt: now - 600000,
            serverTimestampAtCheckpoint: now - 100000
        })
    );

    const { outcome, failedCandidates } = runStartupRecoverySequence(graph);

    assert(outcome.summary.total === 2, "I: expected 2 discovered");
    assert(outcome.summary.success === 1, "I: expected 1 recovered");
    assert(failedCandidates.length === 1, "I: expected 1 failed candidate");

    // Successful candidate fully reconstructed.
    assert(graph.gameManager.hasGame(okIds.gameId), "I: good game missing");
    const clockRecord = graph.gameClockEngine._clocks.get(okIds.gameId);
    // R17.9T.6 OPTION B (deliberate architecture change): arming gated on
    // full-player connectivity.
    assert(clockRecord?.running === false, "I: good clock must start unarmed");

    for (const playerId of okIds.playerIds) {

        graph.playerManager.setConnectionState(playerId, "CONNECTED");

    }

    assert(clockRecord?.running === true, "I: good clock not armed");

    // Failed candidate left no residue and did not disturb the good one.
    assert(!graph.gameManager.hasGame(badIds.gameId), "I: bad game residue");
    assert(
        graph.gameClockEngine.getClock(badIds.gameId) === null,
        "I: bad clock residue"
    );

    graph.assertZeroLifecycleEvents("I");

    // Remove the armed clock AFTER the isolation assertion (see section C).
    graph.gameClockEngine.removeClock(okIds.gameId);

    console.log("I. mixed candidates OK");

}

// ===========================================================================
// J. INFRASTRUCTURE FAILURE — startup-fatal (fail-closed)
// ===========================================================================

{

    // J1. RecoveryDataPersistence cannot be constructed.
    let threw = false;

    try {

        new RecoveryDataPersistence({ financialPersistence: null });

    } catch {

        threw = true;

    }

    assert(threw, "J1: RecoveryDataPersistence construction must fail closed");

    // J2. RecoveryOrchestrator cannot be constructed without persistence.
    threw = false;

    try {

        new RecoveryOrchestrator({});

    } catch {

        threw = true;

    }

    assert(threw, "J2: RecoveryOrchestrator construction must fail closed");

    // J3. Discovery failure through the persistence layer is startup-fatal.
    const graph = buildGraph();

    const failingPersistence = {
        listRecoveryRecords: () => {

            throw new Error("persistence backend unavailable");

        },
        validateRecoveryRecord: (r) =>
            graph.recoveryDataPersistence.validateRecoveryRecord(r)
    };

    threw = false;

    try {

        runStartupRecoverySequence({
            ...graph,
            logger,
            recoveryDataPersistence: failingPersistence
        });

    } catch (error) {

        threw = error instanceof LifecycleError;

    }

    assert(threw, "J3: discovery failure must throw LifecycleError");

    console.log("J. infrastructure failure fail-closed OK");

}

// ===========================================================================
// K. IDEMPOTENCY — repeated startup creates no duplicate runtime
// ===========================================================================

{

    const graph = buildGraph();

    const ids = nextFixtureIds();

    graph.recoveryDataPersistence.createRecoveryRecord(
        buildPayload(ids, { gameState: "READY" })
    );

    const first = runStartupRecoverySequence(graph);

    assert(first.outcome.summary.success === 1, "K: first pass recovered");

    const gamesAfterFirst = graph.gameManager.getGames().length;

    const roomsAfterFirst = graph.roomManager.getRooms().length;

    const second = runStartupRecoverySequence(graph);

    assert(
        second.outcome.results[0].status
            === RECOVERY_RESULT_STATUS.ALREADY_RECOVERED,
        "K: second pass must report ALREADY_RECOVERED"
    );

    assert(
        graph.gameManager.getGames().length === gamesAfterFirst,
        "K: duplicate game created"
    );

    assert(
        graph.roomManager.getRooms().length === roomsAfterFirst,
        "K: duplicate room created"
    );

    graph.assertZeroLifecycleEvents("K");

    console.log("K. idempotency OK");

}

// ===========================================================================
// L. FINANCIAL SIDE EFFECTS — none during startup recovery
// ===========================================================================

{

    const graph = buildGraph();

    const ids = nextFixtureIds();

    graph.recoveryDataPersistence.createRecoveryRecord(
        buildPayload(ids, { gameState: "READY" })
    );

    const recordsBefore =
        graph.financialPersistence.listActiveRecoveryDataRecords().length;

    runStartupRecoverySequence(graph);

    const recordsAfter =
        graph.financialPersistence.listActiveRecoveryDataRecords().length;

    assert(
        recordsBefore === recordsAfter,
        "L: startup recovery must not write financial/recovery records"
    );

    graph.assertZeroLifecycleEvents("L");

    console.log("L. no financial side effects OK");

}

console.log("All R17.9T.6 startup recovery integration tests passed");
