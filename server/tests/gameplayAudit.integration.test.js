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
import { LoggerService } from "../services/LoggerService.js";
import { RandomService } from "../services/RandomService.js";
import { TelegramWalletAdapter } from "../services/telegram/TelegramWalletAdapter.js";
import { SimulationLoop } from "../simulation/SimulationLoop.js";
import { WinnerActivation } from "../gameplay/WinnerActivation.js";
import { PaymentActivation } from "../gameplay/PaymentActivation.js";
import { AuditActivation } from "../gameplay/AuditActivation.js";
import { GameplayLifecycle } from "../gameplay/GameplayLifecycle.js";
import { buildClientRecoveryPayload } from "../socket/gameplayRecoveryProtocol.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function buildAuditStack() {

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

    randomService.setSeed(9876);

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

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
        gameClock: gameClockEngine
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
        telegramWalletAdapter: new TelegramWalletAdapter({ logger })
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
        paymentEngine
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
        recoveryEngine
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

    return {
        logger,
        eventBus,
        catalog,
        playerManager,
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
        shutdown() {

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

            playerManager.shutdown();

            randomService.shutdown();

            eventBus.shutdown();

            logger.shutdown();

        }
    };

}

function activateAndFinishGame(stack, gameId, playerIds) {

    stack.configurationEngine.generateConfiguration(
        gameId,
        { roomId: `room-${gameId}`, stake: 10 },
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

    // Seed clock history so the authoritative audit has a complete record. In
    // production this happens when the gameplay stops the clock at the wheel end.
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

    assert(guard < 2000, "game should reach RESULT");

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

// ---------------------------------------------------------------------------
// Scenario 1 — Audit runs exactly once, only after payment reaches a terminal
// state, and records authoritative immutable data. Winner + payment unchanged.
// ---------------------------------------------------------------------------

{

    const stack = buildAuditStack();

    try {

        const gameId = "audit-happy-path";

        const playerIds = createPlayers(stack, 3, "Audit Racer");

        const counts = {
            started: 0,
            ready: 0,
            failed: 0,
            reportCreated: 0
        };

        let readyPayload = null;

        let paymentStatusAtAuditStart = null;

        stack.eventBus.subscribe(EVENT_TYPES.AUDIT_STARTED, () => {

            counts.started += 1;

            // Authoritative gate check: when audit begins, payment must already
            // be final. Audit is the last step of a finished game.
            paymentStatusAtAuditStart = stack.paymentEngine
                .getPaymentStatus(gameId);

        });

        stack.eventBus.subscribe(EVENT_TYPES.AUDIT_REPORT_CREATED, () => {

            counts.reportCreated += 1;

        });

        stack.eventBus.subscribe(EVENT_TYPES.AUDIT_READY, (envelope) => {

            counts.ready += 1;

            readyPayload = envelope.payload;

        });

        stack.eventBus.subscribe(EVENT_TYPES.AUDIT_FAILED, () => {

            counts.failed += 1;

        });

        activateAndFinishGame(stack, gameId, playerIds);

        const winnerBefore = stack.winnerEngine.getResult(gameId);

        const paymentBefore = stack.paymentEngine.getPayment(gameId);

        // The whole WINNER_DETERMINED -> PAYMENT -> AUDIT chain is synchronous,
        // so by now audit has already finalized.

        assert(counts.failed === 0, "audit must not fail on the happy path");

        assert(counts.started === 1, "audit must start exactly once");

        assert(counts.reportCreated === 1, "audit report must be created once");

        assert(counts.ready === 1, "AUDIT_READY must be emitted exactly once");

        assert(
            paymentStatusAtAuditStart === "COMPLETED",
            "audit must start only after payment reaches a terminal state"
        );

        const report = stack.auditEngine.getAuditReport(gameId);

        assert(report, "authoritative audit report must exist");

        assert(Object.isFrozen(report), "audit report must be immutable");

        assert(report.gameId === gameId, "report references gameId");

        assert(
            report.configuration?.metadata?.roomId === `room-${gameId}`,
            "report references roomId"
        );

        assert(report.winner?.winningPlayer, "report records winner");

        assert(report.winner?.winningSector, "report records winning sector");

        assert(
            Number.isFinite(report.winner?.finalAngle),
            "report records final wheel angle"
        );

        assert(
            report.payment?.paymentStatus === "COMPLETED",
            "report records payment status"
        );

        assert(
            Number.isFinite(report.payment?.platformFee),
            "report records platform fee"
        );

        // AUDIT_READY payload carries the authoritative reference + facts.
        assert(readyPayload, "AUDIT_READY payload must be present");

        assert(
            typeof readyPayload.auditId === "string"
                && readyPayload.auditId.length > 0,
            "AUDIT_READY must carry an authoritative audit reference"
        );

        assert(readyPayload.gameId === gameId, "AUDIT_READY carries gameId");

        assert(
            readyPayload.roomId === `room-${gameId}`,
            "AUDIT_READY carries roomId"
        );

        assert(
            readyPayload.paymentStatus === "COMPLETED",
            "AUDIT_READY carries payment status"
        );

        assert(
            Number.isFinite(readyPayload.platformFee),
            "AUDIT_READY carries platform fee"
        );

        // Winner + payment are immutable — audit only observes them.
        const winnerAfter = stack.winnerEngine.getResult(gameId);

        const paymentAfter = stack.paymentEngine.getPayment(gameId);

        assert(
            winnerAfter === winnerBefore,
            "winner result must remain the same frozen object after audit"
        );

        assert(
            winnerAfter.winningPlayer.playerId
                === winnerBefore.winningPlayer.playerId,
            "winner must never change during audit"
        );

        assert(
            paymentAfter === paymentBefore,
            "payment result must remain unchanged after audit"
        );

        console.log("  scenario 1 (audit finalizes once after payment) passed");

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 2 — Recovery remains compatible: the client recovery payload carries
// the authoritative audit status for both pending and completed audits.
// ---------------------------------------------------------------------------

{

    const stack = buildAuditStack();

    try {

        const gameId = "audit-recovery";

        const playerIds = createPlayers(stack, 3, "Recovery Racer");

        activateAndFinishGame(stack, gameId, playerIds);

        const snapshot = stack.recoveryEngine.getRecoverySnapshot(gameId)
            ?? stack.recoveryEngine.buildRecoverySnapshot(gameId);

        const readyPayload = buildClientRecoveryPayload({
            snapshot,
            playerId: playerIds[0],
            roomId: `room-${gameId}`,
            paymentStatus: stack.paymentEngine.getPaymentStatus(gameId),
            payment: stack.paymentEngine.getPayment(gameId),
            auditStatus: "READY"
        });

        assert(
            readyPayload.audit?.status === "READY",
            "recovery payload must restore a completed audit status"
        );

        const pendingPayload = buildClientRecoveryPayload({
            snapshot,
            playerId: playerIds[0],
            roomId: `room-${gameId}`,
            auditStatus: null
        });

        assert(
            pendingPayload.audit === null,
            "recovery payload with no audit yet reports audit pending (null)"
        );

        console.log("  scenario 2 (recovery audit compatibility) passed");

    } finally {

        stack.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Scenario 3 — GameplayLifecycle teardown waits for audit completion. When
// audit-gating is enabled, RESULT alone must not schedule teardown; only an
// audit terminal event releases the deferred teardown.
// ---------------------------------------------------------------------------

{

    const logger = new LoggerService({ logLevel: "error" });

    logger.initialize();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const noopCatalog = { getTimers: () => ({}) };

    const noopEngine = {
        getSimulation: () => null,
        removeSimulation: () => {},
        hasGame: () => false,
        removeGame: () => {},
        getClock: () => null,
        removeClock: () => {},
        getResult: () => null,
        removeResult: () => {},
        getState: () => null,
        removeState: () => {},
        getConfiguration: () => null,
        removeConfiguration: () => {},
        getAuditReport: () => null,
        removeAuditReport: () => {}
    };

    const lifecycle = new GameplayLifecycle({
        logger,
        eventBus,
        gameCatalog: noopCatalog,
        physicsEngine: noopEngine,
        inputAuthority: noopEngine,
        gameClockEngine: noopEngine,
        gameStateEngine: noopEngine,
        configurationEngine: noopEngine,
        winnerEngine: noopEngine,
        winnerActivation: { forgetGame: () => {} },
        gameManager: null,
        devMode: false
    });

    lifecycle.initialize();

    lifecycle.configureAudit({
        auditEngine: noopEngine,
        auditActivation: { forgetGame: () => {} }
    });

    try {

        const gameId = "lifecycle-audit-gate";

        eventBus.emit({
            source: EVENT_SOURCES.GAME_STATE_ENGINE,
            type: EVENT_TYPES.GAME_STATE_CHANGED,
            payload: { gameId, currentState: GAME_STATES.RESULT }
        });

        assert(
            lifecycle.getPendingTeardownCount() === 0,
            "teardown must be deferred until audit completes"
        );

        eventBus.emit({
            source: EVENT_SOURCES.AUDIT_ENGINE,
            type: EVENT_TYPES.AUDIT_READY,
            payload: { gameId }
        });

        assert(
            lifecycle.getPendingTeardownCount() === 1,
            "teardown must be scheduled once audit reaches a terminal state"
        );

        console.log("  scenario 3 (lifecycle waits for audit) passed");

    } finally {

        lifecycle.shutdown();

        eventBus.shutdown();

        logger.shutdown();

    }

}

console.log("gameplayAudit.integration.test.js: all assertions passed");
