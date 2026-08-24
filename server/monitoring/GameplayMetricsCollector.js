/**
 * R7.0E — Gameplay gauges from managers (read-only getters).
 */

import { MetricCollector } from "./MetricCollector.js";

export class GameplayMetricsCollector extends MetricCollector {

    constructor({ intervalMs = 1000 }) {

        super({ name: "gameplay", intervalMs });

        // R17.9T.8 — Attack E velocity tracking (observational only).
        // Deltas of monotonic MetricsService counters over elapsed wall time.
        this._prevRoomsCreated = null;

        this._prevRoomsCreateLimitRejected = null;

        this._lastCollectAt = null;

    }

    collect({ registry, providers }) {

        const rooms = providers?.roomManager?.getRooms?.()?.length ?? 0;

        const games = providers?.gameManager?.getGames?.()?.length ?? 0;

        const players = providers?.playerManager?.getDebugSnapshot?.()
            ?.players?.length ?? 0;

        const setup = providers?.setupSessionLifecycle?.getActiveSessionCount?.()
            ?? 0;

        const result = providers?.resultSessionLifecycle?.getActiveSessionCount?.()
            ?? 0;

        const metrics = providers?.metricsService?.getSnapshot?.() ?? null;

        const gamesStarted = metrics?.counters?.["games.started"] ?? 0;

        const gamesCompleted = metrics?.counters?.["games.completed"] ?? 0;

        const gamesRecovered = metrics?.counters?.reconnects ?? 0;

        const gameDuration = metrics?.metrics?.["game.duration"] ?? null;

        const setupDuration = metrics?.metrics?.["setup.duration"]
            ?? metrics?.metrics?.["payment.process"]
            ?? null;

        registry.setGauge("gameplay.active_rooms", rooms);

        // R17.9T.8 — room-pool utilization visibility (single source of truth:
        // RoomManager live getters; no second room registry).
        const maxRooms = providers?.roomManager?.getMaxConcurrentRooms?.() ?? 0;

        const utilization = maxRooms > 0 ? rooms / maxRooms : 0;

        registry.setGauge("gameplay.room_pool_max", maxRooms);

        registry.setGauge(
            "gameplay.room_pool_utilization",
            Number(utilization.toFixed(4))
        );

        // Near-capacity flag (>= 75% utilization) for quick saturation scan.
        registry.setGauge(
            "gameplay.room_pool_near_capacity",
            utilization >= 0.75 ? 1 : 0
        );

        // R17.9T.8 — CREATE_ROOM velocity gauges from monotonic counters.
        const roomsCreated = metrics?.counters?.["rooms.created"] ?? 0;

        const roomsCreateLimitRejected
            = metrics?.counters?.["rooms.create_rejected_room_limit"] ?? 0;

        const now = Date.now();

        if (
            this._prevRoomsCreated !== null
            && this._lastCollectAt !== null
        ) {

            const elapsedMin = Math.max(
                1 / 60,
                (now - this._lastCollectAt) / 60000
            );

            registry.setGauge(
                "gameplay.rooms_created_per_min",
                Math.max(0, (roomsCreated - this._prevRoomsCreated) / elapsedMin)
            );

            registry.setGauge(
                "gameplay.rooms_creation_limit_rejected_per_min",
                Math.max(
                    0,
                    (roomsCreateLimitRejected - this._prevRoomsCreateLimitRejected)
                        / elapsedMin
                )
            );

        }

        this._prevRoomsCreated = roomsCreated;

        this._prevRoomsCreateLimitRejected = roomsCreateLimitRejected;

        this._lastCollectAt = now;

        // Saturation observability: cumulative ROOM_CREATION_LIMIT occurrences.
        registry.setCounter(
            "gameplay.rooms_created_total",
            roomsCreated
        );

        registry.setCounter(
            "gameplay.rooms_creation_limit_total",
            roomsCreateLimitRejected
        );

        registry.setGauge("gameplay.active_games", games);

        registry.setGauge("gameplay.active_players", players);

        registry.setGauge("gameplay.active_setup_sessions", setup);

        registry.setGauge("gameplay.active_result_sessions", result);

        registry.setCounter("gameplay.games_created", gamesStarted);

        registry.setCounter("gameplay.games_completed", gamesCompleted);

        registry.setCounter("gameplay.games_recovered", gamesRecovered);

        if (gameDuration) {

            registry.setGauge(
                "gameplay.avg_game_duration_ms",
                gameDuration.averageMs ?? 0
            );

        }

        if (setupDuration) {

            registry.setGauge(
                "gameplay.avg_setup_or_payment_duration_ms",
                setupDuration.averageMs ?? 0
            );

        }

        const paymentDuration = metrics?.metrics?.["payment.process"];

        if (paymentDuration) {

            registry.setGauge(
                "gameplay.avg_payment_duration_ms",
                paymentDuration.averageMs ?? 0
            );

        }

    }

}
