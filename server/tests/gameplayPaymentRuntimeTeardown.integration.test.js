import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../events/EventBus.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { LoggerService } from "../services/LoggerService.js";
import { AuditActivation } from "../gameplay/AuditActivation.js";
import { GameplayLifecycle } from "../gameplay/GameplayLifecycle.js";
import { GameplayPaymentTerminalBridge } from "../gameplay/GameplayPaymentTerminalBridge.js";
import { TestnetWinnerPayoutCoordinator } from "../payment/runtime/TestnetWinnerPayoutCoordinator.js";
import { TestnetPendingPayoutReconciler } from "../payment/runtime/TestnetPendingPayoutReconciler.js";
import { RoomPayoutCalculator } from "../payment/ledger/RoomPayoutCalculator.js";

const gameId = "game-runtime-teardown";
const roomId = "room-runtime-teardown";
let payoutId = null;
const [playerA, playerB, playerC] = ["Alice", "Bob", "Carol"];
const wallets = ["a", "b", "c", "d", "e"].map(char => `0:${char.repeat(64)}`);

test("confirmed payment-runtime payout releases RESULT gameplay resources once", async t => {
    const logger = new LoggerService({ logLevel: "error" });
    logger.initialize();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();

    const resources = { game: true, simulation: true, timer: true, queue: true,
        winner: true, state: true, configuration: true };
    const gameManager = {
        hasGame: () => resources.game,
        getGame: () => ({ status: "RUNNING" }),
        finishGame: () => {},
        destroyGame: () => { resources.game = false; },
        getGames: () => resources.game ? [{ gameId }] : []
    };
    const physicsEngine = {
        getSimulation: () => resources.simulation ? {} : null,
        removeSimulation: () => { resources.simulation = false; }
    };
    const inputAuthority = {
        hasGame: () => resources.queue,
        removeGame: () => { resources.queue = false; }
    };
    const gameClockEngine = {
        getClock: () => resources.timer ? {} : null,
        removeClock: () => { resources.timer = false; }
    };
    const gameStateEngine = {
        getState: () => resources.state ? GAME_STATES.RESULT : null,
        removeState: () => { resources.state = false; }
    };
    const configurationEngine = {
        getConfiguration: () => resources.configuration ? {} : null,
        removeConfiguration: () => { resources.configuration = false; }
    };
    const winnerEngine = {
        getResult: () => resources.winner ? { winnerPlayerId: playerB } : null,
        removeResult: () => { resources.winner = false; }
    };
    const lifecycle = new GameplayLifecycle({
        logger, eventBus, gameCatalog: { getTimers: () => ({}) },
        gameManager, physicsEngine, inputAuthority, gameClockEngine,
        gameStateEngine, configurationEngine, winnerEngine,
        winnerActivation: { forgetGame() {} }, devMode: false
    });
    lifecycle.initialize();
    const auditActivation = new AuditActivation({
        logger,
        eventBus,
        auditEngine: { buildAuditReport: id => ({ gameId: id, createdAt: Date.now() }) }
    });
    auditActivation.initialize();
    lifecycle.configureAudit({
        auditEngine: { getAuditReport: () => null, removeAuditReport() {} },
        auditActivation
    });
    const terminalBridge = new GameplayPaymentTerminalBridge({ eventBus });

    const intents = [playerA, playerB, playerC].map((playerId, index) => ({
        playerId, state: "SETTLED", transactionId: `confirmed-${index}`,
        amountAtomic: 1_000_000_000, expectedSender: wallets[index]
    }));
    let openObligations = 2;
    let plan;
    const runtime = {
        paymentService: { listPaymentIntentsForRoom: () => intents },
        ledger: {
            getConfirmedPrincipalAtomic: () => 3_000_000_000,
            planPayout(args) {
                if (plan) return { replay: true, plan };
                plan = RoomPayoutCalculator.computePlan({
                    ...args, principalAtomic: 3_000_000_000,
                    asset: "TON", network: "testnet"
                }).toJSON();
                return { replay: false, plan };
            },
            countOpenObligations: () => openObligations
        },
        outcomeStore: {
            claim: (_room, kind, context) => { outcomeContext = { kind, context }; },
            get: () => outcomeContext,
            list: () => outcomeContext ? [{ roomId, ...outcomeContext }] : []
        },
        walletPool: { getReservationForRoom: () => ({
            reservedByRoomId: roomId, roomNumber: 2, address: wallets[4]
        }) }
    };
    let outcomeContext = null;
    let payoutSubmissions = 0;
    const payoutCoordinator = new TestnetWinnerPayoutCoordinator({
        paymentRuntime: runtime,
        roomManager: { getRoom: () => ({ players: [playerA, playerB, playerC] }) },
        playerManager: { getIdentity: id => ({ wallet: wallets[[playerA, playerB, playerC].indexOf(id)] }) },
        contextResolver: { resolveRoomByGameId: () => roomId },
        winnerEngine,
        ownerWalletProvider: () => wallets[3],
        payoutSubmitter: { submit: async ({ payoutId: id }) => {
            payoutId = id;
            payoutSubmissions += 1;
            return { status: "SUBMITTED_UNCONFIRMED", payoutId };
        } }
    });

    let reconciliationChecks = 0;
    const payoutPlanEntry = () => ({ kind: "PAYOUT_PLAN", roomId,
        metadata: { payoutId, plan } });
    const reconciler = new TestnetPendingPayoutReconciler({
        ledgerStore: { list: () => plan ? [payoutPlanEntry()] : [] },
        ledger: { countOpenObligations: () => openObligations },
        walletPool: runtime.walletPool,
        transport: { reconcileAndSettle: async () => {
            reconciliationChecks += 1;
            if (reconciliationChecks === 1) {
                return { status: "PAYOUT_OUTGOING_CONFIRMATION_PENDING" };
            }
            openObligations = 0;
            return { status: "BOTH_PAYOUTS_SETTLED_FROM_DUAL_FINALITY" };
        } },
        maxPerPass: 2
    });

    const paymentCompleted = [];
    const audits = [];
    let cleanupCount = 0;
    eventBus.subscribe(EVENT_TYPES.PAYMENT_COMPLETED, envelope => paymentCompleted.push(envelope.payload));
    eventBus.subscribe(EVENT_TYPES.AUDIT_READY, envelope => audits.push(envelope.payload));
    eventBus.subscribe(EVENT_TYPES.CLEANUP_COMPLETED, envelope => {
        if (envelope.payload?.gameId === gameId) cleanupCount += 1;
    });

    t.after(() => {
        auditActivation.shutdown();
        lifecycle.shutdown();
        eventBus.shutdown();
        logger.shutdown();
    });

    const payout = await payoutCoordinator.onGameResult({ gameId });
    assert.equal(payout.status, "SUBMITTED_UNCONFIRMED");
    assert.equal(payout.payoutId, payoutId);
    assert.equal(intents.filter(item => item.state === "SETTLED").length, 3);
    assert.equal(payoutSubmissions, 1);
    terminalBridge.trackPayout({ gameId, payoutId });
    terminalBridge.observePayoutOutcome({ payoutId, status: payout.status });

    eventBus.emit({
        source: EVENT_SOURCES.GAME_STATE_ENGINE,
        type: EVENT_TYPES.GAME_STATE_CHANGED,
        payload: { gameId, currentState: GAME_STATES.RESULT }
    });
    assert.equal(lifecycle.getPendingTeardownCount(), 0,
        "RESULT remains audit-gated until payout finality is known");

    let pass = await reconciler.runPass();
    const pendingOutcome = pass.results[0];
    terminalBridge.observePayoutOutcome({ payoutId, status: pendingOutcome.status });
    assert.equal(openObligations, 2, "unsettled payout obligations remain persisted");
    assert.equal(paymentCompleted.length, 0, "pending evidence cannot complete the audit gate");
    assert.equal(resources.game, true);

    pass = await reconciler.runPass();
    const settledOutcome = pass.results[0];
    assert.equal(settledOutcome.status, "BOTH_PAYOUTS_SETTLED_FROM_DUAL_FINALITY");
    terminalBridge.observePayoutOutcome({ payoutId, status: settledOutcome.status });
    terminalBridge.observePayoutOutcome({ payoutId, status: settledOutcome.status });
    assert.equal(paymentCompleted.length, 1, "terminal payout signal is idempotent");
    assert.equal(paymentCompleted[0].gameId, gameId);
    assert.equal(audits.length, 1);

    await new Promise(resolve => setTimeout(resolve, 3_100));
    assert.equal(cleanupCount, 1, "duplicate terminal evidence does not repeat teardown");
    assert.equal(resources.game, false);
    assert.equal(resources.simulation, false);
    assert.equal(resources.timer, false);
    assert.equal(resources.queue, false);
    assert.equal(openObligations, 0);
    assert.equal(payoutSubmissions, 1, "reconciliation never submits a second payout");
});
