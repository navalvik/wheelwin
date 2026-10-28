import test from "node:test";
import assert from "node:assert/strict";
import { Address } from "@ton/core";

import { buildAuthoritativeRoomPaymentRequests } from "../../payment/runtime/AuthoritativeRoomPaymentRequests.js";
import { RoomLobbyBridge } from "../../socket/RoomLobbyBridge.js";
import { LOBBY_SERVER_EVENTS } from "../../socket/lobbyProtocol.js";

const roomId = "TeSt";
const players = ["player-1", "player-2", "player-3"];
const wallet = (index) => new Address(0, Buffer.alloc(32, index))
    .toString({ testOnly: true });

function fixtures() {
    const identities = new Map([
        [players[0], { playerId: players[0], wallet: wallet(1), baseStake: 1, sectorCount: 1 }],
        [players[1], { playerId: players[1], wallet: wallet(2), baseStake: 1, sectorCount: 2 }],
        [players[2], { playerId: players[2], wallet: wallet(3), baseStake: 10, sectorCount: 2 }]
    ]);
    const runtimes = new Map(players.map((id) => [id, { roomId }]));
    const manager = {
        getIdentity: (id) => identities.get(id) ?? null,
        getRuntime: (id) => runtimes.get(id) ?? null,
        updateIdentity: (id, patch) => {
            const current = identities.get(id);
            if (!current) return null;
            const updated = { ...current, ...patch };
            identities.set(id, updated);
            return updated;
        }
    };
    return { identities, manager };
}

test("three server-owned Page2 profiles yield exact native GRAM amounts and stable references", () => {
    const { manager } = fixtures();
    const descriptor = { roomId, playerIds: players, playerManager: manager };
    const first = buildAuthoritativeRoomPaymentRequests(descriptor);
    assert.ok(first);
    assert.deepEqual(first.map((item) => item.amountAtomic),
        [1_000_000_000, 2_500_000_000, 25_000_000_000]);
    assert.equal(new Set(first.map((item) => item.paymentReference)).size, 3);
    assert.ok(first.every((item) => /^WW-[a-f0-9]{32}$/.test(item.paymentReference)));
    assert.deepEqual(buildAuthoritativeRoomPaymentRequests(descriptor), first);
});

test("no intents for missing/duplicate payers, partial roster or invalid Page2 stake", () => {
    const { identities, manager } = fixtures();
    const descriptor = { roomId, playerIds: players, playerManager: manager };
    assert.equal(buildAuthoritativeRoomPaymentRequests({ ...descriptor, playerIds: players.slice(0, 2) }), null);
    assert.equal(buildAuthoritativeRoomPaymentRequests({ ...descriptor, playerIds: [...players, "p4"] }), null);
    assert.equal(buildAuthoritativeRoomPaymentRequests({ ...descriptor, playerIds: [players[0], players[0], players[2]] }), null);
    identities.get(players[1]).wallet = wallet(1);
    assert.equal(buildAuthoritativeRoomPaymentRequests(descriptor), null);
    identities.get(players[1]).wallet = null;
    assert.equal(buildAuthoritativeRoomPaymentRequests(descriptor), null);
    identities.get(players[1]).wallet = wallet(2);
    identities.get(players[1]).baseStake = 7;
    assert.equal(buildAuthoritativeRoomPaymentRequests(descriptor), null);
    identities.get(players[1]).baseStake = 1;
    identities.get(players[1]).sectorCount = 3;
    assert.equal(buildAuthoritativeRoomPaymentRequests(descriptor), null);
});

test("only three current authenticated sockets can register distinct Testnet wallets and prepare once", () => {
    const { identities, manager } = fixtures();
    for (const id of players) identities.get(id).wallet = null;
    const deliveries = [];
    const prepared = [];
    const intents = [];
    const room = { roomId, players: [...players], status: "LOCKED" };
    const paymentService = { listPaymentIntentsForRoom: () => intents };
    const binding = {
        runtime: { paymentService },
        prepareRoomPaymentSession(id, requests) {
            prepared.push({ id, requests });
            intents.push(...requests);
            return {
                payments: requests.map((request) => ({
                    ...request,
                    destinationWalletAddress: wallet(9),
                    network: "testnet",
                    asset: "TON",
                    expiresAt: Date.now() + 60_000
                }))
            };
        }
    };
    const bridge = new RoomLobbyBridge({
        logger: { info() {}, warn() {}, error() {} },
        eventBus: { emit: (event) => deliveries.push(event) },
        roomManager: { getRoom: (id) => id === roomId ? room : null },
        playerManager: manager,
        paymentApplicationBinding: binding,
        paymentAcceptanceEnabled: true
    });
    bridge._verifyBarrierCompletedByRoom.add(roomId);
    for (let index = 0; index < players.length; index += 1) {
        bridge._socketToPlayer.set("socket-" + index, players[index]);
        bridge._playerToSocket.set(players[index], "socket-" + index);
    }

    bridge._handlePaymentWalletRegister("unknown-socket", wallet(4), "-3");
    bridge._handlePaymentWalletRegister("socket-0", wallet(1), "-239");
    assert.equal(identities.get(players[0]).wallet, null);
    bridge._handlePaymentWalletRegister("socket-0", wallet(1), "-3");
    assert.equal(prepared.length, 0);
    bridge._handlePaymentWalletRegister("socket-1", wallet(1), "-3");
    assert.equal(identities.get(players[1]).wallet, null, "duplicate payer wallet rejected");
    bridge._handlePaymentWalletRegister("socket-1", wallet(2), "-3");
    assert.equal(prepared.length, 0);
    bridge._handlePaymentWalletRegister("socket-2", wallet(3), "-3");
    assert.equal(prepared.length, 1);
    assert.deepEqual(prepared[0].requests.map((p) => p.amountAtomic),
        [1_000_000_000, 2_500_000_000, 25_000_000_000]);
    const paymentEvents = deliveries.filter((event) =>
        event.payload?.event === LOBBY_SERVER_EVENTS.PAYMENT_REQUEST);
    assert.equal(paymentEvents.length, 3);

    bridge._handlePaymentWalletRegister("socket-0", wallet(4), "-3");
    assert.equal(identities.get(players[0]).wallet, wallet(1), "wallet frozen once intents exist");
    assert.equal(prepared.length, 1, "no second session or wallet reservation");
});

test("closed room, stale socket and disabled intake never register wallet", () => {
    const { identities, manager } = fixtures();
    identities.get(players[0]).wallet = null;
    const room = { roomId, players: [...players], status: "DESTROYED" };
    const bridge = new RoomLobbyBridge({
        logger: { info() {}, warn() {}, error() {} },
        eventBus: { emit() {} },
        roomManager: { getRoom: () => room },
        playerManager: manager,
        paymentApplicationBinding: {
            runtime: { paymentService: { listPaymentIntentsForRoom: () => [] } },
            prepareRoomPaymentSession() { throw new Error("must not prepare"); }
        },
        paymentAcceptanceEnabled: true
    });
    bridge._verifyBarrierCompletedByRoom.add(roomId);
    bridge._socketToPlayer.set("old", players[0]);
    bridge._playerToSocket.set(players[0], "new");
    bridge._handlePaymentWalletRegister("old", wallet(1), "-3");
    assert.equal(identities.get(players[0]).wallet, null);
    bridge._socketToPlayer.set("new", players[0]);
    bridge._handlePaymentWalletRegister("new", wallet(1), "-3");
    assert.equal(identities.get(players[0]).wallet, null);

    room.status = "LOCKED";
    bridge._paymentAcceptanceEnabled = false;
    bridge._handlePaymentWalletRegister("new", wallet(1), "-3");
    assert.equal(identities.get(players[0]).wallet, null);
});

test("Page4 reports pending wallet registration rather than disabled payment when intake is enabled", () => {
    const { manager } = fixtures();
    const deliveries = [];
    const bridge = new RoomLobbyBridge({
        logger: { info() {}, warn() {}, error() {} },
        eventBus: { emit: (event) => deliveries.push(event) },
        roomManager: { getRoom: () => ({ roomId, players: [...players], status: "LOCKED" }) },
        playerManager: manager,
        paymentApplicationBinding: {
            runtime: {
                paymentService: { listPaymentIntentsForRoom: () => [] },
                ledger: { store: { findByIdempotencyKey: () => null } }
            }
        },
        paymentAcceptanceEnabled: true
    });
    bridge._verifyBarrierCompletedByRoom.add(roomId);
    bridge._playerToSocket.set(players[0], "socket-0");
    bridge._deliverPaymentStatusToSocket(roomId, players[0], "socket-0");
    const payload = deliveries.at(-1)?.payload?.payload;
    assert.equal(payload?.status, "WAITING_FOR_WALLETS");
    assert.equal(payload?.paymentAcceptanceEnabled, true);
    assert.equal(Object.hasOwn(payload, "destinationWalletAddress"), false);
    assert.equal(Object.hasOwn(payload, "amountAtomic"), false);
});

test("Page4 cannot advertise an old pending intent after closure or intake disablement", () => {
    const { manager } = fixtures();
    const deliveries = [];
    const room = { roomId, players: [...players], status: "DESTROYED" };
    const pending = {
        roomId,
        playerId: players[0],
        state: "PENDING",
        paymentReference: "WW-TEST-OLD-INTENT",
        amountAtomic: 1_000_000_000,
        expectedSender: wallet(1),
        destinationWalletAddress: wallet(9),
        network: "testnet",
        asset: "TON",
        expiresAt: Date.now() + 60_000
    };
    const bridge = new RoomLobbyBridge({
        logger: { info() {}, warn() {}, error() {} },
        eventBus: { emit: (event) => deliveries.push(event) },
        roomManager: { getRoom: () => room },
        playerManager: manager,
        paymentApplicationBinding: {
            runtime: {
                paymentService: { listPaymentIntentsForRoom: () => [pending] },
                ledger: { store: { findByIdempotencyKey: () => null } }
            }
        },
        paymentAcceptanceEnabled: true
    });
    bridge._playerToSocket.set(players[0], "socket-0");

    const status = () => deliveries.at(-1)?.payload?.payload;
    bridge._deliverPaymentStatusToSocket(roomId, players[0], "socket-0");
    assert.equal(status()?.status, "PAYMENT_UNAVAILABLE");
    assert.equal(status()?.reason, "room_closed");
    assert.equal(Object.hasOwn(status(), "destinationWalletAddress"), false);

    room.status = "LOCKED";
    bridge._deliverPaymentStatusToSocket(roomId, players[0], "socket-0");
    assert.equal(status()?.status, "AWAITING_PAYMENT");
    assert.equal(status()?.paymentAcceptanceEnabled, true);
    assert.equal(status()?.amountAtomic, pending.amountAtomic);

    bridge._paymentAcceptanceEnabled = false;
    bridge._deliverPaymentStatusToSocket(roomId, players[0], "socket-0");
    assert.equal(status()?.status, "PAYMENT_UNAVAILABLE");
    assert.equal(status()?.paymentAcceptanceEnabled, false);
    assert.equal(Object.hasOwn(status(), "destinationWalletAddress"), false);
});
