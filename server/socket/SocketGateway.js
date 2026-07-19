import { Server } from "socket.io";

import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    GAME_MESSAGE_CHANNEL,
    LOBBY_CLIENT_EVENTS,
    SOCKET_EVENTS
} from "./events.js";
import {
    isGameplayClientMessageType,
    isGameplayInputMessageType,
    isRecoveryRequestMessageType,
    normalizeGameplayMessage
} from "./gameplaySocketProtocol.js";
import {
    buildClientRecoveryPayload,
    buildRecoveryFailedMessage,
    buildRecoverySnapshotMessage
} from "./gameplayRecoveryProtocol.js";
import {
    buildPhysicsSyncMessage
} from "./gameplayPhysicsProtocol.js";
import {
    buildGameStateSyncMessage
} from "./gameplayGameStateProtocol.js";
import {
    buildGameClockUpdateMessage
} from "./gameplayClockProtocol.js";
import {
    buildInputAcceptedMessage,
    buildInputRejectedMessage
} from "./gameplayInputProtocol.js";
import {
    buildWinnerResultMessage
} from "./gameplayWinnerProtocol.js";
import {
    buildPaymentStatusMessage
} from "./gameplayPaymentProtocol.js";
import {
    buildAuditStatusMessage,
    AUDIT_CLIENT_STATUS
} from "./gameplayAuditProtocol.js";

export class SocketGateway {

    constructor({
        logger,
        socketConfig,
        eventBus = null,
        inputAuthority = null,
        gameplayContextResolver = null,
        recoveryEngine = null,
        recoverySnapshotCache = null,
        paymentEngine = null,
        auditEngine = null,
        roomLobbyBridge = null,
        devMode = false
    }) {

        this._logger = logger;

        this._socketConfig = socketConfig;

        this._eventBus = eventBus;

        this._inputAuthority = inputAuthority;

        this._gameplayContextResolver = gameplayContextResolver;

        this._recoveryEngine = recoveryEngine;

        this._recoverySnapshotCache = recoverySnapshotCache;

        this._paymentEngine = paymentEngine;

        this._auditEngine = auditEngine;

        this._roomLobbyBridge = roomLobbyBridge;

        this._devMode = devMode;

        this._io = null;

        this._initialized = false;

        this._testEventHandler = null;

        this._deliveryHandler = null;

        this._physicsUpdatedHandler = null;

        this._gameStateChangedHandler = null;

        this._playerInputAcceptedHandler = null;

        this._playerInputRejectedHandler = null;

        this._winnerDeterminedHandler = null;

        this._paymentStartedHandler = null;

        this._paymentCompletedHandler = null;

        this._paymentFailedHandler = null;

        this._auditStartedHandler = null;

        this._auditReadyHandler = null;

        this._auditFailedHandler = null;

        this._clockUpdateHandler = null;

        this._socketRooms = new Map();

        this._eventBusConnected = false;

    }

    connectEventBus(eventBus) {

        if (this._eventBusConnected) {

            return;

        }

        this._eventBus = eventBus;

        this._eventBusConnected = true;

        this._testEventHandler = (envelope) => {

            this._logger.debug(
                `SocketGateway received event: ${envelope.type} (${envelope.eventId})`
            );

        };

        eventBus.subscribe(EVENT_TYPES.TEST_EVENT, this._testEventHandler);

        this._deliveryHandler = (envelope) => {

            this._handleLobbyDelivery(envelope.payload);

        };

        eventBus.subscribe(
            EVENT_TYPES.LOBBY_SOCKET_DELIVERY,
            this._deliveryHandler
        );

        this._physicsUpdatedHandler = (envelope) => {

            this._handlePhysicsUpdated(envelope.payload);

        };

        eventBus.subscribe(
            EVENT_TYPES.PHYSICS_UPDATED,
            this._physicsUpdatedHandler
        );

        this._gameStateChangedHandler = (envelope) => {

            this._handleGameStateChanged(envelope.payload);

        };

        eventBus.subscribe(
            EVENT_TYPES.GAME_STATE_CHANGED,
            this._gameStateChangedHandler
        );

        this._clockUpdateHandler = (envelope) => {

            this._handleClockUpdate(envelope.payload);

        };

        eventBus.subscribe(
            EVENT_TYPES.CLOCK_UPDATE,
            this._clockUpdateHandler
        );

        this._playerInputAcceptedHandler = (envelope) => {

            this._handlePlayerInputAccepted(envelope.payload);

        };

        eventBus.subscribe(
            EVENT_TYPES.PLAYER_INPUT_ACCEPTED,
            this._playerInputAcceptedHandler
        );

        this._playerInputRejectedHandler = (envelope) => {

            this._handlePlayerInputRejected(envelope.payload);

        };

        eventBus.subscribe(
            EVENT_TYPES.PLAYER_INPUT_REJECTED,
            this._playerInputRejectedHandler
        );

        this._winnerDeterminedHandler = (envelope) => {

            this._handleWinnerDetermined(envelope.payload);

        };

        eventBus.subscribe(
            EVENT_TYPES.WINNER_DETERMINED,
            this._winnerDeterminedHandler
        );

        this._paymentStartedHandler = (envelope) => {

            this._handlePaymentEvent(
                EVENT_TYPES.PAYMENT_STARTED,
                envelope.payload
            );

        };

        eventBus.subscribe(
            EVENT_TYPES.PAYMENT_STARTED,
            this._paymentStartedHandler
        );

        this._paymentCompletedHandler = (envelope) => {

            this._handlePaymentEvent(
                EVENT_TYPES.PAYMENT_COMPLETED,
                envelope.payload
            );

        };

        eventBus.subscribe(
            EVENT_TYPES.PAYMENT_COMPLETED,
            this._paymentCompletedHandler
        );

        this._paymentFailedHandler = (envelope) => {

            this._handlePaymentEvent(
                EVENT_TYPES.PAYMENT_FAILED,
                envelope.payload
            );

        };

        eventBus.subscribe(
            EVENT_TYPES.PAYMENT_FAILED,
            this._paymentFailedHandler
        );

        this._auditStartedHandler = (envelope) => {

            this._handleAuditEvent(
                EVENT_TYPES.AUDIT_STARTED,
                envelope.payload
            );

        };

        eventBus.subscribe(
            EVENT_TYPES.AUDIT_STARTED,
            this._auditStartedHandler
        );

        this._auditReadyHandler = (envelope) => {

            this._handleAuditEvent(
                EVENT_TYPES.AUDIT_READY,
                envelope.payload
            );

        };

        eventBus.subscribe(
            EVENT_TYPES.AUDIT_READY,
            this._auditReadyHandler
        );

        this._auditFailedHandler = (envelope) => {

            this._handleAuditEvent(
                EVENT_TYPES.AUDIT_FAILED,
                envelope.payload
            );

        };

        eventBus.subscribe(
            EVENT_TYPES.AUDIT_FAILED,
            this._auditFailedHandler
        );

    }

    disconnectEventBus() {

        if (this._eventBus && this._testEventHandler) {

            this._eventBus.unsubscribe(
                EVENT_TYPES.TEST_EVENT,
                this._testEventHandler
            );

        }

        if (this._eventBus && this._deliveryHandler) {

            this._eventBus.unsubscribe(
                EVENT_TYPES.LOBBY_SOCKET_DELIVERY,
                this._deliveryHandler
            );

        }

        if (this._eventBus && this._physicsUpdatedHandler) {

            this._eventBus.unsubscribe(
                EVENT_TYPES.PHYSICS_UPDATED,
                this._physicsUpdatedHandler
            );

        }

        if (this._eventBus && this._gameStateChangedHandler) {

            this._eventBus.unsubscribe(
                EVENT_TYPES.GAME_STATE_CHANGED,
                this._gameStateChangedHandler
            );

        }

        if (this._eventBus && this._clockUpdateHandler) {

            this._eventBus.unsubscribe(
                EVENT_TYPES.CLOCK_UPDATE,
                this._clockUpdateHandler
            );

        }

        if (this._eventBus && this._playerInputAcceptedHandler) {

            this._eventBus.unsubscribe(
                EVENT_TYPES.PLAYER_INPUT_ACCEPTED,
                this._playerInputAcceptedHandler
            );

        }

        if (this._eventBus && this._playerInputRejectedHandler) {

            this._eventBus.unsubscribe(
                EVENT_TYPES.PLAYER_INPUT_REJECTED,
                this._playerInputRejectedHandler
            );

        }

        if (this._eventBus && this._winnerDeterminedHandler) {

            this._eventBus.unsubscribe(
                EVENT_TYPES.WINNER_DETERMINED,
                this._winnerDeterminedHandler
            );

        }

        if (this._eventBus && this._paymentStartedHandler) {

            this._eventBus.unsubscribe(
                EVENT_TYPES.PAYMENT_STARTED,
                this._paymentStartedHandler
            );

        }

        if (this._eventBus && this._paymentCompletedHandler) {

            this._eventBus.unsubscribe(
                EVENT_TYPES.PAYMENT_COMPLETED,
                this._paymentCompletedHandler
            );

        }

        if (this._eventBus && this._paymentFailedHandler) {

            this._eventBus.unsubscribe(
                EVENT_TYPES.PAYMENT_FAILED,
                this._paymentFailedHandler
            );

        }

        if (this._eventBus && this._auditStartedHandler) {

            this._eventBus.unsubscribe(
                EVENT_TYPES.AUDIT_STARTED,
                this._auditStartedHandler
            );

        }

        if (this._eventBus && this._auditReadyHandler) {

            this._eventBus.unsubscribe(
                EVENT_TYPES.AUDIT_READY,
                this._auditReadyHandler
            );

        }

        if (this._eventBus && this._auditFailedHandler) {

            this._eventBus.unsubscribe(
                EVENT_TYPES.AUDIT_FAILED,
                this._auditFailedHandler
            );

        }

        this._eventBus = null;

        this._testEventHandler = null;

        this._deliveryHandler = null;

        this._physicsUpdatedHandler = null;

        this._gameStateChangedHandler = null;

        this._playerInputAcceptedHandler = null;

        this._playerInputRejectedHandler = null;

        this._winnerDeterminedHandler = null;

        this._paymentStartedHandler = null;

        this._paymentCompletedHandler = null;

        this._paymentFailedHandler = null;

        this._auditStartedHandler = null;

        this._auditReadyHandler = null;

        this._auditFailedHandler = null;

        this._clockUpdateHandler = null;

        this._eventBusConnected = false;

    }

    initialize(httpServer) {

        if (this._initialized) {

            return this._io;

        }

        this._io = new Server(httpServer, this._socketConfig);

        this._io.on(SOCKET_EVENTS.CONNECTION, (socket) => {

            this._handleConnection(socket);

        });

        this._initialized = true;

        return this._io;

    }

    shutdown() {

        this.disconnectEventBus();

        this._socketRooms.clear();

        if (!this._io) {

            return Promise.resolve();

        }

        return new Promise((resolve, reject) => {

            this._io.close((error) => {

                this._io = null;

                this._initialized = false;

                if (error) {

                    reject(error);

                    return;

                }

                resolve();

            });

        });

    }

    getIO() {

        return this._io;

    }

    // C4.5 — read-only operational accessor (no behavior change).
    getConnectedSocketCount() {

        return this._io?.sockets?.sockets?.size ?? 0;

    }

    configureRecovery({
        recoveryEngine,
        recoverySnapshotCache,
        paymentEngine,
        auditEngine,
        roomLobbyBridge
    }) {

        if (recoveryEngine) {

            this._recoveryEngine = recoveryEngine;

        }

        if (recoverySnapshotCache) {

            this._recoverySnapshotCache = recoverySnapshotCache;

        }

        if (paymentEngine) {

            this._paymentEngine = paymentEngine;

        }

        if (auditEngine) {

            this._auditEngine = auditEngine;

        }

        if (roomLobbyBridge) {

            this._roomLobbyBridge = roomLobbyBridge;

        }

    }

    _handleConnection(socket) {

        this._logger.info(`Client connected | socketId=${socket.id}`);

        socket.on(LOBBY_CLIENT_EVENTS.CREATE_ROOM, () => {

            this._emitLobbyRequest(EVENT_TYPES.LOBBY_CREATE_ROOM_REQUEST, {
                socketId: socket.id
            });

        });

        socket.on(LOBBY_CLIENT_EVENTS.JOIN_ROOM, (roomId) => {

            this._emitLobbyRequest(EVENT_TYPES.LOBBY_JOIN_ROOM_REQUEST, {
                socketId: socket.id,
                roomId
            });

        });

        socket.on(LOBBY_CLIENT_EVENTS.LEAVE_ROOM, () => {

            this._emitLobbyRequest(EVENT_TYPES.LOBBY_LEAVE_ROOM_REQUEST, {
                socketId: socket.id
            });

        });

        socket.on(LOBBY_CLIENT_EVENTS.UPDATE_PLAYER_PROFILE, (profile) => {

            this._emitLobbyRequest(EVENT_TYPES.LOBBY_UPDATE_PLAYER_PROFILE_REQUEST, {
                socketId: socket.id,
                profile
            });

        });

        socket.on(LOBBY_CLIENT_EVENTS.SUBMIT_SECRET_MATRIX, (matrix) => {

            this._emitLobbyRequest(EVENT_TYPES.LOBBY_SUBMIT_SECRET_MATRIX_REQUEST, {
                socketId: socket.id,
                matrix
            });

        });

        socket.on(LOBBY_CLIENT_EVENTS.CONFIRM_VERIFY, () => {

            this._emitLobbyRequest(EVENT_TYPES.LOBBY_CONFIRM_VERIFY_REQUEST, {
                socketId: socket.id
            });

        });

        socket.on(GAME_MESSAGE_CHANNEL, (rawMessage) => {

            this._handleGameplayMessage(socket, rawMessage);

        });

        socket.on(SOCKET_EVENTS.DISCONNECT, (reason) => {

            this._handleDisconnect(socket, reason);

        });

    }

    _handleDisconnect(socket, reason) {

        this._logger.info(
            `Client disconnected | socketId=${socket.id} | reason=${reason}`
        );

        this._emitLobbyRequest(EVENT_TYPES.LOBBY_SOCKET_DISCONNECTED, {
            socketId: socket.id,
            reason
        });

        this._socketRooms.delete(socket.id);

    }

    _handleGameplayMessage(socket, rawMessage) {

        const message = normalizeGameplayMessage(rawMessage);

        if (!message) {

            this._logGameplayDrop("malformed gameplay payload");

            return;

        }

        if (!isGameplayClientMessageType(message.type)) {

            this._logGameplayDrop(`unsupported gameplay message: ${message.type}`);

            return;

        }

        if (isRecoveryRequestMessageType(message.type)) {

            this._handleRecoveryRequest(socket, message);

            return;

        }

        if (!isGameplayInputMessageType(message.type)) {

            this._logGameplayDrop(`unsupported gameplay message: ${message.type}`);

            return;

        }

        if (!socket?.connected) {

            this._logGameplayDrop("disconnected socket");

            return;

        }

        if (!this._inputAuthority || !this._gameplayContextResolver) {

            this._logGameplayDrop("gameplay bridge is not configured");

            return;

        }

        this._logGameplayStep(`${message.type} received`);

        const context = this._gameplayContextResolver.resolve(socket.id);

        if (!context.ok) {

            this._logGameplayDrop(context.reason);

            return;

        }

        this._logGameplayStep("Player resolved");

        this._logGameplayStep("Game resolved");

        if (message.type === EVENT_TYPES.BUTTON_PRESS) {

            this._inputAuthority.handleButtonPress(
                context.gameId,
                context.playerId
            );

        } else if (message.type === EVENT_TYPES.BUTTON_RELEASE) {

            this._inputAuthority.handleButtonRelease(
                context.gameId,
                context.playerId
            );

        }

        this._logGameplayStep("Forwarded to InputAuthority");

    }

    _handleRecoveryRequest(socket, message) {

        if (!socket?.connected) {

            this._logRecoveryDrop("disconnected socket");

            return;

        }

        if (!this._recoveryEngine) {

            this._sendRecoveryFailed(socket, {
                reason: "Recovery is not configured"
            });

            return;

        }

        this._logRecoveryStep("Recovery requested");

        let context = this._gameplayContextResolver?.resolve(socket.id);

        if (!context?.ok) {

            if (!this._roomLobbyBridge) {

                this._sendRecoveryFailed(socket, {
                    reason: context?.reason
                        ?? "Socket is not bound to a player session"
                });

                return;

            }

            const reconnected = this._roomLobbyBridge.reconnectGameplaySession(
                socket.id
            );

            if (!reconnected.ok) {

                this._sendRecoveryFailed(socket, {
                    reason: reconnected.reason,
                    gameId: reconnected.gameId ?? null
                });

                return;

            }

            context = {
                ok: true,
                playerId: reconnected.playerId,
                roomId: reconnected.roomId,
                gameId: reconnected.gameId,
                setupActive: reconnected.setupActive === true
            };

        }

        const gameId = context.gameId;

        const playerId = context.playerId;

        const roomId = context.roomId;

        if (!gameId) {

            // C5.6C — Setup Session reconnect already delivered SETUP_SESSION_SYNC.
            // RecoveryEngine remains gameplay-only and must not be invoked.
            if (context.setupActive) {

                this._logRecoveryStep(
                    `Setup Session sync delivered | roomId=${roomId ?? "?"}`
                );

                return;

            }

            this._sendRecoveryFailed(socket, {
                reason: "No active gameplay session for recovery",
                playerId
            });

            return;

        }

        let authoritativeSnapshot = null;

        let paymentStatus = null;

        let payment = null;

        let auditStatus = null;

        try {

            authoritativeSnapshot = this._recoveryEngine.recoverPlayer(
                gameId,
                playerId
            );

            paymentStatus = this._paymentEngine?.getPaymentStatus(gameId) ?? null;

            payment = this._paymentEngine?.getPayment(gameId) ?? null;

            auditStatus = this._resolveAuditStatus(gameId);

        } catch {

            const cached = this._recoverySnapshotCache?.get(gameId);

            if (cached?.snapshot) {

                authoritativeSnapshot = cached.snapshot;

                paymentStatus = cached.paymentStatus ?? null;

                payment = cached.payment ?? null;

                auditStatus = cached.auditStatus ?? null;

            }

        }

        if (!authoritativeSnapshot) {

            this._sendRecoveryFailed(socket, {
                reason: "Recovery snapshot is unavailable",
                gameId,
                playerId
            });

            return;

        }

        const clientPayload = buildClientRecoveryPayload({
            snapshot: authoritativeSnapshot,
            playerId,
            roomId,
            paymentStatus,
            payment,
            auditStatus
        });

        const { channel, message: responseMessage } = buildRecoverySnapshotMessage(
            clientPayload
        );

        socket.emit(channel, responseMessage);

        this._logRecoveryStep(
            `Snapshot sent | gameState=${clientPayload.gameState ?? "?"}`
        );

    }

    _sendRecoveryFailed(socket, { reason, gameId = null, playerId = null }) {

        const { channel, message } = buildRecoveryFailedMessage({
            reason,
            gameId,
            playerId
        });

        socket.emit(channel, message);

        this._logRecoveryStep(`Recovery failed | reason=${reason}`);

    }

    _logRecoveryStep(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.debug(`[RecoverySync] ${message}`);

    }

    _logRecoveryDrop(reason) {

        if (!this._devMode) {

            return;

        }

        this._logger.debug(`[RecoverySync] Dropped: ${reason}`);

    }

    _logGameplayStep(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.debug(`[GameplaySocket] ${message}`);

    }

    _logGameplayDrop(reason) {

        if (!this._devMode) {

            return;

        }

        this._logger.debug(`[GameplaySocket] Dropped: ${reason}`);

    }

    _handlePhysicsUpdated(physicsPayload) {

        if (!this._io || !physicsPayload?.gameId) {

            return;

        }

        if (!this._gameplayContextResolver) {

            this._logPhysicsSyncDrop("gameplay context resolver is not configured");

            return;

        }

        const roomId = this._gameplayContextResolver
            .resolveRoomByGameId(physicsPayload.gameId);

        if (!roomId) {

            this._logPhysicsSyncDrop(
                `no active room for gameId=${physicsPayload.gameId}`
            );

            return;

        }

        this._logPhysicsSyncStep("PHYSICS_UPDATED");

        const { channel, message } = buildPhysicsSyncMessage(physicsPayload);

        this._io.to(roomId).emit(channel, message);

        this._logPhysicsSyncStep("Physics packet sent");

    }

    _handleGameStateChanged(statePayload) {

        if (!this._io || !statePayload?.gameId) {

            return;

        }

        if (!this._gameplayContextResolver) {

            this._logGameStateSyncDrop(
                "gameplay context resolver is not configured"
            );

            return;

        }

        const roomId = this._gameplayContextResolver
            .resolveRoomByGameId(statePayload.gameId);

        if (!roomId) {

            this._logGameStateSyncDrop(
                `no active room for gameId=${statePayload.gameId}`
            );

            return;

        }

        this._logGameStateSyncStep(
            `GAME_STATE_CHANGED → ${statePayload.currentState}`
        );

        const { channel, message } = buildGameStateSyncMessage(statePayload);

        this._io.to(roomId).emit(channel, message);

        this._logGameStateSyncStep("Client updated");

    }

    _handleClockUpdate(clockPayload) {

        if (!this._io || !clockPayload?.gameId) {

            return;

        }

        if (!this._gameplayContextResolver) {

            return;

        }

        const roomId = this._gameplayContextResolver
            .resolveRoomByGameId(clockPayload.gameId);

        if (!roomId) {

            return;

        }

        const { channel, message } = buildGameClockUpdateMessage(clockPayload);

        this._io.to(roomId).emit(channel, message);

    }

    _handlePlayerInputAccepted(inputPayload) {

        this._forwardInputAck(inputPayload, true);

    }

    _handlePlayerInputRejected(inputPayload) {

        this._forwardInputAck(inputPayload, false);

    }

    _forwardInputAck(inputPayload, accepted) {

        if (!this._io || !inputPayload?.gameId) {

            return;

        }

        if (!this._gameplayContextResolver) {

            this._logInputSyncDrop("gameplay context resolver is not configured");

            return;

        }

        const roomId = this._gameplayContextResolver
            .resolveRoomByGameId(inputPayload.gameId);

        if (!roomId) {

            this._logInputSyncDrop(
                `no active room for gameId=${inputPayload.gameId}`
            );

            return;

        }

        const eventType = accepted
            ? EVENT_TYPES.PLAYER_INPUT_ACCEPTED
            : EVENT_TYPES.PLAYER_INPUT_REJECTED;

        this._logInputSyncStep(
            `${eventType} → gameState=${inputPayload.gameState ?? "unknown"}`
        );

        const { channel, message } = accepted
            ? buildInputAcceptedMessage(inputPayload)
            : buildInputRejectedMessage(inputPayload);

        this._io.to(roomId).emit(channel, message);

        this._logInputSyncStep("Input ack sent");

    }

    _handleWinnerDetermined(winnerPayload) {

        if (!this._io || !winnerPayload?.gameId) {

            return;

        }

        if (!this._gameplayContextResolver) {

            this._logWinnerSyncDrop("gameplay context resolver is not configured");

            return;

        }

        const roomId = this._gameplayContextResolver
            .resolveRoomByGameId(winnerPayload.gameId);

        if (!roomId) {

            this._logWinnerSyncDrop(
                `no active room for gameId=${winnerPayload.gameId}`
            );

            return;

        }

        this._logWinnerSyncStep(
            `WINNER_DETERMINED → player=${winnerPayload.winningPlayerId}`
        );

        const { channel, message } = buildWinnerResultMessage(winnerPayload);

        this._io.to(roomId).emit(channel, message);

        this._logWinnerSyncStep("Winner result sent");

    }

    _handlePaymentEvent(eventType, paymentPayload) {

        if (!this._io || !paymentPayload?.gameId) {

            return;

        }

        if (!this._gameplayContextResolver) {

            this._logPaymentSyncDrop("gameplay context resolver is not configured");

            return;

        }

        const roomId = this._gameplayContextResolver
            .resolveRoomByGameId(paymentPayload.gameId);

        if (!roomId) {

            this._logPaymentSyncDrop(
                `no active room for gameId=${paymentPayload.gameId}`
            );

            return;

        }

        const { channel, message } = buildPaymentStatusMessage(
            eventType,
            paymentPayload
        );

        this._logPaymentSyncStep(`${eventType} → ${message.payload.status}`);

        this._io.to(roomId).emit(channel, message);

        this._logPaymentSyncStep("Payment status sent");

    }

    _handleAuditEvent(eventType, auditPayload) {

        if (!this._io || !auditPayload?.gameId) {

            return;

        }

        if (!this._gameplayContextResolver) {

            this._logAuditSyncDrop("gameplay context resolver is not configured");

            return;

        }

        const roomId = this._gameplayContextResolver
            .resolveRoomByGameId(auditPayload.gameId);

        if (!roomId) {

            this._logAuditSyncDrop(
                `no active room for gameId=${auditPayload.gameId}`
            );

            return;

        }

        const { channel, message } = buildAuditStatusMessage(
            eventType,
            auditPayload
        );

        this._logAuditSyncStep(`${eventType} → ${message.payload.status}`);

        this._io.to(roomId).emit(channel, message);

        this._logAuditSyncStep("Audit status sent");

    }

    _resolveAuditStatus(gameId) {

        if (!this._auditEngine) {

            return null;

        }

        return this._auditEngine.getAuditReport(gameId)
            ? AUDIT_CLIENT_STATUS.READY
            : null;

    }

    _logAuditSyncStep(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.debug(`[AuditSync] ${message}`);

    }

    _logAuditSyncDrop(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.debug(`[AuditSync] dropped | ${message}`);

    }

    _logPaymentSyncStep(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.debug(`[PaymentSync] ${message}`);

    }

    _logPaymentSyncDrop(reason) {

        if (!this._devMode) {

            return;

        }

        this._logger.debug(`[PaymentSync] Dropped: ${reason}`);

    }

    _logWinnerSyncStep(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.debug(`[WinnerSync] ${message}`);

    }

    _logWinnerSyncDrop(reason) {

        if (!this._devMode) {

            return;

        }

        this._logger.debug(`[WinnerSync] Dropped: ${reason}`);

    }

    _logInputSyncStep(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.debug(`[InputSync] ${message}`);

    }

    _logInputSyncDrop(reason) {

        if (!this._devMode) {

            return;

        }

        this._logger.debug(`[InputSync] Dropped: ${reason}`);

    }

    _logGameStateSyncStep(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.debug(`[GameStateSync] ${message}`);

    }

    _logGameStateSyncDrop(reason) {

        if (!this._devMode) {

            return;

        }

        this._logger.debug(`[GameStateSync] Dropped: ${reason}`);

    }

    _logPhysicsSyncStep(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.debug(`[PhysicsSync] ${message}`);

    }

    _logPhysicsSyncDrop(reason) {

        if (!this._devMode) {

            return;

        }

        this._logger.debug(`[PhysicsSync] Dropped: ${reason}`);

    }

    _emitLobbyRequest(type, payload) {

        if (!this._eventBus) {

            return;

        }

        this._eventBus.emit({
            source: EVENT_SOURCES.SOCKET_GATEWAY,
            type,
            payload
        });

    }

    _handleLobbyDelivery(delivery) {

        if (!this._io) {

            return;

        }

        if (delivery.target === "join") {

            const socket = this._io.sockets.sockets.get(delivery.socketId);

            if (!socket) {

                return;

            }

            socket.join(delivery.roomId);

            this._socketRooms.set(delivery.socketId, delivery.roomId);

            return;

        }

        if (delivery.target === "leave") {

            const roomId = this._socketRooms.get(delivery.socketId);

            const socket = this._io.sockets.sockets.get(delivery.socketId);

            if (socket && roomId) {

                socket.leave(roomId);

            }

            this._socketRooms.delete(delivery.socketId);

            return;

        }

        if (delivery.target === "socket") {

            const socket = this._io.sockets.sockets.get(delivery.socketId);

            if (socket) {

                socket.emit(delivery.event, delivery.payload);

            }

            return;

        }

        if (delivery.target === "room") {

            this._io.to(delivery.roomId).emit(
                delivery.event,
                delivery.payload
            );

        }

    }

}
