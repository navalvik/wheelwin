/**
 * Authoritative Room Number ↔ Room Wallet mapping.
 * Deterministic mocks only. No TESTNET funds.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { EventBus } from "../events/EventBus.js";
import { GameManager } from "../managers/GameManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import {
    isValidRoomId,
    ROOM_ID_LENGTH
} from "../managers/room/roomIdAlphabet.js";
import { Room } from "../models/Room.js";
import { ROOM_STATUS } from "../models/RoomStatus.js";
import {
    PAYMENT_PARTICIPANT_STATUS,
    PaymentSession
} from "../models/PaymentSession.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";
import { ContractSettlementManager } from "../payment/ContractSettlementManager.js";
import { RoomWalletRegistry } from "../payment/roomWallet/RoomWalletRegistry.js";
import { RoomWalletSettlementAdapter } from "../payment/roomWallet/RoomWalletSettlementAdapter.js";
import {
    ROOM_WALLET_INCOMING_REJECTION_REASONS,
    RoomWalletIncomingObserver,
    resolveAuthoritativeRoomNumber,
    resolveIntendedRoomWalletAddress
} from "../payment/roomWallet/RoomWalletIncomingObserver.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";

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
    }).address.toString({
        bounceable: true,
        urlSafe: true
    });
}

function inboundTx({ hash, from, to, nanoton, comment = "", lt = "100" }) {
    return {
        transaction_id: { hash, lt },
        aborted: false,
        in_msg: {
            source: from,
            destination: to,
            value: String(nanoton),
            message: comment
        }
    };
}

function attachPassThroughSetup(roomManager) {
    roomManager.attachSetupSessionLifecycle({
        createForRoom() {
            return { setupSessionId: "setup" };
        },
        abortForRoom() {},
        isActive() {
            return false;
        }
    });
}

function createLiveRoomManager({ maxConcurrentRooms = 64 } = {}) {
    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();
    const roomManager = new RoomManager({
        logger,
        eventBus,
        roomConfig: { maxPlayers: 3, maxConcurrentRooms }
    });
    roomManager.initialize();
    attachPassThroughSetup(roomManager);
    return { logger, eventBus, roomManager };
}

function threePlayers(prefix) {
    return [
        { playerId: `${prefix}-p1`, wallet: friendlyAddress(`${prefix}-p1`) },
        { playerId: `${prefix}-p2`, wallet: friendlyAddress(`${prefix}-p2`) },
        { playerId: `${prefix}-p3`, wallet: friendlyAddress(`${prefix}-p3`) }
    ];
}

function createPaymentContext({ roomId, roomNumber, gameId, players, durationMs = 60_000 }) {
    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();
    const persistence = new TonFinancialPersistence({
        dataDir: mkdtempSync(join(tmpdir(), "ww-rnum-")),
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
                ? { players: players.map((player) => player.playerId), roomId, roomNumber }
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
        durationMs
    });
    manager.initialize();

    return { logger, eventBus, manager, persistence, roomManager };
}

test("A. first room receives a valid Room Number", () => {
    const { roomManager, eventBus, logger } = createLiveRoomManager();
    const room = roomManager.createRoom();
    assert.ok(room);
    assert.equal(room.roomNumber, 1);
    assert.equal(roomManager.resolveRoomNumber(room.roomId), 1);
    roomManager.shutdown();
    eventBus.shutdown();
    logger.shutdown?.();
});

test("B/C/D/E unique Room Numbers, 64 supported, 65th rejected, destroyed number reusable", () => {
    const { roomManager, eventBus, logger } = createLiveRoomManager();
    const rooms = [];

    for (let index = 0; index < 64; index += 1) {
        const room = roomManager.createRoom();
        assert.ok(room, `room ${index + 1} should be created`);
        rooms.push(room);
    }

    const numbers = rooms.map((room) => room.roomNumber);
    assert.deepEqual([...numbers].sort((a, b) => a - b), [...Array(64)].map((_, i) => i + 1));
    assert.equal(new Set(numbers).size, 64);
    assert.equal(roomManager.createRoom(), null);

    const roomTwo = rooms.find((room) => room.roomNumber === 2);
    assert.ok(roomTwo);
    assert.equal(roomManager.destroyRoom(roomTwo.roomId), true);

    const reused = roomManager.createRoom();
    assert.ok(reused);
    assert.equal(reused.roomNumber, 2);
    assert.notEqual(reused.roomId, roomTwo.roomId);

    roomManager.shutdown();
    eventBus.shutdown();
    logger.shutdown?.();
});

test("F/G roomId remains a 4-character public identifier and is never numeric identity", () => {
    const { roomManager, eventBus, logger } = createLiveRoomManager();
    const room = roomManager.createRoom();
    assert.equal(room.roomId.length, ROOM_ID_LENGTH);
    assert.equal(isValidRoomId(room.roomId), true);
    assert.notEqual(room.roomId, String(room.roomNumber));
    assert.equal(resolveAuthoritativeRoomNumber({ roomId: room.roomId }), null);
    assert.equal(resolveAuthoritativeRoomNumber({ roomId: "Keah" }), null);
    assert.equal(Number.isInteger(Number(room.roomId)) && String(Number(room.roomId)) === room.roomId, false);

    const registry = new RoomWalletRegistry({
        entries: [{ roomNumber: room.roomNumber, address: friendlyAddress("wallet-first") }]
    });
    assert.equal(resolveIntendedRoomWalletAddress({ roomId: room.roomId }, registry), null);
    assert.equal(
        resolveIntendedRoomWalletAddress({
            roomId: room.roomId,
            roomManager
        }, registry),
        friendlyAddress("wallet-first")
    );

    roomManager.shutdown();
    eventBus.shutdown();
    logger.shutdown?.();
});

test("H/I/K Room Number N resolves to Room Wallet N and simultaneous rooms never share a wallet", () => {
    const wallet17 = friendlyAddress("wallet-17");
    const wallet18 = friendlyAddress("wallet-18");
    const registry = new RoomWalletRegistry({
        entries: [
            { roomNumber: 17, address: wallet17 },
            { roomNumber: 18, address: wallet18 }
        ]
    });

    const { roomManager, eventBus, logger } = createLiveRoomManager();
    const attached17 = new Room({
        roomId: "Keah",
        roomNumber: 17,
        createdAt: Date.now(),
        status: ROOM_STATUS.WAITING_FOR_PLAYERS,
        maxPlayers: 3,
        players: []
    });
    const attached18 = new Room({
        roomId: "Abcd",
        roomNumber: 18,
        createdAt: Date.now(),
        status: ROOM_STATUS.WAITING_FOR_PLAYERS,
        maxPlayers: 3,
        players: []
    });

    assert.ok(roomManager.attachRoom(attached17));
    assert.ok(roomManager.attachRoom(attached18));
    assert.equal(roomManager.resolveRoomNumber("Keah"), 17);
    assert.equal(roomManager.resolveRoomNumber("Abcd"), 18);
    assert.equal(roomManager.getRoomByNumber(17).roomId, "Keah");
    assert.equal(registry.get(17).address, wallet17);
    assert.equal(registry.get(18).address, wallet18);
    assert.equal(
        resolveIntendedRoomWalletAddress({ roomId: "Keah", roomManager }, registry),
        wallet17
    );
    assert.equal(
        resolveIntendedRoomWalletAddress({ roomId: "Abcd", roomManager }, registry),
        wallet18
    );
    assert.notEqual(
        resolveIntendedRoomWalletAddress({ roomId: "Keah", roomManager }, registry),
        resolveIntendedRoomWalletAddress({ roomId: "Abcd", roomManager }, registry)
    );

    roomManager.shutdown();
    eventBus.shutdown();
    logger.shutdown?.();
});

test("J/mandatory Game A then Game B in Room 17 reuse Wallet 17 with isolated ledgers", async (t) => {
    const wallet17 = friendlyAddress("room-wallet-17");
    const registry = new RoomWalletRegistry({
        entries: [{ roomNumber: 17, address: wallet17 }]
    });
    const players = threePlayers("r17");
    const gameA = "game_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const gameB = "game_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    const first = createPaymentContext({
        roomId: "Keah",
        roomNumber: 17,
        gameId: gameA,
        players
    });
    t.after(() => {
        first.manager.shutdown();
        first.persistence.shutdown({ checkpoint: false });
        first.eventBus.shutdown();
    });

    first.manager.createPaymentSession("Keah", { gameId: gameA, network: "testnet" });
    const observerA = new RoomWalletIncomingObserver({
        logger: first.logger,
        eventBus: first.eventBus,
        paymentSessionManager: first.manager,
        financialPersistence: first.persistence,
        registry,
        roomManager: first.roomManager,
        network: "testnet"
    });

    const creditA = observerA.processTransaction(inboundTx({
        hash: "tx-game-a",
        from: players[0].wallet,
        to: wallet17,
        nanoton: 1_000_000_000
    }), wallet17);

    assert.equal(creditA.credited, true);
    assert.equal(creditA.gameId, gameA);
    assert.equal(creditA.roomNumber, 17);
    assert.equal(
        resolveIntendedRoomWalletAddress({ roomId: "Keah", roomNumber: 17 }, registry),
        wallet17
    );

    const sessionA = first.manager.getSession("Keah");
    assert.equal(sessionA.gameId, gameA);
    assert.equal(sessionA.roomNumber, 17);
    assert.equal(sessionA.findParticipant(players[0].playerId).txHash, "tx-game-a");
    const gameARequired = sessionA.findParticipant(players[0].playerId).requiredGram;

    const settlementCalls = [];
    const settlementAdapter = new RoomWalletSettlementAdapter({
        roomWalletAdapter: {
            getGasReserveNano() {
                return 3_000_000n;
            },
            async getBalance(roomNumber) {
                settlementCalls.push({ op: "balance", roomNumber });
                return 100_000_000_000n;
            },
            async sendTransfer(input) {
                settlementCalls.push({ op: "send", ...input });
                return { ok: true, code: "SENT", txHash: `settle-${input.queryId}` };
            }
        }
    });

    const gameManager = new GameManager({ logger: first.logger, eventBus: first.eventBus });
    gameManager.configureGameplayBootstrap({
        roomManager: first.roomManager,
        playerManager: {},
        configurationEngine: {},
        gameStateEngine: {},
        inputAuthority: {},
        physicsEngine: {},
        gameClockEngine: {},
        gameCatalog: {}
    });
    const createdGameA = gameManager.createGame("Keah", {
        players: players.map((player) => player.playerId)
    });
    assert.equal(createdGameA.roomNumber, 17);
    assert.equal(createdGameA.roomId, "Keah");

    const settlementA = await settlementAdapter.settleContract({
        gameId: gameA,
        roomId: "Keah",
        roomNumber: 17,
        winnerWallet: players[0].wallet,
        ownerWallet: friendlyAddress("owner"),
        prizeAmountNano: 9_500_000_000n,
        organizerAmountNano: 150_000_000n
    });

    assert.equal(settlementA.ok, true);
    assert.equal(settlementA.roomNumber, 17);
    assert.equal(settlementA.gameId, gameA);

    first.manager.destroySession("Keah");
    assert.equal(first.manager.getSession("Keah"), null);

    const second = createPaymentContext({
        roomId: "Keah",
        roomNumber: 17,
        gameId: gameB,
        players
    });
    t.after(() => {
        second.manager.shutdown();
        second.persistence.shutdown({ checkpoint: false });
        second.eventBus.shutdown();
    });

    second.manager.createPaymentSession("Keah", { gameId: gameB, network: "testnet" });
    const sessionB = second.manager.getSession("Keah");
    assert.equal(sessionB.gameId, gameB);
    assert.equal(sessionB.roomNumber, 17);
    assert.notEqual(sessionB.paymentSessionId, sessionA.paymentSessionId);
    assert.equal(sessionB.findParticipant(players[0].playerId).txHash, null);
    assert.equal(sessionB.findParticipant(players[0].playerId).status, PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED);
    assert.equal(sessionB.findParticipant(players[0].playerId).requiredGram, gameARequired);

    const observerB = new RoomWalletIncomingObserver({
        logger: second.logger,
        eventBus: second.eventBus,
        paymentSessionManager: second.manager,
        financialPersistence: second.persistence,
        registry,
        roomManager: second.roomManager,
        network: "testnet"
    });

    const creditB = observerB.processTransaction(inboundTx({
        hash: "tx-game-b",
        from: players[0].wallet,
        to: wallet17,
        nanoton: 1_000_000_000
    }), wallet17);

    assert.equal(creditB.credited, true);
    assert.equal(creditB.gameId, gameB);
    assert.equal(creditB.roomNumber, 17);
    assert.equal(second.manager.getSession("Keah").findParticipant(players[0].playerId).txHash, "tx-game-b");
    assert.notEqual(second.manager.getSession("Keah").findParticipant(players[0].playerId).txHash, "tx-game-a");

    const settlementB = await settlementAdapter.settleContract({
        gameId: gameB,
        roomId: "Keah",
        roomNumber: 17,
        winnerWallet: players[1].wallet,
        ownerWallet: friendlyAddress("owner"),
        prizeAmountNano: 9_500_000_000n,
        organizerAmountNano: 150_000_000n
    });

    assert.equal(settlementB.ok, true);
    assert.equal(settlementB.roomNumber, 17);
    assert.equal(settlementB.gameId, gameB);
    assert.equal(
        resolveIntendedRoomWalletAddress({ roomId: "Keah", roomNumber: 17 }, registry),
        wallet17
    );
    assert.deepEqual(
        settlementCalls.filter((call) => call.op === "balance").map((call) => call.roomNumber),
        [17, 17]
    );
    assert.equal(
        settlementCalls.filter((call) => call.op === "send").every((call) => call.roomNumber === 17),
        true
    );
    assert.notEqual(settlementB.gameId, settlementA.gameId);
    assert.notEqual(sessionB.requiredPayments, sessionA.requiredPayments);
    assert.equal(sessionB instanceof PaymentSession, true);
    assert.notEqual(100_000_000_000n, sessionB.findParticipant(players[0].playerId).requiredGram);
});

test("L-R incoming Room Wallet payment uses authoritative roomNumber for dest/player/game/idempotency", (t) => {
    const wallet17 = friendlyAddress("rw-intake-17");
    const otherWallet = friendlyAddress("rw-other");
    const players = threePlayers("in");
    const ctx = createPaymentContext({
        roomId: "Keah",
        roomNumber: 17,
        gameId: "game-intake",
        players
    });
    t.after(() => {
        ctx.manager.shutdown();
        ctx.persistence.shutdown({ checkpoint: false });
        ctx.eventBus.shutdown();
    });

    ctx.manager.createPaymentSession("Keah", { gameId: "game-intake", network: "testnet" });
    const observer = new RoomWalletIncomingObserver({
        logger: ctx.logger,
        eventBus: ctx.eventBus,
        paymentSessionManager: ctx.manager,
        financialPersistence: ctx.persistence,
        registry: new RoomWalletRegistry({
            entries: [
                { roomNumber: 17, address: wallet17 },
                { roomNumber: 18, address: otherWallet }
            ]
        }),
        roomManager: ctx.roomManager,
        network: "testnet"
    });

    const credited = observer.processTransaction(inboundTx({
        hash: "tx-ok",
        from: players[0].wallet,
        to: wallet17,
        nanoton: 1_000_000_000
    }), wallet17);
    assert.equal(credited.credited, true);
    assert.equal(credited.playerId, players[0].playerId);
    assert.equal(credited.gameId, "game-intake");
    assert.equal(credited.roomNumber, 17);

    const duplicate = observer.processTransaction(inboundTx({
        hash: "tx-ok",
        from: players[0].wallet,
        to: wallet17,
        nanoton: 1_000_000_000
    }), wallet17);
    assert.equal(duplicate.credited, false);
    assert.equal(duplicate.reason, ROOM_WALLET_INCOMING_REJECTION_REASONS.DUPLICATE_TRANSACTION);

    const wrongDest = observer.processTransaction(inboundTx({
        hash: "tx-wrong-dest",
        from: players[1].wallet,
        to: otherWallet,
        nanoton: 1_000_000_000
    }), otherWallet);
    assert.equal(wrongDest.credited, false);
    assert.equal(wrongDest.reason, ROOM_WALLET_INCOMING_REJECTION_REASONS.WRONG_DESTINATION);

    const wrongAmount = observer.processTransaction(inboundTx({
        hash: "tx-wrong-amt",
        from: players[1].wallet,
        to: wallet17,
        nanoton: 2_000_000_000
    }), wallet17);
    assert.equal(wrongAmount.credited, false);
    assert.equal(wrongAmount.reason, ROOM_WALLET_INCOMING_REJECTION_REASONS.WRONG_AMOUNT);
});

test("P ambiguous attribution is rejected when two sessions claim the same Room Wallet sender", (t) => {
    const wallet = friendlyAddress("rw-amb");
    const shared = friendlyAddress("shared-sender");
    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();
    const persistence = new TonFinancialPersistence({
        dataDir: mkdtempSync(join(tmpdir(), "ww-rnum-amb-")),
        logger
    });
    persistence.initialize();

    const rooms = [
        {
            roomId: "Keah",
            roomNumber: 17,
            gameId: "game-amb-a",
            players: [
                { playerId: "amb-a1", wallet: shared },
                { playerId: "amb-a2", wallet: friendlyAddress("amb-a2") },
                { playerId: "amb-a3", wallet: friendlyAddress("amb-a3") }
            ]
        },
        {
            roomId: "Abcd",
            roomNumber: 17,
            gameId: "game-amb-b",
            players: [
                { playerId: "amb-b1", wallet: shared },
                { playerId: "amb-b2", wallet: friendlyAddress("amb-b2") },
                { playerId: "amb-b3", wallet: friendlyAddress("amb-b3") }
            ]
        }
    ];
    const roomsById = new Map(rooms.map((room) => [room.roomId, room]));
    const identities = new Map();
    const wallets = new Map();
    for (const room of rooms) {
        for (const player of room.players) {
            identities.set(player.playerId, { baseStake: 1, sectorCount: 1 });
            wallets.set(`${room.roomId}:${player.playerId}`, player.wallet);
        }
    }

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
                const room = roomsById.get(roomId);
                return room
                    ? {
                        players: room.players.map((player) => player.playerId),
                        roomId,
                        roomNumber: room.roomNumber
                    }
                    : null;
            },
            resolveRoomNumber(roomId) {
                return roomsById.get(roomId)?.roomNumber ?? null;
            }
        },
        roomConfig: { paymentSessionDurationMs: 60_000 },
        gameplayContextResolver: {
            resolveGameIdByRoomId(roomId) {
                return roomsById.get(roomId)?.gameId ?? null;
            }
        },
        sessionWalletStore: {
            getWallet(roomId, playerId) {
                return wallets.get(`${roomId}:${playerId}`) ?? null;
            }
        },
        financialPersistence: persistence,
        durationMs: 60_000
    });
    manager.initialize();
    t.after(() => {
        manager.shutdown();
        persistence.shutdown({ checkpoint: false });
        eventBus.shutdown();
    });

    manager.createPaymentSession("Keah", { gameId: "game-amb-a", network: "testnet" });
    manager.createPaymentSession("Abcd", { gameId: "game-amb-b", network: "testnet" });

    const observer = new RoomWalletIncomingObserver({
        logger,
        eventBus,
        paymentSessionManager: manager,
        financialPersistence: persistence,
        registry: new RoomWalletRegistry({
            entries: [{ roomNumber: 17, address: wallet }]
        }),
        roomManager: {
            resolveRoomNumber(roomId) {
                return roomsById.get(roomId)?.roomNumber ?? null;
            }
        },
        network: "testnet"
    });

    const result = observer.processTransaction(inboundTx({
        hash: "tx-amb",
        from: shared,
        to: wallet,
        nanoton: 1_000_000_000
    }), wallet);

    assert.equal(result.credited, false);
    assert.equal(result.reason, ROOM_WALLET_INCOMING_REJECTION_REASONS.AMBIGUOUS_ATTRIBUTION);
});

test("S/T settlement resolves authoritative Room Number and never treats roomId as roomNumber", () => {
    const manager = new ContractSettlementManager({
        logger: createLogger(),
        eventBus: { subscribe() {}, publish() {}, unsubscribe() {}, emit() {} },
        gameContractManager: {},
        winnerEngine: {},
        settlementAdapter: {
            async settleContract() {
                return { ok: true };
            }
        },
        roomManager: {
            resolveRoomNumber(roomId) {
                return roomId === "Keah" ? 17 : null;
            },
            getRoom(roomId) {
                return roomId === "Keah" ? { roomId: "Keah", roomNumber: 17 } : null;
            }
        }
    });

    assert.equal(manager._resolveRoomNumberForSettlement({ roomId: "Keah", gameId: "game-s" }), 17);
    assert.equal(manager._resolveRoomNumberForSettlement({ roomId: "Keah" }), 17);
    assert.notEqual(manager._resolveRoomNumberForSettlement({ roomId: "Keah" }), Number("Keah"));

    const wrapped = manager._withAuthoritativeRoomNumber(
        { gameId: "game-s", roomId: "Keah" },
        { gameId: "game-s", roomId: "Keah" }
    );
    assert.equal(wrapped.roomNumber, 17);
    assert.equal(wrapped.roomId, "Keah");
    assert.equal(wrapped.roomNumber === wrapped.roomId, false);
});
