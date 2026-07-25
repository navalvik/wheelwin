/**
 * R7.0E — Gameplay gauges from managers (read-only getters).
 */

import { MetricCollector } from "./MetricCollector.js";

export class GameplayMetricsCollector extends MetricCollector {

    constructor({ intervalMs = 1000 }) {

        super({ name: "gameplay", intervalMs });

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
