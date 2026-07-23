import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    BlockchainMonitor,
    EntryPaymentAuditLedger,
    amountsMatch,
    parseDepositCandidate
} from "../payment/BlockchainMonitor.js";
import { MockTonTransport } from "../payment/ton/MockTonTransport.js";

function createLogger() {

    return {
        info() {},
        error() {},
        warn() {},
        debug() {}
    };

}

function friendlyAddress(seedLabel) {

    const seed = createHash("sha256").update(seedLabel).digest();

    const keyPair = keyPairFromSeed(seed);

    return WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    }).address.toString({
        bounceable: true,
        urlSafe: true
    });

}

assert.equal(amountsMatch(10, 10), true);

assert.equal(amountsMatch(10, 9.99), false);

assert.equal(
    parseDepositCandidate({
        in_msg: {
            source: friendlyAddress("src"),
            destination: friendlyAddress("dst"),
            message: "ref_1",
            grmAmount: 10
        },
        transaction_id: { hash: "hash1" }
    }).amountGram,
    10
);

{
    const logger = createLogger();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const transport = new MockTonTransport();

    const audit = new EntryPaymentAuditLedger();

    const monitor = new BlockchainMonitor({
        logger,
        eventBus,
        transport,
        auditLedger: audit,
        pollIntervalMs: 50_000
    });

    monitor.initialize();

    const confirmed = [];

    const rejected = [];

    eventBus.subscribe(EVENT_TYPES.PAYMENT_BLOCKCHAIN_CONFIRMED, (envelope) => {

        confirmed.push(envelope.payload);

    });

    eventBus.subscribe(EVENT_TYPES.PAYMENT_BLOCKCHAIN_REJECTED, (envelope) => {

        rejected.push(envelope.payload);

    });

    const contractAddress = friendlyAddress("contract");

    const playerWallet = friendlyAddress("player");

    const wrongWallet = friendlyAddress("wrong");

    monitor.watchPayment({
        roomId: "room-1",
        gameId: "game-1",
        playerId: "p1",
        contractAddress,
        paymentReference: "payref_1",
        expectedGram: 10,
        expectedWallet: playerWallet
    });

    await monitor.ingestTransaction("room-1", {
        transaction_id: { hash: "tx_bad_sender" },
        in_msg: {
            source: wrongWallet,
            destination: contractAddress,
            message: "payref_1",
            grmAmount: 10
        }
    });

    assert.equal(rejected.length, 1);

    assert.equal(rejected[0].reason, "wrong_sender");

    assert.equal(confirmed.length, 0);

    await monitor.ingestTransaction("room-1", {
        transaction_id: { hash: "tx_ok" },
        in_msg: {
            source: playerWallet,
            destination: contractAddress,
            message: "payref_1",
            grmAmount: 10
        }
    });

    assert.equal(confirmed.length, 1);

    assert.equal(confirmed[0].txHash, "tx_ok");

    await monitor.ingestTransaction("room-1", {
        transaction_id: { hash: "tx_ok" },
        in_msg: {
            source: playerWallet,
            destination: contractAddress,
            message: "payref_1",
            grmAmount: 10
        }
    });

    const audits = audit.list("room-1");

    assert.ok(
        audits.some((entry) => entry.type === "DUPLICATE_PAYMENT"),
        "duplicate tx audited"
    );

    assert.equal(confirmed.length, 1, "duplicate does not re-confirm");

    monitor.shutdown();

    eventBus.shutdown();

}

console.log("blockchainMonitor.test.js: all assertions passed");
