import assert from "node:assert/strict";
import { ClientPageConfirmationRegistry } from "../diagnostics/ClientPageConfirmationRegistry.js";
import { SocketGateway } from "../socket/SocketGateway.js";
import { GameplayContextResolver } from "../socket/GameplayContextResolver.js";
import { LOBBY_CLIENT_EVENTS } from "../socket/lobbyProtocol.js";

const logEntries = [];
const logger = {
    warn: (message, fields) => logEntries.push({ level: "warn", message, fields }),
    info: (message, fields) => logEntries.push({ level: "info", message, fields }),
    debug: () => {}
};
const registry = new ClientPageConfirmationRegistry({ logger, staleAfterMs: 50 });
const identity = { ok: true, roomId: "room-a", gameId: "game-a", playerId: "player-bound" };

const resolver = new GameplayContextResolver({
    logger,
    playerManager: {
        hasPlayer: (playerId) => playerId === "pre-game-player",
        getRuntime: () => ({ roomId: "pre-game-room", gameId: null })
    },
    roomManager: {
        getRoom: () => ({ players: ["pre-game-player"] })
    }
});
resolver.bindSocket("pre-game-socket", { roomId: "pre-game-room", playerId: "pre-game-player" });
assert.deepEqual(resolver.resolveRoomPlayer("pre-game-socket"), {
    ok: true, roomId: "pre-game-room", playerId: "pre-game-player", gameId: null
});
assert.equal(resolver.resolve("pre-game-socket").reason,
    "No active gameplay session for this room",
    "existing gameplay context remains unavailable until server has a game ID");

const base = {
    roomId: "room-a",
    gameId: "game-a",
    playerId: "player-bound",
    page: "PAGE4_PAYMENT",
    sequenceNumber: 1,
    clientEventAt: 1_000,
    uiState: { appliedPage: "PAGE4_PAYMENT", mounted: true, visible: true, documentVisible: true }
};
assert.equal(registry.record({ identity, socketId: "socket-1", raw: base, receivedAt: 2_000 }).ok, true);
assert.equal(registry.getTrustedIdentity("socket-1").playerId, "player-bound");

// Server moves to Page5 independently. The diagnostics edge is logged once,
// with no repeated per-poll event, while the reported client remains on Page4.
registry.observeAuthoritativePage({
    roomId: "room-a", gameId: "game-a", page: "PAGE5_GAME", phase: "SELF_TEST", at: 3_000
});
assert.equal(logEntries.filter((entry) => entry.message === "CLIENT_PAGE_MISMATCH").length, 1);
registry.observeAuthoritativePhase({ roomId: "room-a", gameId: "game-a", phase: "SPEED", at: 3_100 });
assert.equal(logEntries.filter((entry) => entry.message === "CLIENT_PAGE_MISMATCH").length, 2,
    "a changed authoritative phase is a significant mismatch change");

const duplicate = registry.record({ identity, socketId: "socket-2", raw: base, receivedAt: 4_000 });
assert.equal(duplicate.ok, true);
assert.equal(duplicate.duplicate, true);
assert.equal(registry.getSnapshot([], 4_000)[0].lastConfirmedPage, "PAGE4_PAYMENT");
assert.equal(registry.getSnapshot([], 4_000)[0].serverReceivedAt, 4_000,
    "reconnect replay refreshes receipt metadata without replaying old page transitions");

assert.equal(registry.record({ identity, socketId: "socket-2", raw: {
    ...base, sequenceNumber: 2, page: "PAGE5_GAME", clientEventAt: 5_000,
    uiState: { appliedPage: "PAGE5_GAME", mounted: true, visible: true, documentVisible: true }
}, receivedAt: 5_100 }).ok, true);
assert.equal(logEntries.filter((entry) => entry.message === "CLIENT_PAGE_MISMATCH_RESOLVED").length, 1);
assert.equal(registry.getSnapshot([], 5_100)[0].pageMatchesServer, true);
assert.equal(registry.getSnapshot([], 5_100)[0].requestedPage, null);
assert.equal(registry.record({ identity, socketId: "socket-2", raw: base, receivedAt: 5_200 }).reason,
    "STALE_SEQUENCE");
assert.equal(registry.record({ identity, socketId: "socket-2", raw: {
    ...base, sequenceNumber: 3, roomId: "other-room"
}, receivedAt: 5_300 }).reason, "ROOM_BINDING_MISMATCH");
assert.equal(registry.record({ identity, socketId: "socket-2", raw: {
    ...base, sequenceNumber: 3, playerId: "spoofed"
}, receivedAt: 5_300 }).reason, "PLAYER_BINDING_MISMATCH");
assert.equal(registry.record({ identity, socketId: "socket-2", raw: {
    ...base, sequenceNumber: 3, gameId: "spoofed-game"
}, receivedAt: 5_300 }).reason, "GAME_BINDING_MISMATCH");

assert.equal(registry.record({ identity, socketId: "socket-2", raw: {
    ...base,
    sequenceNumber: 3,
    requestedPage: "PAGE5_GAME",
    requestedFromPage: "PAGE4_PAYMENT",
    navigationRequestedAt: 5_250,
    uiState: { appliedPage: "PAGE4_PAYMENT", mounted: true, visible: false,
        documentVisible: true, topmostAtSample: false, blockingUi: ["overlay"] }
}, receivedAt: 5_350 }).ok, true);
assert.equal(registry.getSnapshot([], 5_350)[0].requestedPage, "PAGE5_GAME");
assert.equal(logEntries.some((entry) => entry.message === "CLIENT_UI_STATE_MISMATCH"), true,
    "route and visible UI disagreement is edge-logged for diagnostics");

registry.markDisconnected("socket-2", 5_400);
const stale = registry.getSnapshot([], 5_401)[0];
assert.equal(stale.socketConnected, false);
assert.equal(stale.stale, true);
const withMissingPlayer = registry.getSnapshot([
    { roomId: "room-b", gameId: null, playerId: "player-no-report", connectionState: "CONNECTED" }
], 5_401);
assert.equal(withMissingPlayer.find((row) => row.playerId === "player-no-report").missingConfirmation, true);

// Exercise the real SocketGateway event binding: telemetry is authenticated by
// the server socket binding and has no EventBus/game-start side effect.
const handlerMap = new Map();
const socket = {
    id: "socket-bound",
    on: (name, handler) => handlerMap.set(name, handler)
};
let eventBusEmits = 0;
let boundIdentity = identity;
const gateway = new SocketGateway({
    logger,
    socketConfig: {},
    eventBus: { emit: () => { eventBusEmits += 1; } },
    gameplayContextResolver: {
        resolve: () => ({ ok: false }),
        resolveRoomPlayer: () => boundIdentity
    },
    clientPageConfirmationRegistry: registry
});
gateway._handleConnection(socket);
let acknowledgement = null;
handlerMap.get(LOBBY_CLIENT_EVENTS.CLIENT_PAGE_CONFIRMED)(
    { ...base, sequenceNumber: 4, page: "PAGE5_GAME", clientEventAt: 6_000 },
    (result) => { acknowledgement = result; }
);
assert.equal(acknowledgement.ok, true);
assert.equal(eventBusEmits, 0, "page confirmation is never forwarded into gameplay authorization");

// FINISH resets client identity before the final Page1 report is sampled.
// The same socket may use only its previously server-bound registry identity.
boundIdentity = { ok: false, reason: "room binding already released" };
handlerMap.get(LOBBY_CLIENT_EVENTS.CLIENT_PAGE_CONFIRMED)(
    {
        roomId: null,
        gameId: null,
        playerId: null,
        page: "PAGE1_WELCOME",
        sequenceNumber: 5,
        clientEventAt: 7_000,
        uiState: { appliedPage: "PAGE1_WELCOME", mounted: true, visible: true,
            documentVisible: true, topmostAtSample: true, blockingUi: [] }
    },
    (result) => { acknowledgement = result; }
);
assert.equal(acknowledgement.ok, true,
    "final Page1 report should use the same socket's previously trusted binding");
assert.equal(registry.getSnapshot([], 7_000).find((row) => row.roomId === identity.roomId)
    .lastConfirmedPage, "PAGE1_WELCOME");

console.log("clientPageConfirmation.r60.test.js: all assertions passed");
