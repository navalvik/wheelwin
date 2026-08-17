/**
 * R17.9J.2I.2B — Frozen economy for no-contract games.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { GameCatalog } from "../catalog/GameCatalog.js";
import { PAYMENT_RULES } from "../catalog/PaymentRules.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { ConfigurationEngine } from "../engines/ConfigurationEngine.js";
import { PaymentEngine } from "../engines/PaymentEngine.js";
import { resolveGameFinancialRules } from "../engines/payment/resolveGameFinancialRules.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { RecoveryEngine } from "../engines/RecoveryEngine.js";
import { WinnerEngine } from "../engines/WinnerEngine.js";
import { InputAuthority } from "../input/InputAuthority.js";
import { PlayerManager } from "../managers/PlayerManager.js";
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

function emitGameInitialized(eventBus, gameId, roomId = "no-contract-room") {

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

function createNoContractStack(platformFeeRate = 0.05) {

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

    randomService.setSeed(17);

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

    const paymentEngine = new PaymentEngine({
        logger,
        eventBus,
        winnerEngine,
        configurationEngine,
        gameCatalog: catalog,
        gameContractManager: { getContractByGameId: () => null },
        telegramWalletAdapter: new TelegramWalletAdapter({ logger })
    });

    paymentEngine.initialize();

    return {
        catalog,
        configurationEngine,
        eventBus,
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
        { roomId: "no-contract-room", stake: 10 },
        createStandardConfigurationPlayers([
            "player-1",
            "player-2",
            "player-3"
        ])
    );

    emitGameInitialized(stack.eventBus, gameId);

    stack.physicsEngine.createSimulation(gameId);
    stack.physicsEngine.startSimulation(gameId);
    stack.physicsEngine.stopSimulation(gameId);
    stack.winnerEngine.resolveResult(gameId);

}

test("R17.9J.2I.2B freezes economy on GAME_INITIALIZED", () => {

    const stack = createNoContractStack(0.05);
    const gameId = "no_contract_a";

    stack.configurationEngine.generateConfiguration(
        gameId,
        { roomId: "no-contract-room", stake: 10 },
        createStandardConfigurationPlayers([
            "player-1",
            "player-2",
            "player-3"
        ])
    );

    assert.equal(stack.configurationEngine.getEconomy(gameId), null);

    emitGameInitialized(stack.eventBus, gameId);

    const economy = stack.configurationEngine.getEconomy(gameId);

    assert.equal(economy.ownerFeePercent, 5);
    assert.equal(economy.organizerFeeRate, 0.05);
    assert.equal(economy.winnerPercentage, 0.95);
    assert.ok(Number.isFinite(economy.frozenAt));

    stack.shutdown();

});

test("R17.9J.2I.2B runtime catalog change after freeze does not affect payment", () => {

    const stack = createNoContractStack(0.05);
    const gameId = "no_contract_b";

    prepareGameResult(stack, gameId);

    configureCatalogFee(stack.catalog, 0.06);

    const prepared = stack.paymentEngine.preparePayment(gameId);

    assert.equal(prepared.platformFee, 3.75);
    assert.equal(prepared.winnerAmount, 71.25);
    assert.equal(prepared.winnerAmount / prepared.totalPrize, 0.95);

    stack.shutdown();

});

test("R17.9J.2I.2B new game picks up runtime fee after prior game frozen", () => {

    const stack = createNoContractStack(0.05);
    const gameA = "no_contract_c_a";
    const gameB = "no_contract_c_b";

    prepareGameResult(stack, gameA);

    configureCatalogFee(stack.catalog, 0.06);

    prepareGameResult(stack, gameB);

    const preparedA = stack.paymentEngine.preparePayment(gameA);
    const preparedB = stack.paymentEngine.preparePayment(gameB);

    assert.equal(preparedA.winnerAmount / preparedA.totalPrize, 0.95);
    assert.equal(preparedB.winnerAmount / preparedB.totalPrize, 0.94);

    stack.shutdown();

});

test("R17.9J.2I.2B resolver priority contract over economy over catalog", () => {

    const catalogRules = {
        ...PAYMENT_RULES,
        platformFeeRate: 0.07,
        contributionByStake: { ...PAYMENT_RULES.contributionByStake }
    };

    const gameCatalog = {
        getPaymentRules() {

            return catalogRules;

        }
    };

    const configurationEngine = {
        getEconomy(gameId) {

            if (gameId === "priority_game") {

                return Object.freeze({
                    ownerFeePercent: 5,
                    organizerFeeRate: 0.05,
                    winnerPercentage: 0.95,
                    frozenAt: Date.now()
                });

            }

            return null;

        }
    };

    const contractResolved = resolveGameFinancialRules("priority_game", {
        gameContractManager: {
            getContractByGameId: () => ({
                snapshot: Object.freeze({
                    organizerFeeRate: 0.04,
                    winnerPercentage: 0.96
                })
            })
        },
        configurationEngine,
        gameCatalog
    });

    assert.equal(contractResolved.source, "contract");
    assert.equal(contractResolved.paymentRules.platformFeeRate, 0.04);

    const economyResolved = resolveGameFinancialRules("priority_game", {
        gameContractManager: { getContractByGameId: () => null },
        configurationEngine,
        gameCatalog
    });

    assert.equal(economyResolved.source, "economy");
    assert.equal(economyResolved.paymentRules.platformFeeRate, 0.05);

    const catalogResolved = resolveGameFinancialRules("priority_game", {
        gameContractManager: { getContractByGameId: () => null },
        configurationEngine: { getEconomy: () => null },
        gameCatalog
    });

    assert.equal(catalogResolved.source, "catalog");
    assert.equal(catalogResolved.paymentRules.platformFeeRate, 0.07);

});

test("R17.9J.2I.2B frozen economy survives recovery read", () => {

    const logger = new LoggerService();

    logger.initialize();

    const catalog = new GameCatalog({ logger });

    catalog.initialize();

    configureCatalogFee(catalog, 0.05);

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const randomService = new RandomService({ logger });

    randomService.initialize();

    randomService.setSeed(23);

    const configurationEngine = new ConfigurationEngine({
        logger,
        eventBus,
        gameCatalog: catalog,
        randomService
    });

    configurationEngine.initialize();

    const gameStateEngine = {
        getState: () => null,
        getDebugSnapshot: () => null,
        getHistory: () => []
    };

    const gameClock = {
        getClock: () => null,
        getElapsed: () => 0,
        getRemaining: () => 0
    };

    const physicsEngine = new PhysicsEngine({
        logger,
        eventBus,
        gameClock: null
    });

    physicsEngine.initialize();

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

    const inputAuthority = new InputAuthority({
        logger,
        eventBus,
        gameCatalog: catalog,
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
        gameCatalog: catalog
    });

    winnerEngine.initialize();

    const paymentEngine = new PaymentEngine({
        logger,
        eventBus,
        winnerEngine,
        configurationEngine,
        gameCatalog: catalog,
        gameContractManager: { getContractByGameId: () => null },
        telegramWalletAdapter: new TelegramWalletAdapter({ logger })
    });

    paymentEngine.initialize();

    const recoveryEngine = new RecoveryEngine({
        logger,
        eventBus,
        gameCatalog: catalog,
        configurationEngine,
        gameStateEngine,
        gameClock,
        physicsEngine,
        inputAuthority,
        winnerEngine,
        paymentEngine
    });

    recoveryEngine.initialize();

    const gameId = "no_contract_recovery";

    const stack = {
        catalog,
        configurationEngine,
        eventBus,
        physicsEngine,
        winnerEngine,
        paymentEngine
    };

    prepareGameResult(stack, gameId);

    const frozenEconomy = configurationEngine.getEconomy(gameId);

    assert.equal(frozenEconomy.ownerFeePercent, 5);

    configureCatalogFee(catalog, 0.06);

    const recoveryDebug = recoveryEngine.getDebugSnapshot(gameId);

    assert.equal(recoveryDebug.configurationLoaded, true);

    const restoredEconomy = configurationEngine.getEconomy(gameId);

    assert.equal(restoredEconomy.ownerFeePercent, 5);
    assert.equal(restoredEconomy.organizerFeeRate, 0.05);

    const resolved = resolveGameFinancialRules(gameId, {
        gameContractManager: { getContractByGameId: () => null },
        configurationEngine,
        gameCatalog: catalog
    });

    assert.equal(resolved.source, "economy");
    assert.equal(resolved.paymentRules.platformFeeRate, 0.05);

    recoveryEngine.shutdown();
    paymentEngine.shutdown();
    winnerEngine.shutdown();
    inputAuthority.shutdown();
    playerManager.shutdown();
    physicsEngine.shutdown();
    configurationEngine.shutdown();
    randomService.shutdown();

});

console.log("paymentFeeFreeze.noContract.r179j2i2b.test.js: all assertions passed");
