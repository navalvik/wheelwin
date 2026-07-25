/**
 * R7.0H — Long-running stability scenario (short default, env-extendable).
 */

import { ValidationScenario } from "../ValidationScenario.js";
import {
    createValidationStack,
    delay,
    average
} from "../validationHarness.js";

export class LongRunningScenario extends ValidationScenario {

    constructor() {

        super({
            id: "long-running",
            name: "Long Running Stability",
            description:
                "Extended run checking memory growth, queues, and event-loop stability"
        });

    }

    async run(assert, context) {

        const durationMs = Number(
            context.longRunningMs
                ?? process.env.VALIDATION_LONG_MS
                ?? 800
        );

        const stack = await createValidationStack();

        stack.markReady();

        stack.state.rooms = 2;

        stack.state.games = 1;

        const memStart = process.memoryUsage().heapUsed;

        const samples = [];

        const started = Date.now();

        while (Date.now() - started < durationMs) {

            const tickStart = performance.now();

            // Simulated authoritative tick work (no gameplay engines mutated).
            stack.state.tickLatencies.push(performance.now() - tickStart);

            stack.monitoring.collectNow();

            stack.healthManager.refresh();

            const snap = stack.monitoring.getSnapshot();

            samples.push({
                heap: process.memoryUsage().heapUsed,
                queue: snap?.simulation?.queueSize ?? 0,
                eventLoop: snap?.runtime?.eventLoopDelayMs ?? 0
            });

            await delay(20);

        }

        const memEnd = process.memoryUsage().heapUsed;

        const growth = memEnd - memStart;

        const avgEventLoop = average(samples.map((s) => s.eventLoop));

        const maxQueue = Math.max(...samples.map((s) => s.queue), 0);

        assert.lessThan(growth, 50 * 1024 * 1024, "Heap growth under 50MB");

        assert.lessThan(avgEventLoop, 100, "Average event loop delay under 100ms");

        assert.lessOrEqual(maxQueue, 100, "Simulation queue not unbounded");

        assert.equal(
            stack.healthManager.getLivenessResponse().live,
            true,
            "Liveness remains true"
        );

        if (growth > 10 * 1024 * 1024) {

            assert.warn(`Heap grew by ${Math.round(growth / 1024)} KB`);

        }

        await stack.shutdown();

        return {
            evidence: {
                durationMs,
                samples: samples.length,
                memoryGrowthBytes: growth,
                avgEventLoopDelayMs: Number(avgEventLoop.toFixed(3)),
                maxQueue
            },
            metrics: {
                memoryGrowthBytes: growth,
                avgEventLoopDelayMs: Number(avgEventLoop.toFixed(3)),
                avgTickLatencyMs: Number(
                    average(stack.state.tickLatencies).toFixed(3)
                ),
                maxTickLatencyMs: Number(
                    Math.max(0, ...stack.state.tickLatencies).toFixed(3)
                )
            }
        };

    }

}
