/**
 * Room Wallet player-payment readiness → GameStartAuthorization → Page 5.
 * Deterministic mocks only. No TESTNET funds.
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
    GAME_START_PHASE,
    GameStartAuthorization
} from "../gameplay/GameStartAuthorization.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";
import { GAME_CONTRACT_STATUS } from "../models/GameContract.js";
import {
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS
} from "../models/PaymentSession.js";
import { ROOM_STATUS } from "../models/RoomStatus.js";
import { EntryPaymentAuditLedger } from "../payment/BlockchainMonitor.js";
import { GRAM_NANO } from "../payment/roomWallet/RoomWalletFinancialPolicy.js";
import {
    ROOM_LEDGER_ENTRY_TYPES,
    RoomWalletLedgerRegistry,
    buildRoomWalletPlayerPaymentEntryId
} from "../payment/roomWallet/RoomWalletLedger.js";
import { RoomWalletRegistry } from "../payment/roomWallet/RoomWalletRegistry.js";
import {
    RoomWalletIncomingObserver
} from "../payment/roomWallet/RoomWalletIncomingObserver.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function createLogger() {
    return {
        info() {},
        warn() {},
        error() {},
        debug() {},
        decisionTrace() {}
    };
}

function friendlyAddress(seedLabel) {
    const seed = createHash("sha256").update(seedLabel).digest();
    const keyPair = keyPairFromSeed(seed);
    return WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    }).address.toString({ bounceable: true, urlSafe: true });
}

function inboundTx({ hash, from, to, nanoton, lt = "100" }) {
    return {
        transaction_id: { hash, lt },
        aborted: false,
        in_msg: {
            source: from,
            destination: to,
            value: String(nanoton),
            message: ""
        }
    };
}

function threePlayers(prefix) {
    return [
        { playerId: `${prefix}-p1`, wallet: friendlyAddress(`${prefix}-p1`) },
        { playerId: `${prefix}-p2`, wallet: friendlyAddress(`${prefix}-p2`) },
        { playerId: `${prefix}-p3`, wallet: friendlyAddress(`${prefix}-p3`) }
    ];
}

function createPaymentContext({
    roomId,
    roomNumber,
    gameId,
    players,
    durationMs = 60_000,
    roomWalletPaymentIntakeEnabled = true
}) {
    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();
    const persistence = new TonFinancialPersistence({
        dataDir: mkdtempSync(join(tmpdir(), "ww-rw-ready-")),
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
        getRoom(id) {
            return id === roomId
                ? {
                    players: players.map((player) => player.playerId),
                    roomId,
                    roomNumber,
                    status: ROOM_STATUS.LOCKED,
                    maxPlayers: 3
                }
                : null;
        },
        resolveRoomNumber(id) {
            return id === roomId ? roomNumber : null;
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
        roomConfig: { paymentSessionDurationMs: durationMs },
        gameplayContextResolver: {
            resolveGameIdByRoomId(id) {
                return id === roomId ? gameId : null;
            }
        },
        sessionWalletStore: {
            getWallet(id, playerId) {
                return wallets.get(`${id}:${playerId}`) ?? null;
            }
        },
        financialPersistence: persistence,
        durationMs,
        roomWalletPaymentIntakeEnabled
    });
    manager.initialize();

    const ledgerRegistry = new RoomWalletLedgerRegistry();
    const roomWallet = friendlyAddress(`rw-${roomNumber}`);
    const registry = new RoomWalletRegistry({
        entries: [{ roomNumber, address: roomWallet }]
    });
    manager.setRoomWalletFinance({
        registry,
        roomWalletPaymentIntakeEnabled
    });
    const observer = new RoomWalletIncomingObserver({
        logger,
        eventBus,
        paymentSessionManager: manager,
        financialPersistence: persistence,
        registry,
        roomManager,
        ledgerRegistry,
        auditLedger: new EntryPaymentAuditLedger(),
        network: "testnet"
    });

    manager.createPaymentSession(roomId, { gameId, network: "testnet" });

    return {
        logger,
        eventBus,
        manager,
        persistence,
        roomManager,
        ledgerRegistry,
        observer,
        roomWallet,
        players,
        roomId,
        gameId
    };
}

function creditPlayer(ctx, playerIndex, hash) {
    return ctx.observer.processTransaction(inboundTx({
        hash,
        from: ctx.players[playerIndex].wallet,
        to: ctx.roomWallet,
        nanoton: 1_000_000_000
    }), ctx.roomWallet);
}

function createGsaHarness({
    gameId = "game-a",
    sessionStatus = PAYMENT_SESSION_STATUS.COMPLETED,
    confirmedCount = 3,
    roomWalletPaymentIntakeEnabled = true,
    depositState = "AWAITING_FUNDS",
    contractStatus = GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS,
    ledgerPayments = null,
    getBalance = null
}) {
    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();

    const players = ["p1", "p2", "p3"];
    const session = {
        roomId: "Keah",
        gameId,
        status: sessionStatus,
        completedAt: Date.now(),
        participants: players.map((playerId, index) => ({
            playerId,
            status: index < confirmedCount
                ? PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
                : PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED
        })),
        allConfirmed() {
            return this.participants.every((participant) => (
                participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
            ));
        }
    };

    const ledgerRegistry = new RoomWalletLedgerRegistry();
    const payments = ledgerPayments ?? (roomWalletPaymentIntakeEnabled && confirmedCount === 3
        ? players.map((playerId, index) => ({ playerId, txHash: `tx-${gameId}-${index}` }))
        : []);

    for (const payment of payments) {
        ledgerRegistry.recordPlayerPayment({
            roomId: "Keah",
            roomNumber: 17,
            gameId,
            playerId: payment.playerId,
            txHash: payment.txHash,
            amountGram: 1
        });
    }

    const collected = [];
    for (const type of [
        EVENT_TYPES.GAME_START_AUTHORIZED,
        EVENT_TYPES.GAME_INITIALIZING,
        EVENT_TYPES.GAME_START_BOOTSTRAP_READY,
        EVENT_TYPES.GAME_START_FAILED
    ]) {
        eventBus.subscribe(type, (envelope) => collected.push(envelope.type));
    }

    const balanceCalls = [];
    const auth = new GameStartAuthorization({
        logger,
        eventBus,
        roomManager: {
            getRoom(roomId) {
                return roomId === "Keah"
                    ? {
                        roomId: "Keah",
                        roomNumber: 17,
                        players,
                        status: ROOM_STATUS.LOCKED,
                        maxPlayers: 3
                    }
                    : null;
            }
        },
        playerManager: {
            getIdentity(playerId) {
                return { playerId };
            }
        },
        gameManager: {
            getGame(id) {
                return id === gameId ? { gameId: id, status: "CREATED" } : null;
            },
            getPendingGameplayGameId(roomId) {
                return roomId === "Keah" ? gameId : null;
            }
        },
        paymentSessionManager: {
            getSession(roomId) {
                return roomId === "Keah" ? session : null;
            }
        },
        gameContractManager: {
            getContract(roomId) {
                return roomId === "Keah"
                    ? {
                        roomId: "Keah",
                        gameId,
                        contractId: "c-1",
                        status: contractStatus,
                        paymentsCompletedAt: null
                    }
                    : null;
            }
        },
        configurationEngine: {
            getConfiguration(id) {
                return id === gameId
                    ? { gameId, traceSeed: "seed", players: [], sectors: [] }
                    : null;
            },
            validateConfiguration() {}
        },
        physicsEngine: {
            getSimulation(id) {
                return { gameId: id };
            }
        },
        gameClockEngine: {
            getClock(id) {
                return { gameId: id };
            }
        },
        recoveryEngine: {
            getRecoverySnapshot() {
                return null;
            }
        },
        auditLedger: new EntryPaymentAuditLedger(),
        roomConfig: { maxPlayers: 3 },
        depositSessionCoordinator: {
            getByRoomAndGame() {
                return { state: depositState };
            }
        },
        roomWalletPaymentIntakeEnabled,
        roomWalletLedgerRegistry: ledgerRegistry
    });
    auth.initialize();

    if (typeof getBalance === "function") {
        getBalance.calls = balanceCalls;
    }

    return {
        auth,
        eventBus,
        session,
        collected,
        ledgerRegistry,
        emitCompleted() {
            eventBus.emit({
                source: "test",
                type: EVENT_TYPES.PAYMENT_SESSION_COMPLETED,
                payload: { roomId: "Keah", gameId }
            });
        },
        shutdown() {
            auth.shutdown();
            eventBus.shutdown();
        }
    };
}

test("A. valid Room Wallet payment creates a game-level ledger entry", (t) => {
    const ctx = createPaymentContext({
        roomId: "Keah",
        roomNumber: 17,
        gameId: "game-a",
        players: threePlayers("a")
    });
    t.after(() => {
        ctx.observer.stop();
        ctx.manager.shutdown();
        ctx.persistence.shutdown({ checkpoint: false });
        ctx.eventBus.shutdown();
    });

    const result = creditPlayer(ctx, 0, "tx-a1");
    assert.equal(result.credited, true);

    const entries = ctx.ledgerRegistry.listPlayerPayments("game-a");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].gameId, "game-a");
    assert.equal(entries[0].roomNumber, 17);
    assert.equal(entries[0].playerId, ctx.players[0].playerId);
    assert.equal(entries[0].type, ROOM_LEDGER_ENTRY_TYPES.PLAYER_PAYMENT);
    assert.equal(entries[0].amountNano, 1n * GRAM_NANO);
    assert.equal(entries[0].metadata.txHash, "tx-a1");
    assert.equal(
        buildRoomWalletPlayerPaymentEntryId("tx-a1"),
        entries[0].entryId
    );

    const duplicate = creditPlayer(ctx, 0, "tx-a1");
    assert.equal(duplicate.credited, false);
    assert.equal(ctx.ledgerRegistry.listPlayerPayments("game-a").length, 1);
});

test("A/E Game A and Game B ledger entries remain separate", () => {
    const registry = new RoomWalletLedgerRegistry();
    registry.recordPlayerPayment({
        roomId: "Keah",
        roomNumber: 17,
        gameId: "game-a",
        playerId: "p1",
        txHash: "tx-a1",
        amountGram: 1
    });
    registry.recordPlayerPayment({
        roomId: "Keah",
        roomNumber: 17,
        gameId: "game-b",
        playerId: "p1",
        txHash: "tx-b1",
        amountGram: 1
    });

    const gameA = registry.listPlayerPayments("game-a");
    const gameB = registry.listPlayerPayments("game-b");
    assert.equal(gameA.length, 1);
    assert.equal(gameB.length, 1);
    assert.equal(gameA[0].gameId, "game-a");
    assert.equal(gameB[0].gameId, "game-b");
    assert.equal(gameA[0].roomNumber, 17);
    assert.equal(gameB[0].roomNumber, 17);
    assert.notEqual(gameA[0].entryId, gameB[0].entryId);
});

test("A. duplicate blockchain hash cannot fund a second game", () => {
    const registry = new RoomWalletLedgerRegistry();
    const first = registry.recordPlayerPayment({
        roomId: "Keah",
        roomNumber: 17,
        gameId: "game-a",
        playerId: "p1",
        txHash: "tx-shared",
        amountGram: 1
    });
    const replay = registry.recordPlayerPayment({
        roomId: "Keah",
        roomNumber: 17,
        gameId: "game-a",
        playerId: "p1",
        txHash: "tx-shared",
        amountGram: 1
    });
    assert.equal(replay.entryId, first.entryId);
    assert.equal(registry.listPlayerPayments("game-a").length, 1);

    assert.throws(
        () => registry.recordPlayerPayment({
            roomId: "Keah",
            roomNumber: 17,
            gameId: "game-b",
            playerId: "p1",
            txHash: "tx-shared",
            amountGram: 1
        }),
        /already attributed/
    );
    assert.equal(registry.listPlayerPayments("game-b").length, 0);
});

test("B. zero/one/two payments do not complete; three valid payments emit PAYMENT_SESSION_COMPLETED", (t) => {
    const ctx = createPaymentContext({
        roomId: "Keah",
        roomNumber: 17,
        gameId: "game-complete",
        players: threePlayers("c")
    });
    t.after(() => {
        ctx.observer.stop();
        ctx.manager.shutdown();
        ctx.persistence.shutdown({ checkpoint: false });
        ctx.eventBus.shutdown();
    });

    const completed = [];
    ctx.eventBus.subscribe(EVENT_TYPES.PAYMENT_SESSION_COMPLETED, (envelope) => {
        completed.push(envelope.payload);
    });

    assert.notEqual(ctx.manager.getSession("Keah").status, PAYMENT_SESSION_STATUS.COMPLETED);

    creditPlayer(ctx, 0, "tx-c1");
    assert.notEqual(ctx.manager.getSession("Keah").status, PAYMENT_SESSION_STATUS.COMPLETED);
    assert.equal(completed.length, 0);

    creditPlayer(ctx, 1, "tx-c2");
    assert.notEqual(ctx.manager.getSession("Keah").status, PAYMENT_SESSION_STATUS.COMPLETED);
    assert.equal(completed.length, 0);

    creditPlayer(ctx, 2, "tx-c3");
    assert.equal(ctx.manager.getSession("Keah").status, PAYMENT_SESSION_STATUS.COMPLETED);
    assert.equal(ctx.manager.getSession("Keah").allConfirmed(), true);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].gameId, "game-complete");
    assert.equal(ctx.ledgerRegistry.listPlayerPayments("game-complete").length, 3);
});

test("C. Room Wallet mode blocks until three valid payments and ignores Deposit/GameEscrow", () => {
    for (const confirmedCount of [0, 1, 2]) {
        const harness = createGsaHarness({
            confirmedCount,
            sessionStatus: PAYMENT_SESSION_STATUS.ACTIVE
        });
        harness.session.status = PAYMENT_SESSION_STATUS.ACTIVE;
        harness.emitCompleted();
        assert.equal(harness.collected.length, 0, `${confirmedCount} payments must not authorize`);
        harness.shutdown();
    }

    const ready = createGsaHarness({
        confirmedCount: 3,
        depositState: "AWAITING_FUNDS",
        contractStatus: GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS
    });
    ready.emitCompleted();
    assert.deepEqual(ready.collected, [
        EVENT_TYPES.GAME_START_AUTHORIZED,
        EVENT_TYPES.GAME_INITIALIZING,
        EVENT_TYPES.GAME_START_BOOTSTRAP_READY
    ]);
    assert.equal(ready.auth.getLifecycle("Keah")?.phase, GAME_START_PHASE.OPENED);
    ready.shutdown();
});

test("C. legacy mode still requires Deposit FULL and GameEscrow PAYMENTS_COMPLETE", () => {
    const noDeposit = createGsaHarness({
        roomWalletPaymentIntakeEnabled: false,
        depositState: "AWAITING_FUNDS",
        contractStatus: GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE
    });
    noDeposit.emitCompleted();
    assert.equal(noDeposit.collected.length, 0);
    noDeposit.shutdown();

    const noEscrow = createGsaHarness({
        roomWalletPaymentIntakeEnabled: false,
        depositState: "DEPOSIT_FULL",
        contractStatus: GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS
    });
    noEscrow.emitCompleted();
    assert.equal(noEscrow.collected.length, 0);
    noEscrow.shutdown();

    const legacyReady = createGsaHarness({
        roomWalletPaymentIntakeEnabled: false,
        depositState: "DEPOSIT_FULL",
        contractStatus: GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE
    });
    legacyReady.emitCompleted();
    assert.equal(legacyReady.auth.getLifecycle("Keah")?.phase, GAME_START_PHASE.OPENED);
    legacyReady.shutdown();
});

test("D. sequential Game A then Game B in Room 17 do not share payment readiness", (t) => {
    const players = threePlayers("seq");
    const ctxA = createPaymentContext({
        roomId: "Keah",
        roomNumber: 17,
        gameId: "game-a",
        players
    });
    t.after(() => {
        ctxA.observer.stop();
        ctxA.manager.shutdown();
        ctxA.persistence.shutdown({ checkpoint: false });
        ctxA.eventBus.shutdown();
    });

    creditPlayer(ctxA, 0, "tx-a1");
    creditPlayer(ctxA, 1, "tx-a2");
    creditPlayer(ctxA, 2, "tx-a3");

    const auth = new GameStartAuthorization({
        logger: ctxA.logger,
        eventBus: ctxA.eventBus,
        roomManager: ctxA.roomManager,
        playerManager: {
            getIdentity(playerId) {
                return { playerId };
            }
        },
        gameManager: {
            getGame(gameId) {
                return { gameId, status: "CREATED" };
            },
            getPendingGameplayGameId() {
                return ctxA.manager.getSession("Keah")?.gameId ?? "game-a";
            }
        },
        paymentSessionManager: ctxA.manager,
        gameContractManager: {
            getContract() {
                return {
                    status: GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS,
                    gameId: "game-a"
                };
            }
        },
        configurationEngine: {
            getConfiguration(id) {
                return {
                    gameId: id ?? "game-a",
                    traceSeed: "seed",
                    players: [],
                    sectors: []
                };
            },
            validateConfiguration() {}
        },
        physicsEngine: { getSimulation() { return {}; } },
        gameClockEngine: { getClock() { return {}; } },
        recoveryEngine: { getRecoverySnapshot() { return null; } },
        auditLedger: new EntryPaymentAuditLedger(),
        roomConfig: { maxPlayers: 3 },
        depositSessionCoordinator: {
            getByRoomAndGame() {
                return { state: "AWAITING_FUNDS" };
            }
        },
        roomWalletPaymentIntakeEnabled: true,
        roomWalletLedgerRegistry: ctxA.ledgerRegistry
    });
    auth.initialize();
    t.after(() => auth.shutdown());

    ctxA.eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_SESSION_COMPLETED,
        payload: { roomId: "Keah", gameId: "game-a" }
    });
    assert.equal(auth.getLifecycle("Keah")?.phase, GAME_START_PHASE.OPENED);
    assert.equal(auth.getLifecycle("Keah")?.gameId, "game-a");

    ctxA.manager.destroySession("Keah");
    const ctxBPlayers = threePlayers("seqb");
    const identities = new Map();
    const wallets = new Map();
    for (const player of ctxBPlayers) {
        identities.set(player.playerId, { baseStake: 1, sectorCount: 1 });
        wallets.set(`Keah:${player.playerId}`, player.wallet);
    }
    ctxA.roomManager.getRoom = (id) => id === "Keah"
        ? {
            players: ctxBPlayers.map((player) => player.playerId),
            roomId: "Keah",
            roomNumber: 17,
            status: ROOM_STATUS.LOCKED,
            maxPlayers: 3
        }
        : null;
    ctxA.manager._gameplayContextResolver = {
        resolveGameIdByRoomId() {
            return "game-b";
        }
    };
    ctxA.manager._playerManager = {
        getIdentity(playerId) {
            return identities.get(playerId) ?? null;
        }
    };
    ctxA.manager._sessionWalletStore = {
        getWallet(_roomId, playerId) {
            return wallets.get(`Keah:${playerId}`) ?? null;
        }
    };
    ctxA.manager._roomManager = ctxA.roomManager;

    ctxA.manager.createPaymentSession("Keah", { gameId: "game-b", network: "testnet" });
    assert.equal(ctxA.manager.getSession("Keah").gameId, "game-b");
    assert.notEqual(ctxA.manager.getSession("Keah").status, PAYMENT_SESSION_STATUS.COMPLETED);
    assert.equal(auth.getLifecycle("Keah"), null, "Game B must reset Game A start latch");

    ctxA.eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_SESSION_COMPLETED,
        payload: { roomId: "Keah", gameId: "game-b" }
    });
    assert.equal(auth.getLifecycle("Keah"), null);

    const observerB = new RoomWalletIncomingObserver({
        logger: ctxA.logger,
        eventBus: ctxA.eventBus,
        paymentSessionManager: ctxA.manager,
        financialPersistence: ctxA.persistence,
        registry: new RoomWalletRegistry({
            entries: [{ roomNumber: 17, address: ctxA.roomWallet }]
        }),
        roomManager: ctxA.roomManager,
        ledgerRegistry: ctxA.ledgerRegistry,
        network: "testnet"
    });
    t.after(() => observerB.stop());

    function creditB(index, hash) {
        return observerB.processTransaction(inboundTx({
            hash,
            from: ctxBPlayers[index].wallet,
            to: ctxA.roomWallet,
            nanoton: 1_000_000_000
        }), ctxA.roomWallet);
    }

    creditB(0, "tx-b1");
    ctxA.eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_SESSION_COMPLETED,
        payload: { roomId: "Keah", gameId: "game-b" }
    });
    assert.equal(auth.getLifecycle("Keah"), null);

    creditB(1, "tx-b2");
    ctxA.eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_SESSION_COMPLETED,
        payload: { roomId: "Keah", gameId: "game-b" }
    });
    assert.equal(auth.getLifecycle("Keah"), null);

    creditB(2, "tx-b3");
    assert.equal(ctxA.manager.getSession("Keah").status, PAYMENT_SESSION_STATUS.COMPLETED);
    assert.equal(ctxA.ledgerRegistry.listPlayerPayments("game-b").length, 3);
    assert.equal(ctxA.ledgerRegistry.listPlayerPayments("game-a").length, 3);
    assert.equal(auth.getLifecycle("Keah")?.phase, GAME_START_PHASE.OPENED);
    assert.equal(auth.getLifecycle("Keah")?.gameId, "game-b");
});

test("E. Game A ledger payments cannot satisfy Game B", () => {
    const harness = createGsaHarness({
        gameId: "game-b",
        ledgerPayments: []
    });
    harness.ledgerRegistry.recordPlayerPayment({
        roomId: "Keah",
        roomNumber: 17,
        gameId: "game-a",
        playerId: "p1",
        txHash: "tx-a1",
        amountGram: 1
    });
    harness.ledgerRegistry.recordPlayerPayment({
        roomId: "Keah",
        roomNumber: 17,
        gameId: "game-a",
        playerId: "p2",
        txHash: "tx-a2",
        amountGram: 1
    });
    harness.ledgerRegistry.recordPlayerPayment({
        roomId: "Keah",
        roomNumber: 17,
        gameId: "game-a",
        playerId: "p3",
        txHash: "tx-a3",
        amountGram: 1
    });
    harness.emitCompleted();
    assert.equal(harness.collected.length, 0);
    harness.shutdown();
});

test("F. Room Wallet balance cannot make a game ready", () => {
    let balanceNano = 0n;
    const getBalance = async () => {
        getBalance.called = true;
        return balanceNano;
    };
    const harness = createGsaHarness({
        confirmedCount: 2,
        sessionStatus: PAYMENT_SESSION_STATUS.ACTIVE,
        ledgerPayments: [
            { playerId: "p1", txHash: "tx-1" },
            { playerId: "p2", txHash: "tx-2" }
        ]
    });
    harness.session.status = PAYMENT_SESSION_STATUS.ACTIVE;
    balanceNano = 1_000_000_000_000n;
    harness.emitCompleted();
    assert.equal(harness.collected.length, 0);
    assert.equal(getBalance.called, undefined);
    harness.shutdown();
});

test("G. Room Wallet readiness uses GAME_START_BOOTSTRAP_READY and does not add a second OPEN_PAGE5 emitter", () => {
    const harness = createGsaHarness({ confirmedCount: 3 });
    harness.emitCompleted();
    assert.equal(harness.collected.includes(EVENT_TYPES.GAME_START_BOOTSTRAP_READY), true);
    assert.equal(harness.auth.getLifecycle("Keah")?.phase, GAME_START_PHASE.OPENED);
    harness.shutdown();

    const observer = readFileSync(join(HERE, "../payment/roomWallet/RoomWalletIncomingObserver.js"), "utf8");
    const ledger = readFileSync(join(HERE, "../payment/roomWallet/RoomWalletLedger.js"), "utf8");
    const psm = readFileSync(join(HERE, "../gameplay/PaymentSessionManager.js"), "utf8");
    const adapter = readFileSync(join(HERE, "../payment/roomWallet/RoomWalletSettlementAdapter.js"), "utf8");
    const bridge = readFileSync(join(HERE, "../socket/RoomLobbyBridge.js"), "utf8");
    const gsa = readFileSync(join(HERE, "../gameplay/GameStartAuthorization.js"), "utf8");

    assert.equal(observer.includes("OPEN_PAGE5"), false);
    assert.equal(ledger.includes("OPEN_PAGE5"), false);
    assert.equal(psm.includes("OPEN_PAGE5"), false);
    assert.equal(adapter.includes("OPEN_PAGE5"), false);
    assert.match(bridge, /_deliverOpenPage5/);
    assert.match(gsa, /GAME_START_BOOTSTRAP_READY/);
    assert.match(gsa, /_roomWalletPaymentIntakeEnabled/);
});

test("GameEscrow sync does not demote Room Wallet confirmations in intake mode", async () => {
    const ctx = createPaymentContext({
        roomId: "Keah",
        roomNumber: 17,
        gameId: "game-sync",
        players: threePlayers("sy"),
        roomWalletPaymentIntakeEnabled: true
    });

    creditPlayer(ctx, 0, "tx-sy1");
    const before = ctx.manager.getSession("Keah").findParticipant(ctx.players[0].playerId).status;
    const sync = await ctx.manager.syncFromGameEscrow("Keah");
    assert.equal(sync.skipped, "room_wallet_intake");
    assert.equal(sync.demoted, 0);
    assert.equal(
        ctx.manager.getSession("Keah").findParticipant(ctx.players[0].playerId).status,
        before
    );

    ctx.observer.stop();
    ctx.manager.shutdown();
    ctx.persistence.shutdown({ checkpoint: false });
    ctx.eventBus.shutdown();
});
