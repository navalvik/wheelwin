import { EntryPaymentLifecycle } from "../gameplay/EntryPaymentLifecycle.js";
import {
    ENTRY_PAYMENT_STATUS,
    ENTRY_SMART_CONTRACT_STATUS,
    EntryPaymentSession
} from "../models/EntryPaymentSession.js";
import { TelegramWalletAdapter } from "../services/telegram/TelegramWalletAdapter.js";
import { LoggerService } from "../services/LoggerService.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

const logger = new LoggerService({ logLevel: "error" });

logger.initialize();

const adapter = new TelegramWalletAdapter({ logger });

{

    const result = await adapter.simulateEntryPayment({
        roomId: "R1",
        playerId: "p1",
        wallet: "EQ" + "A".repeat(46)
    });

    assert(result.status === "completed", "stub payment completes");

    assert(result.paymentReference, "stub issues paymentReference");

    console.log("  TelegramWalletAdapter.simulateEntryPayment passed");

}

{

    const sessions = new Map();

    const lifecycle = new EntryPaymentLifecycle({
        logger,
        telegramWalletAdapter: adapter,
        playerPaymentDelayMs: 25,
        smartContractDelayMs: 25,
        applySessionUpdate: (roomId, updater) => {

            const current = sessions.get(roomId);

            if (!current) {

                return null;

            }

            const next = updater(current);

            if (!next || next === current) {

                return current;

            }

            sessions.set(roomId, next);

            return next;

        }
    });

    const initial = EntryPaymentSession.createInitial("ROOMX", [
        { playerId: "p1", wallet: "EQ1" },
        { playerId: "p2", wallet: "EQ2" },
        { playerId: "p3", wallet: "EQ3" }
    ]);

    sessions.set("ROOMX", initial);

    lifecycle.start("ROOMX", initial);

    await wait(250);

    const final = sessions.get("ROOMX");

    assert(
        final.players.every(
            (player) => player.paymentStatus === ENTRY_PAYMENT_STATUS.PAID
        ),
        "lifecycle pays all players"
    );

    assert(
        final.smartContractStatus === ENTRY_SMART_CONTRACT_STATUS.CREATED,
        "lifecycle creates smart contract"
    );

    lifecycle.shutdown();

    console.log("  EntryPaymentLifecycle simulation passed");

}

logger.shutdown();

console.log("entryPaymentLifecycle.test.js: all assertions passed");
