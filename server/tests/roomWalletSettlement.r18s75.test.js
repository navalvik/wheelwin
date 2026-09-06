/**
 * R18-S75 — Room Wallet bounce must not credit; FULLY_PAID must complete
 * GameContract so Room Wallet settlement can run. No chain sends.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS
} from "../models/PaymentSession.js";
import { GAME_CONTRACT_STATUS, GameContract } from "../models/GameContract.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";
import {
    isBouncedTonTransaction,
    isFailedTonTransaction
} from "../payment/BlockchainMonitor.js";
import { RoomWalletRegistry } from "../payment/roomWallet/RoomWalletRegistry.js";
import {
    ROOM_WALLET_INCOMING_REJECTION_REASONS,
    RoomWalletIncomingObserver
} from "../payment/roomWallet/RoomWalletIncomingObserver.js";
import { RoomWalletLedgerRegistry } from "../payment/roomWallet/RoomWalletLedger.js";
import { EntryPaymentAuditLedger } from "../payment/BlockchainMonitor.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import {
    composeRoomWalletSettlementRouter
} from "../payment/roomWallet/roomWalletConfig.js";
import { RoomWalletSettlementAdapter } from "../payment/roomWallet/RoomWalletSettlementAdapter.js";
import { createDummyRoomWalletEntry } from "./helpers/dummyRoomWallet.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WALLET = createDummyRoomWalletEntry(1);

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

function createLogger() {
    return {
        info() {},
        warn() {},
        error() {},
        debug() {},
        decisionTrace() {},
        startupLine() {}
    };
}

function inboundTx({ hash, from, to, nanoton, lt = "100", bounced = false }) {
    const tx = {
        transaction_id: { hash, lt },
        aborted: false,
        in_msg: {
            source: from,
            destination: to,
            value: String(nanoton)
        }
    };

    if (bounced) {
        tx.out_msgs = [{
            source: to,
            destination: from,
            value: "999933333",
            message: "/////w==\n"
        }];
    }

    return tx;
}

function createIntake({ roomWallet, players, roomId = "RGFT" }) {
    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();

    const persistence = new TonFinancialPersistence({
        dataDir: mkdtempSync(join(tmpdir(), "ww-s75-")),
        logger
    });
    persistence.initialize();

    const identities = new Map();
    const wallets = new Map();

    for (const player of players) {
        identities.set(player.playerId, { baseStake: 1, sectorCount: 1 });
        wallets.set(`${roomId}:${player.playerId}`, player.wallet);
    }

    const roomManager = {
        getRoom() {
            return {
                players: players.map((player) => player.playerId),
                roomId,
                roomNumber: 1
            };
        },
        resolveRoomNumber() {
            return 1;
        }
    };

    const manager = new PaymentSessionManager({
        logger,
        eventBus,
        playerManager: {
            getIdentity(playerId) {
                return identities.get(playerId) ?? null;
            }
        },
        roomManager,
        roomConfig: { paymentSessionDurationMs: 60_000 },
        gameplayContextResolver: {
            resolveGameIdByRoomId() {
                return "game_4f1dee88-f9f8-4f47-8fe4-fb3b93a1990d";
            }
        },
        sessionWalletStore: {
            getWallet(_roomId, playerId) {
                return wallets.get(`${roomId}:${playerId}`) ?? null;
            }
        },
        financialPersistence: persistence,
        durationMs: 60_000,
        roomWalletPaymentIntakeEnabled: true
    });

    manager.initialize();
    manager.setRoomWalletFinance({
        registry: new RoomWalletRegistry({
            entries: [{ roomNumber: 1, address: roomWallet }]
        }),
        roomWalletPaymentIntakeEnabled: true
    });

    const observer = new RoomWalletIncomingObserver({
        logger,
        eventBus,
        paymentSessionManager: manager,
        financialPersistence: persistence,
        registry: new RoomWalletRegistry({
            entries: [{ roomNumber: 1, address: roomWallet }]
        }),
        roomManager,
        ledgerRegistry: new RoomWalletLedgerRegistry(),
        auditLedger: new EntryPaymentAuditLedger(),
        network: "testnet"
    });

    manager.createPaymentSession(roomId, {
        gameId: "game_4f1dee88-f9f8-4f47-8fe4-fb3b93a1990d",
        network: "testnet"
    });

    return { eventBus, manager, observer };
}

test("TonCenter bounce is a failed transaction and is not a credit", () => {
    const bounced = {
        in_msg: {
            source: "EQsender",
            destination: "EQdest",
            value: "1000000000"
        },
        out_msgs: [{
            source: "EQdest",
            destination: "EQsender",
            value: "999933333",
            message: "/////w==\n"
        }]
    };

    assert.equal(isBouncedTonTransaction(bounced), true);
    assert.equal(isFailedTonTransaction(bounced), true);
    assert.equal(isFailedTonTransaction({ in_msg: bounced.in_msg }), false);
});

test("three valid Room Wallet payments complete the session once each", () => {
    const roomWallet = friendlyAddress("s75-rw");
    const players = [
        { playerId: "olga", wallet: friendlyAddress("s75-olga") },
        { playerId: "lena", wallet: friendlyAddress("s75-lena") },
        { playerId: "bob", wallet: friendlyAddress("s75-bob") }
    ];
    const { manager, observer, eventBus } = createIntake({ roomWallet, players });

    const hashes = ["tx-olga", "tx-lena", "tx-bob"];

    for (let index = 0; index < players.length; index += 1) {
        const result = observer.processTransaction(inboundTx({
            hash: hashes[index],
            from: players[index].wallet,
            to: roomWallet,
            nanoton: 1_000_000_000,
            lt: String(100 + index)
        }), roomWallet);

        assert.equal(result.credited, true);
        assert.equal(result.playerId, players[index].playerId);
    }

    const session = manager.getSession("RGFT");
    assert.equal(session.status, PAYMENT_SESSION_STATUS.FULLY_PAID);
    assert.equal(session.participants.every(
        (participant) => participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
    ), true);
    assert.equal(new Set(session.participants.map((p) => p.txHash)).size, 3);

    const duplicate = observer.processTransaction(inboundTx({
        hash: "tx-olga",
        from: players[0].wallet,
        to: roomWallet,
        nanoton: 1_000_000_000
    }), roomWallet);

    assert.equal(duplicate.credited, false);
    assert.equal(
        duplicate.reason,
        ROOM_WALLET_INCOMING_REJECTION_REASONS.DUPLICATE_TRANSACTION
    );

    manager.shutdown();
    eventBus.shutdown();
});

test("bounced inbound is not counted as a player payment", () => {
    const roomWallet = friendlyAddress("s75-rw-b");
    const players = [
        { playerId: "bob", wallet: friendlyAddress("s75-bob-b") },
        { playerId: "olga", wallet: friendlyAddress("s75-olga-b") },
        { playerId: "lena", wallet: friendlyAddress("s75-lena-b") }
    ];
    const { manager, observer, eventBus } = createIntake({ roomWallet, players });

    const result = observer.processTransaction(inboundTx({
        hash: "tx-bob-bounce",
        from: players[0].wallet,
        to: roomWallet,
        nanoton: 1_000_000_000,
        bounced: true
    }), roomWallet);

    assert.equal(result.credited, false);
    assert.equal(
        result.reason,
        ROOM_WALLET_INCOMING_REJECTION_REASONS.FAILED_TRANSACTION
    );

    const session = manager.getSession("RGFT");
    assert.notEqual(session.status, PAYMENT_SESSION_STATUS.FULLY_PAID);
    assert.notEqual(
        session.findParticipant("bob").status,
        PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
    );

    manager.shutdown();
    eventBus.shutdown();
});

test("AWAITING_PAYMENTS cannot jump to SETTLEMENT_PREPARING", () => {
    const contract = new GameContract({
        contractId: "contract_b1119300-6c0d-4364-b990-60a11c425459",
        gameId: "game_4f1dee88-f9f8-4f47-8fe4-fb3b93a1990d",
        roomId: "RGFT",
        status: GAME_CONTRACT_STATUS.CREATED
    });

    assert.equal(contract.transitionTo(GAME_CONTRACT_STATUS.AWAITING_PAYMENTS), true);
    assert.equal(
        contract.canTransitionTo(GAME_CONTRACT_STATUS.SETTLEMENT_PREPARING),
        false
    );
    assert.equal(contract.transitionTo(GAME_CONTRACT_STATUS.SETTLEMENT_PREPARING), false);
    assert.equal(contract.status, GAME_CONTRACT_STATUS.AWAITING_PAYMENTS);
    assert.equal(contract.transitionTo(GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE), true);
    assert.equal(contract.transitionTo(GAME_CONTRACT_STATUS.SETTLEMENT_PREPARING), true);
});

test("game-mode settlement uses Room Wallet adapter, not Game Escrow", () => {
    const escrowCalls = [];
    const router = composeRoomWalletSettlementRouter({
        legacySettlementAdapter: {
            async settleContract(request) {
                escrowCalls.push(request);
                return { ok: true, adapter: "escrow" };
            }
        },
        tonService: {},
        logger: createLogger(),
        env: { ROOM_WALLETS_JSON: JSON.stringify([WALLET]) },
        gameEscrowMode: "game"
    });

    assert.equal(router.isEnabled(), true);
    assert.notEqual(router.activeAdapter, router._legacySettlementAdapter);
    assert.equal(escrowCalls.length, 0);
});

test("Room Wallet settlement constructs winner and owner payouts without Game Escrow", async () => {
    const transfers = [];
    const adapter = new RoomWalletSettlementAdapter({
        roomWalletAdapter: {
            getGasReserveNano() {
                return 3_000_000n;
            },
            async getBalance() {
                return 10_000_000_000n;
            },
            async sendTransfer(input) {
                transfers.push(input);
                return { ok: true, code: "SENT", txHash: `tx-${transfers.length}` };
            }
        }
    });

    const result = await adapter.settleContract({
        roomNumber: 1,
        winnerWallet: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
        ownerWallet: "EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBK",
        prizeAmount: 2.85,
        organizerAmount: 0.15
    });

    assert.equal(result.ok, true);
    assert.equal(transfers.length, 2);
    assert.equal(transfers[0].destination, "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c");
    assert.equal(transfers[1].destination, "EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBK");
    assert.equal(transfers[0].amountNano, 2_850_000_000n);
    assert.equal(transfers[1].amountNano, 140_000_000n);
});

test("legacy financial paths stay blocked in game-mode wiring", () => {
    const entry = readFileSync(
        join(HERE, "../../client/src/payment/buildEntryPaymentTransaction.js"),
        "utf8"
    );
    const psm = readFileSync(join(HERE, "../gameplay/PaymentSessionManager.js"), "utf8");
    const gsa = readFileSync(join(HERE, "../gameplay/GameStartAuthorization.js"), "utf8");
    const app = readFileSync(join(HERE, "../app.js"), "utf8");
    const observer = readFileSync(
        join(HERE, "../payment/roomWallet/RoomWalletIncomingObserver.js"),
        "utf8"
    );

    assert.match(entry, /plainTransfer:\s*true/);
    assert.doesNotMatch(entry, /GAME_ESCROW_STAKE_OPCODE/);
    assert.match(psm, /roomWalletPaymentIntakeEnabled/);
    assert.match(psm, /GAME_ESCROW_STAKE_CONFIRMED/);
    assert.match(gsa, /_checkRoomWalletLedger/);
    assert.match(app, /skipBlockchainDeploy:\s*isRoomWalletOnlyFinancialPath/);
    assert.match(observer, /FAILED_TRANSACTION/);
    assert.doesNotMatch(app, /0\.011/);
});
