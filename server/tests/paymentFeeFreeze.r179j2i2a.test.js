/**
 * R17.9J.2I.2A — PaymentEngine per-game fee freeze integration tests.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { GameCatalog } from "../catalog/GameCatalog.js";
import { PAYMENT_RULES } from "../catalog/PaymentRules.js";
import { EventBus } from "../events/EventBus.js";
import { ConfigurationEngine } from "../engines/ConfigurationEngine.js";
import { PaymentEngine } from "../engines/PaymentEngine.js";
import { PaymentValidationError } from "../engines/payment/PaymentValidationError.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { WinnerEngine } from "../engines/WinnerEngine.js";
import { LoggerService } from "../services/LoggerService.js";
import { RandomService } from "../services/RandomService.js";
import { TelegramWalletAdapter } from "../services/telegram/TelegramWalletAdapter.js";
import { createStandardConfigurationPlayers } from "./helpers/configurationPlayers.js";

function createPaymentStack({
    platformFeeRate = 0.05,
    contractSnapshot = null
} = {}) {

    const logger = new LoggerService();

    logger.initialize();

    const catalog = new GameCatalog({ logger });

    catalog.initialize();

    if (platformFeeRate !== PAYMENT_RULES.platformFeeRate) {

        catalog.configurePaymentRules({
            ...PAYMENT_RULES,
            platformFeeRate,
            contributionByStake: {
                ...PAYMENT_RULES.contributionByStake
            }
        });

    }

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const randomService = new RandomService({ logger });

    randomService.initialize();

    randomService.setSeed(7);

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

    return {
        catalog,
        configurationEngine,
        physicsEngine,
        winnerEngine,
        paymentEngine,
        shutdown() {

            paymentEngine.shutdown();
            winnerEngine.shutdown();
            configurationEngine.shutdown();
            physicsEngine.shutdown();
            randomService.shutdown();

        }
    };

}

function prepareGameResult(stack, gameId) {

    stack.configurationEngine.generateConfiguration(
        gameId,
        { roomId: "fee-freeze-room", stake: 10 },
        createStandardConfigurationPlayers([
            "player-1",
            "player-2",
            "player-3"
        ])
    );

    stack.physicsEngine.createSimulation(gameId);
    stack.physicsEngine.startSimulation(gameId);
    stack.physicsEngine.stopSimulation(gameId);
    stack.winnerEngine.resolveResult(gameId);

}

test("R17.9J.2I.2A contract snapshot overrides live catalog", () => {

    const stack = createPaymentStack({
        platformFeeRate: 0.06,
        contractSnapshot: {
            organizerFeeRate: 0.05,
            winnerPercentage: 0.95
        }
    });

    const gameId = "game_fee_freeze_a";

    prepareGameResult(stack, gameId);

    const prepared = stack.paymentEngine.preparePayment(gameId);

    assert.equal(prepared.totalPrize, 75);
    assert.equal(prepared.platformFee, 3.75);
    assert.equal(prepared.winnerAmount, 71.25);
    assert.equal(
        prepared.winnerAmount / prepared.totalPrize,
        0.95
    );

    stack.shutdown();

});

test("R17.9J.2I.2A new game uses new contract fee rate", () => {

    const stack = createPaymentStack({
        platformFeeRate: 0.05,
        contractSnapshot: {
            organizerFeeRate: 0.06,
            winnerPercentage: 0.94
        }
    });

    const gameId = "game_fee_freeze_b";

    prepareGameResult(stack, gameId);

    const prepared = stack.paymentEngine.preparePayment(gameId);

    assert.equal(prepared.totalPrize, 75);
    assert.equal(prepared.platformFee, 4.5);
    assert.equal(prepared.winnerAmount, 70.5);
    assert.equal(
        prepared.winnerAmount / prepared.totalPrize,
        0.94
    );

    stack.shutdown();

});

test("R17.9J.2I.2A existing game keeps frozen fee after runtime catalog change", () => {

    const stack = createPaymentStack({
        platformFeeRate: 0.05,
        contractSnapshot: {
            organizerFeeRate: 0.05,
            winnerPercentage: 0.95
        }
    });

    const gameId = "game_fee_freeze_c";

    prepareGameResult(stack, gameId);

    stack.catalog.configurePaymentRules({
        ...PAYMENT_RULES,
        platformFeeRate: 0.06,
        contributionByStake: {
            ...PAYMENT_RULES.contributionByStake
        }
    });

    const prepared = stack.paymentEngine.preparePayment(gameId);

    assert.equal(prepared.platformFee, 3.75);
    assert.equal(prepared.winnerAmount, 71.25);

    stack.shutdown();

});

test("R17.9J.2I.2A resolver failure preserves existing payment validation errors", () => {

    const stack = createPaymentStack({
        platformFeeRate: 0.06,
        contractSnapshot: {
            organizerFeeRate: 0.05,
            winnerPercentage: 0.95
        }
    });

    assert.throws(
        () => stack.paymentEngine.preparePayment("missing-game"),
        (error) => error instanceof PaymentValidationError
    );

    const gameId = "game_fee_freeze_d";

    prepareGameResult(stack, gameId);

    const first = stack.paymentEngine.preparePayment(gameId);

    assert.equal(first.platformFee, 3.75);

    const second = stack.paymentEngine.preparePayment(gameId);

    assert.equal(second.platformFee, 3.75);
    assert.equal(second.winnerAmount, first.winnerAmount);

    stack.shutdown();

});

console.log("paymentFeeFreeze.r179j2i2a.test.js: all assertions passed");
