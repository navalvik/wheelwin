/**
 * R17.9T.8-completion — Developer Console gauge visibility.
 *
 * Invariants:
 * 1. buildMetricsOverview projects the R17.9T.8 gauges (gauges map + roomPool).
 * 2. Existing counters/timings/runtime/monitoring fields are preserved.
 * 3. Missing/empty monitoring snapshot degrades to nulls without throwing.
 * 4. Read-only: builder consumes getters only; no gameplay behavior involved.
 */
import assert from "node:assert/strict";

import { MetricsSnapshot } from "../monitoring/MetricsSnapshot.js";
import { buildMetricsOverview } from "../console/projectionBuilders/buildMetricsOverview.js";

function stubMonitoringManager(gauges, counters = {}) {

    return {
        getSnapshot() {

            return new MetricsSnapshot({
                collectedAt: Date.now(),
                enabled: true,
                collectors: {},
                runtime: {},
                gameplay: {},
                simulation: {},
                payments: {},
                recovery: {},
                developer: {},
                system: {},
                gauges,
                counters
            });

        }
    };

}

function baseProviders() {

    return {
        metricsService: {
            getSnapshot: () => ({
                enabled: true,
                metrics: {
                    "setup.duration": {
                        count: 2,
                        averageMs: 100,
                        lastMs: 90,
                        minMs: 80,
                        maxMs: 120
                    }
                },
                counters: { "games.started": 3 }
            })
        },
        healthService: null,
        roomManager: { getActiveRoomCount: () => 2 },
        gameManager: { getGames: () => [] },
        playerManager: { getDebugSnapshot: () => ({ players: [{}] }) },
        socketGateway: { getConnectedSocketCount: () => 4 },
        simulationLoop: { getActiveGameCount: () => 1 }
    };

}

// --- Test 1: gauges + roomPool projected ------------------------------------

{

    const overview = buildMetricsOverview({
        ...baseProviders(),
        monitoringManager: stubMonitoringManager({
            "gameplay.active_rooms": 2,
            "gameplay.room_pool_max": 64,
            "gameplay.room_pool_utilization": 0.03125,
            "gameplay.room_pool_near_capacity": 0,
            "gameplay.rooms_created_per_min": 1.5,
            "gameplay.rooms_creation_limit_rejected_per_min": 0,
            "gameplay.rooms_created_total": 3,
            "gameplay.rooms_creation_limit_total": 0
        })
    });

    assert.equal(overview.gauges["gameplay.room_pool_max"], 64);

    const pool = overview.roomPool;

    assert.equal(pool.max, 64);
    assert.equal(pool.utilization, 0.03125);
    assert.equal(pool.nearCapacity, 0);
    assert.equal(pool.createdPerMin, 1.5);
    assert.equal(pool.limitRejectionsPerMin, 0);
    assert.equal(pool.createdTotal, 3);
    assert.equal(pool.limitTotal, 0);

    // Existing fields preserved.
    assert.equal(overview.counters["games.started"], 3);
    assert.ok(overview.timings["setup.duration"]);
    assert.equal(overview.runtime.activeRooms, 2);
    assert.equal(overview.runtime.activePlayers, 1);
    assert.equal(overview.runtime.activeSockets, 4);
    assert.equal(overview.runtime.activeSimulations, 1);

    console.log("  test 1 (gauges + roomPool projected, fields kept) passed");

}

// --- Test 2: missing monitoring manager → null-safe degradation -------------

{

    const overview = buildMetricsOverview(baseProviders());

    assert.deepEqual(overview.gauges, {});

    assert.equal(overview.roomPool.max, null);
    assert.equal(overview.roomPool.utilization, null);
    assert.equal(overview.roomPool.nearCapacity, null);
    assert.equal(overview.roomPool.createdPerMin, null);
    assert.equal(overview.roomPool.limitRejectionsPerMin, null);
    assert.equal(overview.roomPool.createdTotal, null);
    assert.equal(overview.roomPool.limitTotal, null);

    // Existing behavior intact without monitoring manager.
    assert.equal(overview.counters["games.started"], 3);
    assert.equal(overview.runtime.activeRooms, 2);

    console.log("  test 2 (null-safe without monitoring snapshot) passed");

}

// --- Test 3: service passes monitoringManager through ------------------------

{

    // Minimal fake of the projection service dependency surface.
    const { DeveloperConsoleProjectionService } = await import(
        "../console/DeveloperConsoleProjectionService.js"
    );

    let received = null;

    const fakeBuilderModule = { used: false };

    void fakeBuilderModule;

    const service = new DeveloperConsoleProjectionService({
        roomManager: baseProviders().roomManager,
        gameManager: baseProviders().gameManager,
        playerManager: baseProviders().playerManager,
        socketGateway: baseProviders().socketGateway,
        metricsService: baseProviders().metricsService,
        monitoringManager: stubMonitoringManager({
            "gameplay.room_pool_max": 32
        })
    });

    received = service.buildMetricsOverview();

    assert.equal(received.roomPool.max, 32);

    console.log("  test 3 (service wires monitoringManager) passed");

}

console.log("consoleGaugeVisibility.r179t8.test.js: all passed");
