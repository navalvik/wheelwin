/**
 * R17.9J.2I.3 — AuditVerifier fee freeze synchronization tests.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { GameCatalog } from "../catalog/GameCatalog.js";
import { PAYMENT_RULES } from "../catalog/PaymentRules.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { AuditVerifier } from "../engines/audit/AuditVerifier.js";
import { ConfigurationEngine } from "../engines/ConfigurationEngine.js";
import { PaymentEngine } from "../engines/PaymentEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { WinnerEngine } from "../engines/WinnerEngine.js";
import { LoggerService } from "../services/LoggerService.js";
import { RandomService } from "../services/RandomService.js";
import { TelegramWalletAdapter } from "../services/telegram/TelegramWalletAdapter.js";
import { createStandardConfigurationPlayers } from "./helpers/configurationPlayers.js";

function configureCatalogFee(catalog, platformFeeRate) {

    catalog.configurePaymentRules({
        ...PAYMENT_RULES,
        platformFeeRate,
        contributionByStake: {
            ...PAYMENT_RULES.contributionByStake
        }
    });

}

function emitGameInitialized(eventBus, gameId, roomId = "audit-fee-room") {

    eventBus.emit({
        source: EVENT_SOURCES.GAME_MANAGER,
        type: EVENT_TYPES.GAME_INITIALIZED,
        payload: {
            gameId,
            roomId,
            status: "READY"
        }
    });

}

function createAuditFeeStack({
    platformFeeRate = 0.05,
    contractSnapshot = null
} = {}) {

    const logger = new LoggerService();

    logger.initialize();

    const catalog = new GameCatalog({ logger });

    catalog.initialize();

    configureCatalogFee(catalog, platformFeeRate);

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const randomService = new RandomService({ logger });

    randomService.initialize();

    randomService.setSeed(31);

    const configurationEngine = new ConfigurationEngine({
        logger,
        eventBus,
        gameCatalog: catalog,
        randomService
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
        gameCatalog: catalog
    });

    winnerEngine.initialize();

    const gameContractManager = contractSnapshot
        ? {
            getContractByGameId(gameId) {

                return {
                    snapshot: Object.freeze({
                        ...contractSnapshot,
                        gameId
                    })
                };

            }
        }
        : {
            getContractByGameId: () => null
        };

    const paymentEngine = new PaymentEngine({
        logger,
        eventBus,
        winnerEngine,
        configurationEngine,
        gameCatalog: catalog,
        gameContractManager,
        telegramWalletAdapter: new TelegramWalletAdapter({ logger })
    });

    paymentEngine.initialize();

    const verifier = new AuditVerifier({
        gameCatalog: catalog,
        configurationEngine,
        gameContractManager
    });

    return {
        catalog,
        configurationEngine,
        eventBus,
        physicsEngine,
        winnerEngine,
        paymentEngine,
        verifier,
        shutdown() {

            paymentEngine.shutdown();
            winnerEngine.shutdown();
            configurationEngine.shutdown();
            physicsEngine.shutdown();
            randomService.shutdown();

        }
    };

}

function prepareCompletedPayment(stack, gameId, { freezeEconomy = false } = {}) {

    stack.configurationEngine.generateConfiguration(
        gameId,
        { roomId: "audit-fee-room", stake: 10 },
        createStandardConfigurationPlayers([
            "player-1",
            "player-2",
            "player-3"
        ])
    );

    if (freezeEconomy) {

        emitGameInitialized(stack.eventBus, gameId);

    }

    stack.physicsEngine.createSimulation(gameId);
    stack.physicsEngine.startSimulation(gameId);
    stack.physicsEngine.stopSimulation(gameId);

    const winner = stack.winnerEngine.resolveResult(gameId);

    stack.paymentEngine.preparePayment(gameId);
    const payment = stack.paymentEngine.processPayment(gameId);

    const configuration = stack.configurationEngine.getConfiguration(gameId);

    return { configuration, winner, payment };

}

test("R17.9J.2I.3 contract snapshot audit uses frozen contract fee", () => {

    const stack = createAuditFeeStack({
        platformFeeRate: 0.06,
        contractSnapshot: {
            organizerFeeRate: 0.05,
            winnerPercentage: 0.95
        }
    });

    const gameId = "audit_contract_fee";

    const { configuration, winner, payment } = prepareCompletedPayment(
        stack,
        gameId
    );

    const result = stack.verifier.verifyPayment(payment, winner, configuration);

    assert.equal(result.passed, true);
    assert.equal(payment.platformFee, 3.75);
    assert.equal(payment.winnerAmount, 71.25);

    stack.shutdown();

});

test("R17.9J.2I.3 frozen economy audit uses economy fee without contract", () => {

    const stack = createAuditFeeStack({
        platformFeeRate: 0.06
    });

    const gameId = "audit_economy_fee";

    configureCatalogFee(stack.catalog, 0.05);

    const { configuration, winner, payment } = prepareCompletedPayment(
        stack,
        gameId,
        { freezeEconomy: true }
    );

    configureCatalogFee(stack.catalog, 0.06);

    const result = stack.verifier.verifyPayment(payment, winner, configuration);

    assert.equal(result.passed, true);
    assert.equal(payment.platformFee, 3.75);
    assert.equal(payment.winnerAmount / payment.totalPrize, 0.95);

    stack.shutdown();

});

test("R17.9J.2I.3 runtime catalog change after freeze does not break audit", () => {

    const stack = createAuditFeeStack({
        platformFeeRate: 0.05
    });

    const gameId = "audit_runtime_change";

    const { configuration, winner, payment } = prepareCompletedPayment(
        stack,
        gameId,
        { freezeEconomy: true }
    );

    configureCatalogFee(stack.catalog, 0.06);

    const result = stack.verifier.verifyPayment(payment, winner, configuration);

    assert.equal(result.passed, true);
    assert.equal(payment.winnerAmount / payment.totalPrize, 0.95);

    const staleAudit = stack.verifier.verifyPayment(
        {
            ...payment,
            platformFee: 4.5,
            winnerAmount: 70.5
        },
        winner,
        configuration
    );

    assert.equal(staleAudit.passed, false);

    stack.shutdown();

});

test("R17.9J.2I.3 new game audit uses newly frozen fee", () => {

    const stack = createAuditFeeStack({
        platformFeeRate: 0.05
    });

    const gameA = "audit_new_fee_a";
    const gameB = "audit_new_fee_b";

    const completedA = prepareCompletedPayment(stack, gameA, {
        freezeEconomy: true
    });

    configureCatalogFee(stack.catalog, 0.06);

    const completedB = prepareCompletedPayment(stack, gameB, {
        freezeEconomy: true
    });

    const resultA = stack.verifier.verifyPayment(
        completedA.payment,
        completedA.winner,
        completedA.configuration
    );

    const resultB = stack.verifier.verifyPayment(
        completedB.payment,
        completedB.winner,
        completedB.configuration
    );

    assert.equal(resultA.passed, true);
    assert.equal(resultB.passed, true);
    assert.equal(
        completedA.payment.winnerAmount / completedA.payment.totalPrize,
        0.95
    );
    assert.equal(
        completedB.payment.winnerAmount / completedB.payment.totalPrize,
        0.94
    );

    stack.shutdown();

});

console.log("auditFeeFreeze.r179j2i3.test.js: all assertions passed");
