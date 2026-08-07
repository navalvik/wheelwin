/**
 * R7.69C — GameEscrow cancel/refund E2E-style integration (backend observation).
 *
 * Deploy → INIT → OPEN → Partial STAKE → EMERGENCY_CANCEL → Refunds →
 * chain confirm → CANCELLED (monitor + PaymentSession sync).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { BlockchainMonitor } from "../payment/BlockchainMonitor.js";
import { MockTonTransport } from "../payment/ton/MockTonTransport.js";
import { GAME_CONTRACT_STATUS } from "../models/GameContract.js";
import {
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS
} from "../models/PaymentSession.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";

function friendlyAddress(seedLabel) {

    const seed = createHash("sha256").update(seedLabel).digest();
    const keyPair = keyPairFromSeed(seed);

    return WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    }).address.toString({ bounceable: true, urlSafe: true });

}

function createLogger() {

    return {
        info() {},
        warn() {},
        error() {},
        debug() {},
        startupLine() {},
        decisionTrace() {}
    };

}

async function main() {

    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();

    const escrow = friendlyAddress("e2e-cancel-escrow");
    const p0 = friendlyAddress("e2e-p0");
    const p1 = friendlyAddress("e2e-p1");
    const p2 = friendlyAddress("e2e-p2");
    const wallet = friendlyAddress("e2e-shared-wallet");

    let cancelled = false;
    let refundMask = 0;
    let paidMask = 0;

    const adapter = {
        async getPaidMask() {

            return paidMask;

        },
        async getTotalPaid() {

            return BigInt(
                (paidMask & 1 ? 10 : 0)
                + (paidMask & 2 ? 10 : 0)
                + (paidMask & 4 ? 10 : 0)
            );

        },
        async getRequiredTotal() {

            return 30n;

        },
        async getPlayerPayment(_address, index) {

            const wallets = [p0, p1, p2];

            return {
                index,
                wallet: wallets[index],
                requiredStake: 10n,
                paid: (paidMask & (1 << index)) !== 0
            };

        },
        async getCancelStatus() {

            return {
                cancelled,
                cancelReason: cancelled ? 7 : 0,
                refundMask
            };

        },
        async getRefundMask() {

            return refundMask;

        },
        async getRefundedTotal() {

            return BigInt(
                (refundMask & 1 ? 10 : 0)
                + (refundMask & 2 ? 10 : 0)
                + (refundMask & 4 ? 10 : 0)
            );

        }
    };

    const transport = new MockTonTransport();

    const monitor = new BlockchainMonitor({
        logger,
        eventBus,
        transport,
        contractAdapter: adapter,
        pollIntervalMs: 50_000
    });

    monitor.initialize();
    await monitor.start();

    const identities = new Map([
        ["p1", { baseStake: 10, sectorCount: 1 }],
        ["p2", { baseStake: 10, sectorCount: 1 }],
        ["p3", { baseStake: 10, sectorCount: 1 }]
    ]);

    const manager = new PaymentSessionManager({
        logger,
        eventBus,
        playerManager: {
            getIdentity(playerId) {

                return identities.get(playerId) ?? null;

            }
        },
        roomManager: {
            getRoom(roomId) {

                if (roomId !== "room-e2e-cancel") {

                    return null;

                }

                return { players: ["p1", "p2", "p3"] };

            }
        },
        roomConfig: { paymentSessionDurationMs: 60_000 },
        gameplayContextResolver: {
            resolveGameIdByRoomId(roomId) {

                return roomId === "room-e2e-cancel" ? "game-e2e-cancel" : null;

            }
        },
        sessionWalletStore: {
            getWallet() {

                return wallet;

            }
        },
        walletManager: {
            getWalletByPlayer(playerId, roomId) {

                if (roomId !== "room-e2e-cancel") {

                    return null;

                }

                return {
                    walletSessionId: `ws_${playerId}`,
                    playerId,
                    roomId,
                    walletAddress: playerId === "p1"
                        ? p0
                        : playerId === "p2"
                            ? p1
                            : p2,
                    status: "VERIFIED",
                    network: "testnet"
                };

            }
        },
        blockchainMonitor: monitor,
        gameContractManager: {
            getContract(roomId) {

                if (roomId !== "room-e2e-cancel") {

                    return null;

                }

                return {
                    contractId: "c-e2e",
                    roomId,
                    gameId: "game-e2e-cancel",
                    status: GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS,
                    contractAddress: escrow,
                    tonNetwork: "testnet",
                    gameStartedAt: null
                };

            }
        },
        tonNetwork: "testnet"
    });

    manager.initialize();

    // OPEN_PAYMENTS equivalent — create payment session.
    manager.createPaymentSession("room-e2e-cancel", {
        contractAddress: escrow
    });

    const session = manager.getSession("room-e2e-cancel");
    session.findParticipant("p1").playerIndex = 0;
    session.findParticipant("p2").playerIndex = 1;
    session.findParticipant("p3").playerIndex = 2;

    // Partial STAKE — only p1 + p2 paid on-chain.
    paidMask = 0b011;
    await manager.syncFromGameEscrow("room-e2e-cancel");

    assert.equal(
        session.findParticipant("p1").status,
        PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
    );
    assert.equal(
        session.findParticipant("p2").status,
        PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
    );
    assert.equal(
        session.findParticipant("p3").status,
        PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION
    );

    // EMERGENCY_CANCEL + refunds on chain.
    cancelled = true;
    refundMask = 0b011;

    transport.seedTransactions(escrow, [
        {
            transaction_id: { hash: "e2e-cancel-tx" },
            out_msgs: [
                { destination: p0, value: String(10 * 1e9) },
                { destination: p1, value: String(10 * 1e9) }
            ]
        }
    ]);

    const refundEvents = [];
    eventBus.subscribe(EVENT_TYPES.GAME_ESCROW_REFUND_CONFIRMED, (envelope) => {
        refundEvents.push(envelope.payload);
    });

    monitor.watchGameEscrowRefunds({
        escrowAddress: escrow,
        cancelTxHash: "e2e-cancel-tx",
        refunds: [
            { playerIndex: 0, playerId: "p1", wallet: p0, amount: 10 },
            { playerIndex: 1, playerId: "p2", wallet: p1, amount: 10 }
        ],
        expectedRefundMask: 0b011,
        contractStatus: 9,
        roomId: "room-e2e-cancel",
        gameId: session.gameId,
        contractId: "c-e2e"
    });

    const watch = [...monitor._gameEscrowRefunds.values()][0];
    await monitor._observeGameEscrowRefunds(watch);

    assert.equal(watch.status, "CONFIRMED");
    assert.equal(refundEvents.length, 2);

    // Sync CANCELLED from GameEscrow authority.
    const sync = await manager.syncFromGameEscrow("room-e2e-cancel");

    assert.equal(sync.cancelled, true);
    assert.equal(
        manager.getSession("room-e2e-cancel").status,
        PAYMENT_SESSION_STATUS.CANCELLED
    );
    assert.equal(session.findParticipant("p1").refunded, true);
    assert.equal(session.findParticipant("p2").refunded, true);
    assert.equal(session.findParticipant("p3").refunded, false);

    // Duplicate reconnect / re-sync must not double-fire.
    const refundCountBefore = refundEvents.length;
    await monitor._observeGameEscrowRefunds(watch);
    assert.equal(refundEvents.length, refundCountBefore);

    const again = await manager.syncFromGameEscrow("room-e2e-cancel");
    assert.equal(again.refundSynced, 0);

    manager.shutdown();
    monitor.shutdown();
    eventBus.shutdown();

    console.log("gameEscrowCancelE2E.test.js: all assertions passed");

}

main().catch((error) => {

    console.error(error);
    process.exit(1);

});
