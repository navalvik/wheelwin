import { GameCatalog } from "../catalog/GameCatalog.js";
import { PAYMENT_STATUS } from "../catalog/PaymentRules.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { ConfigurationEngine } from "../engines/ConfigurationEngine.js";
import { PaymentEngine } from "../engines/PaymentEngine.js";
import { PhysicsEngine } from "../engines/PhysicsEngine.js";
import { WinnerEngine } from "../engines/WinnerEngine.js";
import { LoggerService } from "../services/LoggerService.js";
import { RandomService } from "../services/RandomService.js";
import { TelegramWalletAdapter } from "../services/telegram/TelegramWalletAdapter.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

const logger = new LoggerService();

logger.initialize();

const catalog = new GameCatalog({ logger });

catalog.initialize();

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

const telegramWalletAdapter = new TelegramWalletAdapter({ logger });

const paymentEngine = new PaymentEngine({
    logger,
    eventBus,
    winnerEngine,
    configurationEngine,
    gameCatalog: catalog,
    telegramWalletAdapter
});

paymentEngine.initialize();

const gameId = "payment-test-game";

configurationEngine.generateConfiguration(
    gameId,
    { roomId: "payment-room", stake: 10 },
    [
        { playerId: "player-1", sectorCount: 2 },
        { playerId: "player-2", sectorCount: 2 },
        { playerId: "player-3", sectorCount: 2 }
    ]
);

physicsEngine.createSimulation(gameId);

physicsEngine.startSimulation(gameId);

physicsEngine.stopSimulation(gameId);

const gameResult = winnerEngine.resolveResult(gameId);

const emitted = [];

for (const type of [
    EVENT_TYPES.PAYMENT_PREPARED,
    EVENT_TYPES.PAYMENT_STARTED,
    EVENT_TYPES.PAYMENT_COMPLETED
]) {

    eventBus.subscribe(type, (envelope) => {

        if (envelope.payload.gameId === gameId) {

            emitted.push(type);

        }

    });

}

const prepared = paymentEngine.preparePayment(gameId);

assert(prepared.totalPrize === 75, "total prize should be 25 * 3 players");

assert(prepared.platformFee === 7.5, "platform fee should be 10%");

assert(prepared.winnerAmount === 67.5, "winner amount should be deterministic");

const payment = paymentEngine.processPayment(gameId);

assert(
    payment.winnerId === gameResult.winningPlayer.playerId,
    "payment winner should match game result"
);

assert(
    payment.paymentStatus === PAYMENT_STATUS.COMPLETED,
    "payment should be completed"
);

assert(Object.isFrozen(payment), "payment result should be frozen");

let duplicateRejected = false;

try {

    paymentEngine.processPayment(gameId);

} catch {

    duplicateRejected = true;

}

assert(duplicateRejected, "duplicate payment should be rejected");

assert(
    emitted.includes(EVENT_TYPES.PAYMENT_PREPARED),
    "PAYMENT_PREPARED should be emitted"
);

assert(
    emitted.includes(EVENT_TYPES.PAYMENT_STARTED),
    "PAYMENT_STARTED should be emitted"
);

assert(
    emitted.includes(EVENT_TYPES.PAYMENT_COMPLETED),
    "PAYMENT_COMPLETED should be emitted"
);

assert(
    paymentEngine.getPaymentStatus(gameId) === PAYMENT_STATUS.COMPLETED,
    "payment status should be completed"
);

paymentEngine.removePayment(gameId);

assert(
    paymentEngine.getPayment(gameId) === null,
    "payment should be removed"
);

winnerEngine.removeResult(gameId);

configurationEngine.removeConfiguration(gameId);

physicsEngine.removeSimulation(gameId);

paymentEngine.shutdown();

winnerEngine.shutdown();

configurationEngine.shutdown();

physicsEngine.shutdown();

randomService.shutdown();

logger.info("PaymentEngine tests passed");
