import { EventBus } from "../../events/EventBus.js";
import { EVENT_SOURCES } from "../../events/EventSources.js";
import { EVENT_TYPES } from "../../events/EventTypes.js";
import { SetupSessionLifecycle } from "../../gameplay/SetupSessionLifecycle.js";
import { PlayerManager } from "../../managers/PlayerManager.js";
import { RoomManager } from "../../managers/RoomManager.js";
import { LoggerService } from "../../services/LoggerService.js";
import { LOBBY_SERVER_EVENTS } from "../../socket/lobbyProtocol.js";
import { RoomLobbyBridge } from "../../socket/RoomLobbyBridge.js";

export function createServerOwnedRoomNetworkHarness({
    network,
    withHandoffStore = false
}) {
    const originalNetwork = process.env.TON_NETWORK;
    process.env.TON_NETWORK = network;

    const logger = new LoggerService({ logLevel: "error" });
    logger.initialize();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();

    const roomManager = new RoomManager({
        logger,
        eventBus,
        roomConfig: { maxPlayers: 3, maxConcurrentRooms: 64, setupDurationMs: 60_000 }
    });
    const playerManager = new PlayerManager({ logger, eventBus });
    const setupSessionLifecycle = new SetupSessionLifecycle({
        logger,
        eventBus,
        roomManager,
        roomConfig: { setupDurationMs: 60_000 }
    });

    roomManager.initialize();
    playerManager.initialize();
    setupSessionLifecycle.initialize();
    roomManager.attachSetupSessionLifecycle(setupSessionLifecycle);

    const identities = new Map();
    const deliveries = [];
    const bridge = new RoomLobbyBridge({
        logger,
        eventBus,
        roomManager,
        playerManager,
        setupSessionLifecycle,
        telegramIdentityResolver: (socketId) => identities.get(socketId) ?? null
    });
    bridge.initialize();

    const handoffStore = withHandoffStore ? {
        createCalls: [],
        releaseCalls: [],
        create(input) {
            this.createCalls.push({ ...input });
            return {
                handoffId: "synthetic-handoff-id",
                targetNetwork: "mainnet",
                expiresAt: Date.now() + 60_000
            };
        },
        release(handoffId) {
            this.releaseCalls.push(handoffId);
            return { ok: true };
        }
    } : null;

    if (handoffStore) bridge.configureRoomNetworkHandoffStore(handoffStore);

    eventBus.subscribe(EVENT_TYPES.LOBBY_SOCKET_DELIVERY, (envelope) => {
        deliveries.push(envelope.payload);
    });

    function emit(type, payload) {
        eventBus.emit({
            source: EVENT_SOURCES.SOCKET_GATEWAY,
            type,
            payload
        });
    }

    function socketDelivery(socketId, event = null) {
        return [...deliveries].reverse().find((delivery) =>
            delivery.target === "socket"
            && delivery.socketId === socketId
            && (!event || delivery.event === event)
        ) ?? null;
    }

    function roomDelivery(roomId, event = null) {
        return [...deliveries].reverse().find((delivery) =>
            delivery.target === "room"
            && delivery.roomId === roomId
            && (!event || delivery.event === event)
        ) ?? null;
    }

    function countDeliveries(event) {
        return deliveries.filter((delivery) => delivery.event === event).length;
    }

    function close() {
        bridge.shutdown();
        setupSessionLifecycle.shutdown();
        roomManager.shutdown();
        playerManager.shutdown();
        eventBus.shutdown();
        logger.shutdown();
        if (originalNetwork === undefined) delete process.env.TON_NETWORK;
        else process.env.TON_NETWORK = originalNetwork;
    }

    return {
        bridge,
        handoffStore,
        roomManager,
        playerManager,
        authenticate(socketId, telegramUserId) {
            identities.set(socketId, telegramUserId);
        },
        createRoom(socketId, fields = {}) {
            emit(EVENT_TYPES.LOBBY_CREATE_ROOM_REQUEST, { socketId, ...fields });
            return socketDelivery(socketId, LOBBY_SERVER_EVENTS.ROOM_CREATED);
        },
        joinRoom(socketId, roomId) {
            emit(EVENT_TYPES.LOBBY_JOIN_ROOM_REQUEST, { socketId, roomId });
        },
        selectNetwork(socketId, networkName, fields = {}) {
            emit(EVENT_TYPES.LOBBY_SELECT_ROOM_NETWORK_REQUEST, {
                socketId,
                network: networkName,
                ...fields
            });
        },
        socketDelivery,
        roomDelivery,
        countDeliveries,
        close
    };
}
