/**
 * R17.9T.8 — Attack E observability (passive).
 *
 * Invariants:
 * 1. Successful CREATE_ROOM increments a monotonic `rooms.created` counter and
 *    logs a safe numeric Telegram identity marker (`tgId=`).
 * 2. No secrets/auth payloads (initData, tokens, HMAC) ever appear in emitted
 *    logs or traces.
 * 3. ROOM_CREATION_LIMIT occurrences emit a CREATE_ROOM_SATURATION trace with
 *    activeRooms/maxRooms and increment `rooms.create_rejected_room_limit`.
 * 4. Per-user quota rejections remain unchanged AND are counted observably.
 * 5. GameplayMetricsCollector exposes pool max/utilization/near-capacity and
 *    per-minute creation/rejection velocity from RoomManager live state only.
 * 6. Existing CREATE_ROOM authorization behavior is unchanged.
 */
import { EventBus } from "../events/EventBus.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameplayMetricsCollector }
    from "../monitoring/GameplayMetricsCollector.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import { MetricsService } from "../services/MetricsService.js";
import {
    LOBBY_ERROR_CODES,
    LOBBY_SERVER_EVENTS
} from "../socket/lobbyProtocol.js";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

/** Recording logger: captures every emission for secret-leak assertions. */
function buildRecordingLogger() {

    const entries = [];

    const record = (level, args) => {

        entries.push({ level, text: args.map(String).join(" ") });

    };

    return {
        entries,
        info(...args) { record("info", args); },
        warn(...args) { record("warn", args); },
        error(...args) { record("error", args); },
        debug(...args) { record("debug", args); },
        startupLine(...args) { record("startup", args); },
        decisionTrace(payload) {

            entries.push({
                level: "decisionTrace",
                text: JSON.stringify(payload),
                payload
            });

        }
    };

}

function quietLogger() {

    return {
        info() {}, warn() {}, error() {}, debug() {}, decisionTrace() {}
    };

}

function buildHarness({
    maxConcurrentRooms = 64,
    setupDurationMs = 80
} = {}) {

    const logger = buildRecordingLogger();

    const eventBus = new EventBus({
        logger: quietLogger(),
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const metricsService = new MetricsService({ enabled: true });

    metricsService.initialize();

    const roomManager = new RoomManager({
        logger: quietLogger(),
        eventBus,
        roomConfig: {
            maxPlayers: 3,
            maxConcurrentRooms,
            setupDurationMs
        }
    });

    const playerManager = new PlayerManager({ logger: quietLogger(), eventBus });

    const setupSessionLifecycle = new SetupSessionLifecycle({
        logger: quietLogger(),
        eventBus,
        roomManager,
        roomConfig: { setupDurationMs }
    });

    roomManager.initialize();

    playerManager.initialize();

    setupSessionLifecycle.initialize();

    roomManager.attachSetupSessionLifecycle(setupSessionLifecycle);

    const telegramIdentityBySocket = new Map();

    const telegramIdentityResolver = (socketId) =>
        telegramIdentityBySocket.get(socketId) ?? null;

    const roomLobbyBridge = new RoomLobbyBridge({
        logger,
        eventBus,
        roomManager,
        playerManager,
        setupSessionLifecycle,
        telegramIdentityResolver,
        metricsService
    });

    roomLobbyBridge.initialize();

    const deliveries = [];

    eventBus.subscribe(EVENT_TYPES.LOBBY_SOCKET_DELIVERY, (envelope) => {

        deliveries.push({
            socketId: envelope.payload?.socketId ?? null,
            event: envelope.payload?.event ?? null,
            payload: envelope.payload?.payload ?? null
        });

    });

    function authenticateSocket(socketId, telegramUserId) {

        telegramIdentityBySocket.set(socketId, telegramUserId ?? null);

    }

    function requestCreateRoom(socketId, forbiddenPayload = null) {

        // forbiddenPayload simulates a malicious client trying to inject auth
        // data; the server must never echo it anywhere.
        eventBus.emit({
            source: EVENT_SOURCES.SOCKET_GATEWAY,
            type: EVENT_TYPES.LOBBY_CREATE_ROOM_REQUEST,
            payload: { socketId, ...(forbiddenPayload ?? {}) }
        });

    }

    function deliveryFor(socketId, eventName = null) {

        for (let i = deliveries.length - 1; i >= 0; i -= 1) {

            if (deliveries[i].socketId !== socketId) {

                continue;

            }

            if (!eventName || deliveries[i].event === eventName) {

                return deliveries[i];

            }

        }

        return null;

    }

    function lastDeliveryFor(socketId) {

        return deliveryFor(socketId);

    }

    return {
        logger,
        eventBus,
        metricsService,
        roomManager,
        playerManager,
        setupSessionLifecycle,
        roomLobbyBridge,
        authenticateSocket,
        requestCreateRoom,
        lastDeliveryFor,
        deliveryFor,
        shutdown() {

            roomLobbyBridge.shutdown();

            setupSessionLifecycle.shutdown();

            roomManager.shutdown();

            playerManager.shutdown();

            eventBus.shutdown();

        }
    };

}

// ---------------------------------------------------------------------------
// Test 1 — successful create: safe tgId marker + rooms.created counter.
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    try {

        harness.authenticateSocket("tg-a", 111001);

        harness.requestCreateRoom("tg-a");

        const delivery = harness.deliveryFor("tg-a", LOBBY_SERVER_EVENTS.ROOM_CREATED);

        assert(
            delivery?.event === LOBBY_SERVER_EVENTS.ROOM_CREATED,
            "authenticated create must succeed"
        );

        const createdLog = harness.logger.entries.find(
            (entry) => entry.text.includes("Lobby room created")
        );

        assert(createdLog, "successful create must be logged");

        assert(
            createdLog.text.includes("tgId=111001"),
            "creation log must contain the safe numeric tgId marker"
        );

        assert(
            harness.metricsService.getCounter("rooms.created") === 1,
            "rooms.created counter must equal number of successful creates"
        );

        assertNoSecrets(harness.logger);

        console.log("  test 1 (safe identity marker + creation counter) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 2 — client-supplied auth payloads are ignored and never logged.
// ---------------------------------------------------------------------------

{

    const harness = buildHarness();

    try {

        // Socket is NOT authenticated; payload tries to inject identity + raw
        // Telegram initData fragments. Server must reject fail-closed and the
        // rejection trace must not echo any payload content.
        harness.requestCreateRoom("forged", {
            telegramUserId: 424242,
            initData: "query_id=AAH&user=%7B%22id%22%3A424242%7D&hash=deadbeef"
        });

        const delivery = harness.lastDeliveryFor("forged");

        assert(
            delivery?.payload?.code
                === LOBBY_ERROR_CODES.ROOM_CREATION_REQUIRES_TELEGRAM,
            "unauthenticated create must still be rejected"
        );

        assert(
            harness.roomManager.getActiveRoomCount() === 0,
            "no room may be allocated"
        );

        assertNoSecrets(harness.logger);

        console.log("  test 2 (no secret/payload leakage) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 3 — saturation path observable: ROOM_CREATION_LIMIT trace + counter,
// while authorization outcome itself is unchanged.
// ---------------------------------------------------------------------------

{

    const harness = buildHarness({ maxConcurrentRooms: 1 });

    try {

        harness.authenticateSocket("cap-a", 222001);

        harness.authenticateSocket("cap-b", 222002);

        harness.requestCreateRoom("cap-a");

        assert(
            harness.deliveryFor("cap-a", LOBBY_SERVER_EVENTS.ROOM_CREATED),
            "first create must succeed"
        );

        harness.requestCreateRoom("cap-b");

        const delivery = harness.lastDeliveryFor("cap-b");

        assert(
            delivery?.payload?.code === LOBBY_ERROR_CODES.ROOM_CREATION_LIMIT,
            "second create must be rejected with ROOM_CREATION_LIMIT"
        );

        const saturationTrace = harness.logger.entries.find(
            (entry) => entry.level === "decisionTrace"
                && entry.payload?.stage === "CREATE_ROOM_SATURATION"
        );

        assert(saturationTrace, "saturation decisionTrace must be emitted");

        assert(
            saturationTrace.payload.activeRooms === 1
                && saturationTrace.payload.maxRooms === 1,
            "saturation trace must carry activeRooms/maxRooms"
        );

        assert(
            harness.metricsService.getCounter(
                "rooms.create_rejected_room_limit"
            ) === 1,
            "room-limit rejection counter must be incremented"
        );

        assert(
            harness.metricsService.getCounter("rooms.created") === 1,
            "rooms.created must count only successful creations"
        );

        // Authorization unchanged: same-user quota rejection still fires first.
        harness.authenticateSocket("cap-a-2", 222001);

        harness.requestCreateRoom("cap-a-2");

        assert(
            harness.lastDeliveryFor("cap-a-2")?.payload?.code
                === LOBBY_ERROR_CODES.ROOM_CREATION_USER_LIMIT,
            "one-room-per-user quota must remain authoritative"
        );

        assert(
            harness.metricsService.getCounter(
                "rooms.create_rejected_user_limit"
            ) === 1,
            "user-limit rejection counter must be incremented"
        );

        console.log("  test 3 (saturation + quota observability) passed");

    } finally {

        harness.shutdown();

    }

}

// ---------------------------------------------------------------------------
// Test 4 — collector: pool gauges, near-capacity flag, velocity, counters.
// ---------------------------------------------------------------------------

{

    const harness = buildHarness({ maxConcurrentRooms: 4 });

    const registry = { gauges: {}, counters: {} };

    const registryStub = {
        setGauge(name, value) { registry.gauges[name] = value; },
        setCounter(name, value) { registry.counters[name] = value; }
    };

    const collector = new GameplayMetricsCollector({ intervalMs: 1000 });

    const providers = {
        roomManager: harness.roomManager,
        playerManager: harness.playerManager,
        gameManager: { getGames: () => [] },
        setupSessionLifecycle: harness.setupSessionLifecycle,
        resultSessionLifecycle: { getActiveSessionCount: () => 0 },
        metricsService: harness.metricsService
    };

    try {

        harness.authenticateSocket("obs-a", 333001);

        harness.authenticateSocket("obs-b", 333002);

        harness.requestCreateRoom("obs-a");

        harness.requestCreateRoom("obs-b");

        assert(
            harness.roomManager.getActiveRoomCount() === 2,
            "two rooms must be active"
        );

        assert(
            harness.roomManager.getMaxConcurrentRooms() === 4,
            "configured maximum must be exposed read-only"
        );

        collector.collect({ registry: registryStub, providers });

        assert(
            registry.gauges["gameplay.active_rooms"] === 2,
            "active_rooms gauge must reflect RoomManager state"
        );

        assert(
            registry.gauges["gameplay.room_pool_max"] === 4,
            "room_pool_max gauge must equal configured maximum"
        );

        assert(
            registry.gauges["gameplay.room_pool_utilization"] === 0.5,
            "utilization must be active/max (2/4 = 0.5)"
        );

        assert(
            registry.gauges["gameplay.room_pool_near_capacity"] === 0,
            "50% utilization must not be flagged near-capacity"
        );

        assert(
            registry.counters["gameplay.rooms_created_total"] === 2,
            "cumulative creation counter must surface rooms.created"
        );

        assert(
            registry.counters["gameplay.rooms_creation_limit_total"] === 0,
            "limit-rejection total must start at zero"
        );

        // First collect seeds the baseline; velocity gauges appear on the
        // next collect after new creations.
        harness.authenticateSocket("obs-c", 333003);

        harness.requestCreateRoom("obs-c");

        collector.collect({ registry: registryStub, providers });

        const velocity = registry.gauges["gameplay.rooms_created_per_min"];

        assert(
            Number.isFinite(velocity) && velocity > 0,
            "creation velocity gauge must be a positive finite number"
        );

        // Fill the remaining slot -> near-capacity flips at >= 75%.
        harness.authenticateSocket("obs-d", 333004);

        harness.requestCreateRoom("obs-d");

        collector.collect({ registry: registryStub, providers });

        assert(
            registry.gauges["gameplay.room_pool_utilization"] === 1,
            "pool must report full utilization"
        );

        assert(
            registry.gauges["gameplay.room_pool_near_capacity"] === 1,
            "full pool must be flagged near-capacity"
        );

        console.log("  test 4 (collector pool/velocity gauges) passed");

    } finally {

        collector.shutdown?.();

        harness.shutdown();

    }

}

console.log("attackEObservability.r179t8.test.js: all passed");

function assertNoSecrets(logger) {

    const forbidden = [
        "initData",
        "query_id",
        "auth_date",
        "hash=",
        "bot_token",
        "botToken",
        "HMAC"
    ];

    for (const entry of logger.entries) {

        for (const needle of forbidden) {

            assert(
                !entry.text.includes(needle),
                `log emission must never contain "${needle}"`
            );

        }

    }

}
