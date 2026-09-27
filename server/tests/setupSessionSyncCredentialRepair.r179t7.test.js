/**
 * R17.9T.7 — Minimal recoveryCredential repair.
 *
 * Stage 1 (AI_CONTEXT/CLINE_REPORTS/2026-09-27_stage1_recovery_identity_inspection.md)
 * found that RecoveryCredentialStore keeps only SHA-256 hashes, so a lost
 * plaintext can never be re-delivered — but it CAN be re-issued. This stage
 * attaches a freshly issued recoveryCredential to SETUP_SESSION_SYNC on the
 * already-authorized private delivery path only
 * (RoomLobbyBridge._deliverSetupSessionSync, used by _handleCreateRoom /
 * _handleJoinRoom on a socket just bound by the server-owned socket→player
 * binding).
 *
 * Contract under test:
 * 1. A socket authoritatively bound to the room receives a SETUP_SESSION_SYNC
 *    payload carrying a fresh recoveryCredential that validates.
 * 2. Re-issuance replaces the prior credential hash (old plaintext invalid).
 * 3. The frozen snapshot fields are preserved in the delivered copy.
 * 4. An UNBOUND socket (or a socket bound to a different room) receives the
 *    sync payload WITHOUT any recoveryCredential — no credential is exposed
 *    outside the authorized private path.
 * 5. An unbound SESSION_RECOVERY_REQUEST with a missing credential is still
 *    rejected (RECOVERY_AUTH_MISSING) — authorization is NOT weakened.
 *
 * No payment, VERIFY, GameStartAuthorization, Room Wallet, or TON logic is
 * exercised or modified here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { CONNECTION_STATE } from "../models/ConnectionState.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { LoggerService } from "../services/LoggerService.js";
import { GameplayContextResolver } from "../socket/GameplayContextResolver.js";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { LOBBY_SERVER_EVENTS } from "../socket/lobbyProtocol.js";
import {
    RECOVERY_AUTH_REASONS
} from "../gameplay/RecoveryCredentialStore.js";

function buildStack() {

    const logger = new LoggerService({ logLevel: "error" });

    logger.initialize();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

    const roomManager = new RoomManager({
        logger,
        eventBus,
        roomConfig: { maxPlayers: 3 }
    });

    roomManager.initialize();

    const gameplayContextResolver = new GameplayContextResolver({
        logger,
        playerManager,
        roomManager
    });

    const setupSessionLifecycle = new SetupSessionLifecycle({
        logger,
        eventBus,
        roomManager
    });

    setupSessionLifecycle.initialize();

    roomManager.attachSetupSessionLifecycle(setupSessionLifecycle);

    const roomLobbyBridge = new RoomLobbyBridge({
        logger,
        eventBus,
        roomManager,
        playerManager,
        gameplayContextResolver,
        setupSessionLifecycle
    });

    roomLobbyBridge.initialize();

    const setupSyncDeliveries = [];

    eventBus.subscribe(EVENT_TYPES.LOBBY_SOCKET_DELIVERY, (envelope) => {

        if (envelope.payload?.event !== LOBBY_SERVER_EVENTS.SETUP_SESSION_SYNC) {

            return;

        }

        setupSyncDeliveries.push(envelope.payload);

    });

    return {
        logger,
        eventBus,
        playerManager,
        roomManager,
        setupSessionLifecycle,
        roomLobbyBridge,
        gameplayContextResolver,
        setupSyncDeliveries,
        shutdown() {

            roomLobbyBridge.shutdown();

            setupSessionLifecycle.shutdown();

            roomManager.shutdown();

            playerManager.shutdown();

            eventBus.shutdown();

            logger.shutdown();

        }
    };

}

function seatPlayer(stack, { socketId, nickname = "P" } = {}) {

    const room = stack.roomManager.createRoom();

    const player = stack.playerManager.createPlayer({ nickname });

    const playerId = player.identity.playerId;

    stack.roomManager.addPlayer(room.roomId, playerId);

    stack.playerManager.updateRuntime(playerId, { roomId: room.roomId });

    // Server-owned socket→player binding — the authoritative private path.
    stack.roomLobbyBridge._registerSocketPlayer(socketId, playerId);

    stack.roomLobbyBridge._attachSocketToRoom(socketId, room.roomId);

    stack.playerManager.setConnectionState(playerId, CONNECTION_STATE.CONNECTED);

    const recoveryCredential = stack.roomLobbyBridge.issueRecoveryCredential(
        playerId,
        room.roomId
    );

    return {
        roomId: room.roomId,
        playerId,
        recoveryCredential
    };

}

function captureSetupSyncFor(stack, socketId) {

    const delivery = stack.setupSyncDeliveries.find(
        (candidate) => candidate.socketId === socketId
    );

    assert(delivery, "SETUP_SESSION_SYNC must be delivered to the socket");

    return delivery.payload;

}

console.log("R17.9T.7 recoveryCredential setup-sync repair tests");

// 1. (A) Already-authorized private path carries a fresh, valid credential.

test("R17.9T.7 SETUP_SESSION_SYNC on bound socket carries fresh recoveryCredential", () => {

    const stack = buildStack();

    try {

        const seat = seatPlayer(stack, { socketId: "sock-bound", nickname: "A" });

        stack.roomLobbyBridge._deliverSetupSessionSync(
            seat.roomId,
            "sock-bound"
        );

        const syncPayload = captureSetupSyncFor(stack, "sock-bound");

        assert.equal(syncPayload.roomId, seat.roomId, "1. roomId must be preserved");

        // Fresh plaintext credential present and non-empty.
        assert.equal(
            typeof syncPayload.recoveryCredential,
            "string",
            "1. payload must carry a plaintext recoveryCredential"
        );

        assert.ok(
            syncPayload.recoveryCredential.length > 0,
            "1. recoveryCredential must be non-empty"
        );

        // The fresh credential validates through the unchanged validator.
        const auth = stack.roomLobbyBridge.authorizeRecoveryCredential({
            playerId: seat.playerId,
            roomId: seat.roomId,
            credential: syncPayload.recoveryCredential
        });

        assert.equal(auth.ok, true, "1. re-issued credential must validate");

        // Snapshot fields are preserved in the delivered derived copy.
        assert.ok(
            syncPayload.setupSessionId && syncPayload.expiresAt,
            "1. snapshot fields must be preserved"
        );

        // Re-issuance replaced the prior hash: the old plaintext no longer
        // validates (single-player stack → INVALID, not PLAYER_MISMATCH).
        const oldAuth = stack.roomLobbyBridge.authorizeRecoveryCredential({
            playerId: seat.playerId,
            roomId: seat.roomId,
            credential: seat.recoveryCredential
        });

        assert.equal(
            oldAuth.ok,
            false,
            "1. superseded credential must no longer validate"
        );

        console.log("  1. bound socket → fresh valid recoveryCredential delivered");

    } finally {

        stack.shutdown();

    }

});

// 2. (A negative) Unbound / cross-room sockets receive NO credential.

test("R17.9T.7 unbound or cross-room socket gets no recoveryCredential", () => {

    const stack = buildStack();

    try {

        const seatA = seatPlayer(stack, { socketId: "sock-a", nickname: "A" });

        const seatB = seatPlayer(stack, { socketId: "sock-b", nickname: "B" });

        // Fully unbound socket.
        stack.roomLobbyBridge._deliverSetupSessionSync(
            seatA.roomId,
            "sock-unbound"
        );

        const unboundPayload = captureSetupSyncFor(stack, "sock-unbound");

        assert.equal(
            "recoveryCredential" in unboundPayload,
            false,
            "2. unbound socket payload must not carry a recoveryCredential"
        );

        // Socket bound to room B must not receive a credential for room A.
        stack.roomLobbyBridge._deliverSetupSessionSync(
            seatA.roomId,
            "sock-b"
        );

        const crossRoomPayload = captureSetupSyncFor(stack, "sock-b");

        assert.equal(
            "recoveryCredential" in crossRoomPayload,
            false,
            "2. cross-room socket payload must not carry a recoveryCredential"
        );

        console.log("  2. unbound / cross-room socket → no credential exposed");

    } finally {

        stack.shutdown();

    }

});

// 3. (C) Unbound recovery request with a missing credential still fails closed.

test("R17.9T.7 unbound recovery request without credential still rejected", () => {

    const stack = buildStack();

    try {

        const seat = seatPlayer(stack, { socketId: "sock-a", nickname: "A" });

        stack.roomLobbyBridge._handleSocketDisconnected("sock-a");

        const reclaim = stack.roomLobbyBridge.reconnectSession(
            "sock-new",
            {
                playerId: seat.playerId,
                roomId: seat.roomId
            }
        );

        assert.equal(
            reclaim.ok,
            false,
            "3. playerId claim without credential must be rejected"
        );

        assert.equal(
            reclaim.reason,
            "Recovery identity is not authorized for this socket",
            "3. denial reason must be unchanged"
        );

        const auth = stack.roomLobbyBridge.authorizeRecoveryCredential({
            playerId: seat.playerId,
            roomId: seat.roomId,
            credential: null
        });

        assert.equal(
            auth.ok,
            false,
            "3. authorizeRecoveryCredential must fail for a missing credential"
        );

        assert.equal(
            auth.reason,
            RECOVERY_AUTH_REASONS.MISSING,
            "3. reason must remain RECOVERY_AUTH_MISSING"
        );

        console.log("  3. missing credential → RECOVERY_AUTH_MISSING (unchanged)");

    } finally {

        stack.shutdown();

    }

});

