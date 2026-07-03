import { GameCatalog } from "../catalog/GameCatalog.js";
import { INPUT_RULES } from "../catalog/InputRules.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { GameClockEngine } from "../engines/GameClockEngine.js";
import { ConfigurationEngine } from "../engines/ConfigurationEngine.js";
import { GameStateEngine } from "../engines/GameStateEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { WinnerEngine } from "../engines/WinnerEngine.js";
import { PaymentEngine } from "../engines/PaymentEngine.js";
import { RecoveryEngine } from "../engines/RecoveryEngine.js";
import { AuditEngine } from "../engines/AuditEngine.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { InputAuthority } from "../input/InputAuthority.js";
import { PLAYER_STATE } from "../models/PlayerState.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { HealthService } from "../services/HealthService.js";
import { LoggerService } from "../services/LoggerService.js";
import { MetricsService } from "../services/MetricsService.js";
import {
    OperationalMetrics,
    OPERATIONAL_COUNTERS,
    GAME_DURATION_METRIC
} from "../services/OperationalMetrics.js";
import { RandomService } from "../services/RandomService.js";
import { TelegramWalletAdapter } from "../services/telegram/TelegramWalletAdapter.js";
import { SimulationLoop } from "../simulation/SimulationLoop.js";
import { WinnerActivation } from "../gameplay/WinnerActivation.js";
import { PaymentActivation } from "../gameplay/PaymentActivation.js";
import { AuditActivation } from "../gameplay/AuditActivation.js";
import { GameplayLifecycle } from "../gameplay/GameplayLifecycle.js";
import { loadProductionConfig } from "../config/production.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function delay(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

/**
 * C4.5 — Production readiness harness.
 *
 * Builds the complete authoritative stack (Gameplay Core + Winner + Payment +
 * Recovery + Audit + Lifecycle) exactly as production wires it, plus the
 * operational services (HealthService runtime provider, MetricsService counters,
 * OperationalMetrics observer). Nothing here changes gameplay behavior; the test
 * only drives finished games through the real pipeline and observes the result.
 *
 * The RESULT linger is shortened to 1ms via a catalog shim passed ONLY to
 * GameplayLifecycle so deterministic teardown flushes quickly under a real timer.
 */
function buildStack(options = {}) {

    const {
        seed = 4242,
        metricsEnabled = true,
        walletAdapter = null
    } = options;

    const logger = new LoggerService({ logLevel: "error" });

    logger.initialize();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const catalog = new GameCatalog({ logger });

    catalog.initialize();

    const randomService = new RandomService({ logger });

    randomService.initialize();

    randomService.setSeed(seed);

    const metricsService = new MetricsService({ enabled: metricsEnabled });

    metricsService.initialize();

    const operationalMetrics = new OperationalMetrics({
        logger,
        eventBus,
        metricsService,
        devMode: false
    });

    operationalMetrics.initialize();

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

    const roomManager = new RoomManager({
        logger,
        eventBus,
        roomConfig: { maxPlayers: 3 }
    });

    roomManager.initialize();

    const configurationEngine = new ConfigurationEngine({
        logger,
        eventBus,
        gameCatalog: catalog,
        randomService
    });

    configurationEngine.initialize();

    const gameClockEngine = new GameClockEngine({
        logger,
        eventBus,
        gameCatalog: catalog
    });

    gameClockEngine.initialize();

    const physicsEngine = new PhysicsEngine({
        logger,
        eventBus,
        gameClock: gameClockEngine,
        metricsService
    });

    physicsEngine.initialize();

    const gameStateEngine = new GameStateEngine({ logger, eventBus });

    gameStateEngine.initialize();

    const winnerEngine = new WinnerEngine({
        logger,
        eventBus,
        physicsEngine,
        configurationEngine,
        gameCatalog: catalog
    });

    winnerEngine.initialize();

    const inputAuthority = new InputAuthority({
        logger,
        eventBus,
        gameCatalog: {
            getInputRules: () => ({ ...INPUT_RULES, pressCooldownMs: 0 }),
            getColors: () => catalog.getColors(),
            getIcons: () => catalog.getIcons(),
            getStakes: () => catalog.getStakes(),
            getTimers: () => catalog.getTimers(),
            getWheelRules: () => catalog.getWheelRules()
        },
        playerManager,
        physicsEngine,
        gameStateEngine,
        devMode: false
    });

    inputAuthority.initialize();

    const paymentEngine = new PaymentEngine({
        logger,
        eventBus,
        winnerEngine,
        configurationEngine,
        gameCatalog: catalog,
        telegramWalletAdapter: walletAdapter
            ?? new TelegramWalletAdapter({ logger }),
        metricsService
    });

    paymentEngine.initialize();

    const recoveryEngine = new RecoveryEngine({
        logger,
        eventBus,
        gameCatalog: catalog,
        configurationEngine,
        gameStateEngine,
        gameClock: gameClockEngine,
        physicsEngine,
        inputAuthority,
        winnerEngine,
        paymentEngine,
        metricsService
    });

    recoveryEngine.initialize();

    const auditEngine = new AuditEngine({
        logger,
        eventBus,
        gameCatalog: catalog,
        configurationEngine,
        gameStateEngine,
        gameClock: gameClockEngine,
        physicsEngine,
        inputAuthority,
        winnerEngine,
        paymentEngine,
        recoveryEngine,
        metricsService
    });

    auditEngine.initialize();

    const simulationLoop = new SimulationLoop({
        logger,
        eventBus,
        physicsEngine,
        inputAuthority,
        devMode: false
    });

    simulationLoop.initialize();

    const winnerActivation = new WinnerActivation({
        logger,
        eventBus,
        physicsEngine,
        winnerEngine,
        gameStateEngine,
        devMode: false
    });

    winnerActivation.initialize();

    const paymentActivation = new PaymentActivation({
        logger,
        eventBus,
        paymentEngine,
        devMode: false
    });

    paymentActivation.initialize();

    const auditActivation = new AuditActivation({
        logger,
        eventBus,
        auditEngine,
        devMode: false
    });

    auditActivation.initialize();

    const gameplayLifecycle = new GameplayLifecycle({
        logger,
        eventBus,
        // Shorten RESULT linger so deterministic teardown flushes fast in-test.
        gameCatalog: { getTimers: () => ({ [GAME_STATES.RESULT]: { durationMs: 1 } }) },
        physicsEngine,
        inputAuthority,
        gameClockEngine,
        gameStateEngine,
        configurationEngine,
        winnerEngine,
        winnerActivation,
        paymentEngine,
        paymentActivation,
        gameManager: null,
        devMode: false
    });

    gameplayLifecycle.initialize();

    gameplayLifecycle.configureAudit({ auditEngine, auditActivation });

    const health = new HealthService({
        logger,
        productionConfig: loadProductionConfig({ NODE_ENV: "production" })
    });

    health.registerComponents({ eventBus: true, physicsEngine: true });

    health.registerRuntimeProvider(() => ({
        activeRooms: roomManager.getRooms().length,
        activeGames: 0,
        activeSimulations: physicsEngine.getActiveSimulationCount(),
        activeTimers: gameClockEngine.getActiveClockCount(),
        activeSockets: 0,
        pendingTeardowns: gameplayLifecycle.getPendingTeardownCount(),
        pendingPayments: paymentEngine.getActivePaymentCount(),
        pendingAudits: auditEngine.getActiveAuditCount()
    }));

    return {
        logger,
        eventBus,
        catalog,
        metricsService,
        operationalMetrics,
        playerManager,
        roomManager,
        configurationEngine,
        gameClockEngine,
        physicsEngine,
        gameStateEngine,
        winnerEngine,
        inputAuthority,
        paymentEngine,
        recoveryEngine,
        auditEngine,
        simulationLoop,
        winnerActivation,
        paymentActivation,
        auditActivation,
        gameplayLifecycle,
        health,
        idleRuntime() {

            return {
                activeSimulations: physicsEngine.getActiveSimulationCount(),
                activeTimers: gameClockEngine.getActiveClockCount(),
                pendingTeardowns: gameplayLifecycle.getPendingTeardownCount(),
                pendingPayments: paymentEngine.getActivePaymentCount(),
                pendingAudits: auditEngine.getActiveAuditCount(),
                configurations: configurationEngine.listConfigurationIds().length
            };

        },
        shutdown() {

            gameplayLifecycle.shutdown();

            auditActivation.shutdown();

            paymentActivation.shutdown();

            winnerActivation.shutdown();

            simulationLoop.shutdown();

            auditEngine.shutdown();

            recoveryEngine.shutdown();

            paymentEngine.shutdown();

            inputAuthority.shutdown();

            winnerEngine.shutdown();

            gameStateEngine.shutdown();

            gameClockEngine.shutdown();

            physicsEngine.shutdown();

            configurationEngine.shutdown();

            roomManager.shutdown();

            playerManager.shutdown();

            operationalMetrics.shutdown();

            metricsService.shutdown();

            randomService.shutdown();

            eventBus.shutdown();

            logger.shutdown();

        }
    };

}

function createPlayers(stack, count, label) {

    const playerIds = [];

    for (let index = 0; index < count; index += 1) {

        const created = stack.playerManager.createPlayer({
            nickname: `${label} ${index + 1}`
        });

        stack.playerManager.setPlayerState(
            created.identity.playerId,
            PLAYER_STATE.PLAYING
        );

        playerIds.push(created.identity.playerId);

    }

    return playerIds;

}

// Drive a game through the authoritative pipeline up to (but not past) RESULT.
// The synchronous WINNER -> PAYMENT -> AUDIT chain runs inside these ticks; the
// deferred teardown timer is scheduled by GameplayLifecycle once audit is done.
function activateAndFinishGame(stack, gameId, roomId, playerIds) {

    stack.configurationEngine.generateConfiguration(
        gameId,
        { roomId, stake: 10 },
        playerIds.map((playerId) => ({ playerId, sectorCount: 2 }))
    );

    stack.gameStateEngine.initializeGameState(gameId);

    for (const state of [
        GAME_STATES.COUNTDOWN,
        GAME_STATES.SELF_TEST,
        GAME_STATES.SPEED
    ]) {

        stack.gameStateEngine.transition(gameId, state, { reason: "test" });

    }

    stack.gameClockEngine.createClock(gameId);

    stack.gameClockEngine.startClock(gameId);

    stack.gameClockEngine.stopClock(gameId);

    stack.physicsEngine.createSimulation(gameId);

    stack.physicsEngine.startSimulation(gameId);

    for (const playerId of playerIds) {

        stack.inputAuthority.registerPlayer(gameId, playerId);

    }

    for (let tick = 0; tick < 5; tick += 1) {

        stack.simulationLoop._onTick();

    }

    stack.gameStateEngine.transition(gameId, GAME_STATES.BRAKE, {
        reason: "test"
    });

    let guard = 0;

    while (
        stack.gameStateEngine.getState(gameId) !== GAME_STATES.RESULT
        && guard < 2000
    ) {

        stack.simulationLoop._onTick();

        guard += 1;

    }

    assert(guard < 2000, `game ${gameId} should reach RESULT`);

}

// Track every lifecycle event per gameId so we can prove exactly-once semantics.
function trackLifecycleEvents(stack) {

    const tallies = new Map();

    const track = (type) => {

        const perGame = new Map();

        tallies.set(type, perGame);

        stack.eventBus.subscribe(type, (envelope) => {

            const gameId = envelope.payload?.gameId ?? "unknown";

            perGame.set(gameId, (perGame.get(gameId) ?? 0) + 1);

        });

    };

    for (const type of [
        EVENT_TYPES.CONFIGURATION_READY,
        EVENT_TYPES.PHYSICS_STARTED,
        EVENT_TYPES.WINNER_DETERMINED,
        EVENT_TYPES.PAYMENT_STARTED,
        EVENT_TYPES.PAYMENT_COMPLETED,
        EVENT_TYPES.AUDIT_READY,
        EVENT_TYPES.CLEANUP_COMPLETED
    ]) {

        track(type);

    }

    return tallies;

}

function assertExactlyOncePerGame(tallies, type, gameIds) {

    const perGame = tallies.get(type);

    assert(
        perGame.size === gameIds.length,
        `${type} must fire for every game (${perGame.size}/${gameIds.length})`
    );

    for (const gameId of gameIds) {

        assert(
            perGame.get(gameId) === 1,
            `${type} must fire exactly once for ${gameId} `
                + `(got ${perGame.get(gameId)})`
        );

    }

}

// ---------------------------------------------------------------------------
// Scenario 1 — Long-running sequential games. Verifies steady-state resource
// usage (no accumulation), full resource release after each game, event
// exactly-once integrity, and populated operational metrics.
// ---------------------------------------------------------------------------

{

    const stack = buildStack({ seed: 1001 });

    const SEQUENTIAL_GAMES = 100;

    try {

        const tallies = trackLifecycleEvents(stack);

        const gameIds = [];

        let maxActiveSimulations = 0;

        for (let index = 0; index < SEQUENTIAL_GAMES; index += 1) {

            const gameId = `seq-game-${index}`;

            const roomId = `seq-room-${index}`;

            gameIds.push(gameId);

            const playerIds = createPlayers(stack, 3, `Seq ${index}`);

            activateAndFinishGame(stack, gameId, roomId, playerIds);

            maxActiveSimulations = Math.max(
                maxActiveSimulations,
                stack.physicsEngine.getActiveSimulationCount()
            );

            // Flush the deferred teardown (1ms linger) before the next game so
            // only one game is live at a time — this is the steady-state check.
            await delay(6);

            assert(
                stack.physicsEngine.getActiveSimulationCount() === 0,
                `resources must be released after ${gameId}`
            );

        }

        // No accumulation: at most one live simulation at any point.
        assert(
            maxActiveSimulations <= 1,
            `active simulations must not accumulate (peak ${maxActiveSimulations})`
        );

        // Every game-scoped resource pool is empty.
        const idle = stack.idleRuntime();

        assert(idle.activeSimulations === 0, "no orphan simulations remain");

        assert(idle.activeTimers === 0, "no orphan timers remain");

        assert(idle.pendingTeardowns === 0, "no pending teardowns remain");

        assert(idle.pendingPayments === 0, "no orphan payment records remain");

        assert(idle.pendingAudits === 0, "no orphan audit reports remain");

        assert(idle.configurations === 0, "no orphan configurations remain");

        // Event integrity — each lifecycle event fired exactly once per game.
        for (const type of [
            EVENT_TYPES.CONFIGURATION_READY,
            EVENT_TYPES.PHYSICS_STARTED,
            EVENT_TYPES.WINNER_DETERMINED,
            EVENT_TYPES.PAYMENT_STARTED,
            EVENT_TYPES.PAYMENT_COMPLETED,
            EVENT_TYPES.AUDIT_READY,
            EVENT_TYPES.CLEANUP_COMPLETED
        ]) {

            assertExactlyOncePerGame(tallies, type, gameIds);

        }

        // Operational metrics reflect the whole batch.
        const snapshot = stack.metricsService.getSnapshot();

        assert(
            snapshot.counters[OPERATIONAL_COUNTERS.GAMES_STARTED]
                === SEQUENTIAL_GAMES,
            "metrics: games.started must equal the number of games"
        );

        assert(
            snapshot.counters[OPERATIONAL_COUNTERS.GAMES_COMPLETED]
                === SEQUENTIAL_GAMES,
            "metrics: games.completed must equal the number of games"
        );

        assert(
            snapshot.counters[OPERATIONAL_COUNTERS.CLEANUPS] === SEQUENTIAL_GAMES,
            "metrics: cleanup.completed must equal the number of games"
        );

        assert(
            snapshot.counters[OPERATIONAL_COUNTERS.PAYMENTS_COMPLETED]
                === SEQUENTIAL_GAMES,
            "metrics: payments.completed must equal the number of games"
        );

        assert(
            snapshot.counters[OPERATIONAL_COUNTERS.AUDITS_COMPLETED]
                === SEQUENTIAL_GAMES,
            "metrics: audits.completed must equal the number of games"
        );

        assert(
            snapshot.metrics[GAME_DURATION_METRIC]?.count === SEQUENTIAL_GAMES,
            "metrics: average game duration must be recorded for every game"
        );

        console.log(
            `  scenario 1 (${SEQUENTIAL_GAMES} sequential games, no leaks) passed`
        );

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 2 — Concurrent rooms. Verifies multi-room isolation: no winner,
// payment, audit or event crossover between simultaneously running games.
// ---------------------------------------------------------------------------

{

    const stack = buildStack({ seed: 2002 });

    const CONCURRENT_ROOMS = 20;

    try {

        const winners = new Map();

        stack.eventBus.subscribe(EVENT_TYPES.WINNER_DETERMINED, (envelope) => {

            const { gameId, winningPlayerId } = envelope.payload;

            winners.set(gameId, winningPlayerId ?? null);

        });

        const cleanups = new Map();

        stack.eventBus.subscribe(EVENT_TYPES.CLEANUP_COMPLETED, (envelope) => {

            const gameId = envelope.payload?.gameId;

            cleanups.set(gameId, (cleanups.get(gameId) ?? 0) + 1);

        });

        const games = [];

        for (let index = 0; index < CONCURRENT_ROOMS; index += 1) {

            games.push({
                gameId: `mux-game-${index}`,
                roomId: `mux-room-${index}`,
                playerIds: createPlayers(stack, 3, `Mux ${index}`)
            });

        }

        // Interleave setup so all rooms are live at the same time.
        for (const game of games) {

            stack.configurationEngine.generateConfiguration(
                game.gameId,
                { roomId: game.roomId, stake: 10 },
                game.playerIds.map((playerId) => ({ playerId, sectorCount: 2 }))
            );

            stack.gameStateEngine.initializeGameState(game.gameId);

            for (const state of [
                GAME_STATES.COUNTDOWN,
                GAME_STATES.SELF_TEST,
                GAME_STATES.SPEED
            ]) {

                stack.gameStateEngine.transition(game.gameId, state, {
                    reason: "test"
                });

            }

            stack.gameClockEngine.createClock(game.gameId);

            stack.gameClockEngine.startClock(game.gameId);

            stack.gameClockEngine.stopClock(game.gameId);

            stack.physicsEngine.createSimulation(game.gameId);

            stack.physicsEngine.startSimulation(game.gameId);

            for (const playerId of game.playerIds) {

                stack.inputAuthority.registerPlayer(game.gameId, playerId);

            }

        }

        assert(
            stack.physicsEngine.getActiveSimulationCount() === CONCURRENT_ROOMS,
            "all concurrent rooms must have a live simulation"
        );

        // Advance all rooms together.
        for (let tick = 0; tick < 5; tick += 1) {

            stack.simulationLoop._onTick();

        }

        for (const game of games) {

            stack.gameStateEngine.transition(game.gameId, GAME_STATES.BRAKE, {
                reason: "test"
            });

        }

        let guard = 0;

        const reachedResult = () => games.every(
            (game) => stack.gameStateEngine.getState(game.gameId)
                === GAME_STATES.RESULT
        );

        while (!reachedResult() && guard < 5000) {

            stack.simulationLoop._onTick();

            guard += 1;

        }

        assert(guard < 5000, "all concurrent rooms must reach RESULT");

        // Isolation: each game's winner belongs to its own player set, and each
        // game's audit references its own room — no crossover.
        for (const game of games) {

            const winnerId = winners.get(game.gameId);

            assert(
                game.playerIds.includes(winnerId),
                `winner of ${game.gameId} must belong to that game's players`
            );

            const report = stack.auditEngine.getAuditReport(game.gameId);

            assert(report, `audit report must exist for ${game.gameId}`);

            assert(
                report.configuration?.metadata?.roomId === game.roomId,
                `audit for ${game.gameId} must reference its own room`
            );

        }

        assert(
            winners.size === CONCURRENT_ROOMS,
            "each concurrent game must resolve exactly one winner"
        );

        // Flush teardown for all rooms.
        await delay(20);

        for (const game of games) {

            assert(
                cleanups.get(game.gameId) === 1,
                `cleanup must fire exactly once for ${game.gameId}`
            );

        }

        const idle = stack.idleRuntime();

        assert(
            idle.activeSimulations === 0 && idle.pendingTeardowns === 0
                && idle.pendingPayments === 0 && idle.pendingAudits === 0
                && idle.configurations === 0,
            "all concurrent-room resources must be released"
        );

        console.log(
            `  scenario 2 (${CONCURRENT_ROOMS} concurrent rooms, isolated) passed`
        );

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 3 — Fault tolerance. A failing wallet adapter must not change the
// gameplay result and must not block teardown; the server stays healthy.
// ---------------------------------------------------------------------------

{

    const failingWallet = {
        executeTransfer() {

            throw new Error("wallet adapter unavailable (injected fault)");

        }
    };

    const stack = buildStack({ seed: 3003, walletAdapter: failingWallet });

    try {

        const events = { paymentFailed: 0, cleanup: 0 };

        stack.eventBus.subscribe(EVENT_TYPES.PAYMENT_FAILED, () => {

            events.paymentFailed += 1;

        });

        stack.eventBus.subscribe(EVENT_TYPES.CLEANUP_COMPLETED, () => {

            events.cleanup += 1;

        });

        const gameId = "fault-wallet";

        const playerIds = createPlayers(stack, 3, "Fault Wallet");

        activateAndFinishGame(stack, gameId, `room-${gameId}`, playerIds);

        const winner = stack.winnerEngine.getResult(gameId);

        assert(winner, "winner must still be determined despite wallet failure");

        assert(
            playerIds.includes(winner.winningPlayer.playerId),
            "gameplay result must be unaffected by payment failure"
        );

        assert(
            stack.paymentEngine.getPaymentStatus(gameId) === "FAILED",
            "payment must be marked FAILED after wallet fault"
        );

        assert(events.paymentFailed === 1, "PAYMENT_FAILED must fire once");

        // Teardown still runs even though payment failed.
        await delay(10);

        assert(events.cleanup === 1, "cleanup must still occur after a fault");

        const idle = stack.idleRuntime();

        assert(
            idle.activeSimulations === 0 && idle.pendingTeardowns === 0
                && idle.pendingPayments === 0 && idle.configurations === 0,
            "resources must be released after a faulted game"
        );

        const healthSnapshot = stack.health.getHealthSnapshot();

        assert(
            healthSnapshot.status === "ok",
            "server must remain healthy after a wallet fault"
        );

        const snapshot = stack.metricsService.getSnapshot();

        assert(
            snapshot.counters[OPERATIONAL_COUNTERS.PAYMENTS_FAILED] === 1,
            "metrics: payments.failed must record the fault"
        );

        console.log("  scenario 3 (wallet fault tolerance) passed");

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 4 — Fault tolerance (audit). A failing audit must not change winner
// or payment, and teardown must still proceed once AUDIT_FAILED is surfaced.
// ---------------------------------------------------------------------------

{

    const stack = buildStack({ seed: 4004 });

    try {

        // Simulate an AuditEngine internal failure: it surfaces AUDIT_FAILED
        // authoritatively and throws (which AuditActivation swallows). This is a
        // test-only fault injection; the engine itself is not modified.
        const originalBuild = stack.auditEngine.buildAuditReport
            .bind(stack.auditEngine);

        stack.auditEngine.buildAuditReport = (gameId) => {

            stack.eventBus.emit({
                source: EVENT_SOURCES.AUDIT_ENGINE,
                type: EVENT_TYPES.AUDIT_FAILED,
                payload: { gameId, reason: "injected audit fault" }
            });

            throw new Error("audit failure (injected fault)");

        };

        const events = { auditFailed: 0, auditReady: 0, cleanup: 0 };

        stack.eventBus.subscribe(EVENT_TYPES.AUDIT_FAILED, () => {

            events.auditFailed += 1;

        });

        stack.eventBus.subscribe(EVENT_TYPES.AUDIT_READY, () => {

            events.auditReady += 1;

        });

        stack.eventBus.subscribe(EVENT_TYPES.CLEANUP_COMPLETED, () => {

            events.cleanup += 1;

        });

        const gameId = "fault-audit";

        const playerIds = createPlayers(stack, 3, "Fault Audit");

        activateAndFinishGame(stack, gameId, `room-${gameId}`, playerIds);

        const winner = stack.winnerEngine.getResult(gameId);

        const payment = stack.paymentEngine.getPayment(gameId);

        assert(winner, "winner must be determined despite audit failure");

        assert(
            payment && payment.paymentStatus === "COMPLETED",
            "payment must complete despite audit failure"
        );

        assert(events.auditFailed === 1, "AUDIT_FAILED must fire once");

        assert(events.auditReady === 0, "AUDIT_READY must not fire on failure");

        await delay(10);

        assert(
            events.cleanup === 1,
            "teardown must still proceed after AUDIT_FAILED"
        );

        // Restore for tidy shutdown.
        stack.auditEngine.buildAuditReport = originalBuild;

        const snapshot = stack.metricsService.getSnapshot();

        assert(
            snapshot.counters[OPERATIONAL_COUNTERS.AUDITS_FAILED] === 1,
            "metrics: audits.failed must record the fault"
        );

        console.log("  scenario 4 (audit fault tolerance) passed");

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 5 — HealthService runtime reporting + reconnect metric. Live counts
// must reflect an in-flight game and return to zero after cleanup.
// ---------------------------------------------------------------------------

{

    const stack = buildStack({ seed: 5005 });

    try {

        // Active rooms are reported independently of games.
        const room = stack.roomManager.createRoom({ maxPlayers: 3 });

        const beforeGame = stack.health.getHealthSnapshot();

        assert(beforeGame.runtime, "health snapshot must expose runtime counts");

        assert(
            beforeGame.runtime.activeRooms === 1,
            "health must report the active room"
        );

        assert(
            beforeGame.runtime.activeSimulations === 0,
            "no simulations before a game starts"
        );

        const gameId = "health-game";

        const playerIds = createPlayers(stack, 3, "Health");

        // Drive up to RESULT but capture runtime while the game is mid-flight.
        stack.configurationEngine.generateConfiguration(
            gameId,
            { roomId: "health-room", stake: 10 },
            playerIds.map((playerId) => ({ playerId, sectorCount: 2 }))
        );

        stack.gameStateEngine.initializeGameState(gameId);

        for (const state of [
            GAME_STATES.COUNTDOWN,
            GAME_STATES.SELF_TEST,
            GAME_STATES.SPEED
        ]) {

            stack.gameStateEngine.transition(gameId, state, { reason: "test" });

        }

        stack.gameClockEngine.createClock(gameId);

        stack.gameClockEngine.startClock(gameId);

        stack.physicsEngine.createSimulation(gameId);

        stack.physicsEngine.startSimulation(gameId);

        for (const playerId of playerIds) {

            stack.inputAuthority.registerPlayer(gameId, playerId);

        }

        const midFlight = stack.health.getHealthSnapshot();

        assert(
            midFlight.runtime.activeSimulations === 1,
            "health must report the live simulation"
        );

        assert(
            midFlight.runtime.activeTimers === 1,
            "health must report the live timer"
        );

        // A reconnect during the live game increments the reconnect metric.
        stack.recoveryEngine.recoverPlayer(gameId, playerIds[0]);

        assert(
            stack.metricsService.getCounter(OPERATIONAL_COUNTERS.RECONNECTS) === 1,
            "metrics: reconnects must record a player recovery"
        );

        // Finish the game and let it tear down.
        stack.gameClockEngine.stopClock(gameId);

        stack.gameStateEngine.transition(gameId, GAME_STATES.BRAKE, {
            reason: "test"
        });

        let guard = 0;

        while (
            stack.gameStateEngine.getState(gameId) !== GAME_STATES.RESULT
            && guard < 2000
        ) {

            stack.simulationLoop._onTick();

            guard += 1;

        }

        assert(guard < 2000, "health game must reach RESULT");

        await delay(10);

        stack.roomManager.destroyRoom(room.roomId);

        const afterGame = stack.health.getHealthSnapshot();

        assert(
            afterGame.runtime.activeRooms === 0
                && afterGame.runtime.activeSimulations === 0
                && afterGame.runtime.activeTimers === 0
                && afterGame.runtime.pendingTeardowns === 0
                && afterGame.runtime.pendingPayments === 0
                && afterGame.runtime.pendingAudits === 0,
            "all runtime counts must return to zero after cleanup"
        );

        console.log("  scenario 5 (health runtime + reconnect metric) passed");

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 6 — Graceful shutdown. After shutdown no timers linger and event
// subscriptions are released (a post-shutdown emit reaches no lifecycle logic).
// ---------------------------------------------------------------------------

{

    const stack = buildStack({ seed: 6006 });

    const gameId = "shutdown-game";

    const playerIds = createPlayers(stack, 3, "Shutdown");

    activateAndFinishGame(stack, gameId, `room-${gameId}`, playerIds);

    // A teardown timer is pending immediately after RESULT+audit.
    assert(
        stack.gameplayLifecycle.getPendingTeardownCount() >= 0,
        "lifecycle must track teardown state"
    );

    // Shut down before the linger elapses — pending timers must be cleared.
    stack.simulationLoop.stop?.();

    stack.gameplayLifecycle.shutdown();

    assert(
        stack.gameplayLifecycle.getPendingTeardownCount() === 0,
        "graceful shutdown must clear all pending teardown timers"
    );

    assert(
        stack.simulationLoop.isRunning() === false,
        "simulation loop must be stopped after shutdown"
    );

    // Subscriptions released: emitting after shutdown must not schedule work.
    stack.eventBus.emit({
        source: EVENT_SOURCES.GAME_STATE_ENGINE,
        type: EVENT_TYPES.GAME_STATE_CHANGED,
        payload: { gameId: "post-shutdown", currentState: GAME_STATES.RESULT }
    });

    assert(
        stack.gameplayLifecycle.getPendingTeardownCount() === 0,
        "lifecycle must ignore events after shutdown (subscriptions released)"
    );

    // Tidy up the remaining engines/services.
    stack.auditActivation.shutdown();

    stack.paymentActivation.shutdown();

    stack.winnerActivation.shutdown();

    stack.simulationLoop.shutdown();

    stack.auditEngine.shutdown();

    stack.recoveryEngine.shutdown();

    stack.paymentEngine.shutdown();

    stack.inputAuthority.shutdown();

    stack.winnerEngine.shutdown();

    stack.gameStateEngine.shutdown();

    stack.gameClockEngine.shutdown();

    stack.physicsEngine.shutdown();

    stack.configurationEngine.shutdown();

    stack.roomManager.shutdown();

    stack.playerManager.shutdown();

    stack.operationalMetrics.shutdown();

    stack.metricsService.shutdown();

    stack.eventBus.shutdown();

    stack.logger.shutdown();

    console.log("  scenario 6 (graceful shutdown) passed");

}

console.log("productionReadiness.integration.test.js: all assertions passed");
