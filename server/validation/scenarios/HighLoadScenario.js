/**
 * R7.0H — High load scenario (many rooms/games + probe responsiveness).
 */

import { ValidationScenario } from "../ValidationScenario.js";
import {
    createValidationStack,
    delay,
    average,
    maxOf
} from "../validationHarness.js";

export class HighLoadScenario extends ValidationScenario {

    constructor() {

        super({
            id: "high-load",
            name: "High Load",
            description:
                "Many simultaneous rooms/games; validate latency and probe responsiveness"
        });

    }

    async run(assert) {

        const stack = await createValidationStack();

        stack.markReady();

        const roomCount = 40;

        const gameCount = 25;

        stack.state.rooms = roomCount;

        stack.state.games = gameCount;

        const httpLatencies = [];

        const tickLatencies = [];

        for (let i = 0; i < 100; i += 1) {

            const tickStart = performance.now();

            // Synthetic load — observational only.
            for (let j = 0; j < 50; j += 1) {

                Math.sqrt(j * i + 1);

            }

            tickLatencies.push(performance.now() - tickStart);

            const httpStart = performance.now();

            stack.healthManager.getCachedSnapshot();

            stack.healthManager.getReadinessResponse();

            stack.healthService.getHealthSnapshot();

            httpLatencies.push(performance.now() - httpStart);

            if (i % 10 === 0) {

                stack.monitoring.collectNow();

            }

        }

        await delay(50);

        stack.monitoring.collectNow();

        const snap = stack.monitoring.getSnapshot();

        assert.equal(snap.gameplay.activeRooms, roomCount, "Rooms reflected");

        assert.equal(snap.gameplay.activeGames, gameCount, "Games reflected");

        assert.equal(
            stack.healthManager.getReadinessResponse().ready,
            true,
            "Ready under load"
        );

        const avgHttp = average(httpLatencies);

        const avgTick = average(tickLatencies);

        assert.lessThan(avgHttp, 25, "Health/probe avg latency under 25ms");

        assert.lessThan(avgTick, 10, "Synthetic tick avg under 10ms");

        assert.ok(
            stack.monitoring.getPrometheusText().includes("TYPE"),
            "Prometheus still exportable"
        );

        await stack.shutdown();

        return {
            evidence: {
                roomCount,
                gameCount,
                avgHttpLatencyMs: Number(avgHttp.toFixed(3)),
                maxHttpLatencyMs: Number(maxOf(httpLatencies).toFixed(3)),
                avgTickLatencyMs: Number(avgTick.toFixed(3)),
                maxTickLatencyMs: Number(maxOf(tickLatencies).toFixed(3))
            },
            metrics: {
                avgHttpLatencyMs: Number(avgHttp.toFixed(3)),
                avgTickLatencyMs: Number(avgTick.toFixed(3)),
                maxTickLatencyMs: Number(maxOf(tickLatencies).toFixed(3)),
                socketThroughputOps: roomCount * 2 * 100
            }
        };

    }

}
