/**
 * R18.XSDd — RoomLobbyBridge._handleSocketDisconnected must not reference an
 * undeclared `contract`. The diagnostic block previously threw
 * "ReferenceError: contract is not defined" for EVERY socket disconnect
 * (before the unknown-socket guard), breaking disconnect handling in the
 * active Room Wallet payment flow. Diagnostics are now based on the current
 * Room Wallet / payment-session state.
 */
import assert from "node:assert/strict";

import { EventBus } from "../events/EventBus.js";
import { CONNECTION_STATE } from "../models/ConnectionState.js";
import {
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS
} from "../models/PaymentSession.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { LoggerService } from "../services/LoggerService.js";
import { GameplayContextResolver } from "../socket/GameplayContextResolver.js";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";

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
        roomManager,
        roomConfig: { setupDurationMs: 10 * 60 * 1000 }
    });

    setupSessionLifecycle.initialize();

    roomManager.attachSetupSessionLifecycle(setupSessionLifecycle);

    // Minimal PaymentSessionManager view used by the disconnect diagnostics.
    const paymentSession = {
        roomId: null,
        paymentSessionId: "pay-disconnect",
        status: PAYMENT_SESSION_STATUS.FULLY_PAID,
        roomWalletAddress: "EQroom-wallet-disconnect",
        participants: [
            { playerId: "p1", status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED },
            { playerId: "p2", status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED },
            { playerId: "p3", status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED }
        ]
    };

    const paymentSessionManager = {
        getSession(roomId) {

            return roomId ? paymentSession : null;

        },
        isRoomWalletPaymentIntakeEnabled() {

            return true;

        }
    };

    const roomLobbyBridge = new RoomLobbyBridge({
        logger,
        eventBus,
        roomManager,
        playerManager,
        gameplayContextResolver,
        setupSessionLifecycle,
        paymentSessionManager
    });

    roomLobbyBridge.initialize();

    return {
        logger,
        eventBus,
        playerManager,
        roomManager,
        roomLobbyBridge,
        paymentSession,
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

// F.1 — unknown socket: the diagnostic block runs before the context guard,
// so it must survive with no payment session and no bound player.
{

    const stack = buildStack();

    stack.roomLobbyBridge._handleSocketDisconnected(
        "socket-never-bound",
        "transport close"
    );

    stack.shutdown();

    console.log("  F.1 unknown-socket disconnect (no ReferenceError) passed");

}

// F.2 — bound player during the payment stage: diagnostics include the
// Room Wallet / payment-session state; protected session soft-disconnects.
{

    const stack = buildStack();

    const room = stack.roomManager.createRoom();

    const player = stack.playerManager.createPlayer({ nickname: "Host" });

    const playerId = player.identity.playerId;

    stack.roomManager.addPlayer(room.roomId, playerId);

    stack.playerManager.updateRuntime(playerId, { roomId: room.roomId });

    stack.roomLobbyBridge._registerSocketPlayer("socket-live", playerId);

    stack.roomLobbyBridge._attachSocketToRoom("socket-live", room.roomId);

    stack.playerManager.setConnectionState(playerId, CONNECTION_STATE.CONNECTED);

    stack.paymentSession.roomId = room.roomId;

    stack.roomLobbyBridge._handleSocketDisconnected("socket-live", "transport close");

    assert.equal(
        stack.playerManager.hasPlayer(playerId),
        true,
        "protected (setup-active) soft disconnect keeps the player entity"
    );

    stack.shutdown();

    console.log("  F.2 bound-player disconnect with payment state passed");

}

console.log("socketDisconnect.roomWalletDiagnostics.test.js passed");
