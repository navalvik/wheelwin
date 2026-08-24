/**
 * R17.9T.8-completion — MetricsPanel room-pool gauge visibility (frontend).
 *
 * Invariants:
 * 1. buildRoomPoolRows exposes all seven R17.9T.8 gauges with exact names.
 * 2. Formatting: utilization as %, per-minute with 1-decimal, totals raw.
 * 3. Null/empty roomPool degrades to "—" without crashing.
 * 4. MetricsPanel is wired to the roomPool projection + helper.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
    buildRoomPoolRows,
    formatUtilization,
    formatPerMinute,
    formatNearCapacity
} from "./metricsRoomPool.js";

const panelDir = dirname(fileURLToPath(import.meta.url));

// --- Test 1: full data → exact rows ------------------------------------------

{

    const rows = buildRoomPoolRows({
        max: 64,
        utilization: 0.5,
        nearCapacity: 0,
        createdPerMin: 2.25,
        limitRejectionsPerMin: 0,
        createdTotal: 9,
        limitTotal: 1
    });

    const byId = Object.fromEntries(rows.map((row) => [row.id, row.value]));

    assert.equal(byId["gameplay.room_pool_max"], "64");
    assert.equal(byId["gameplay.room_pool_utilization"], "50%");
    assert.equal(byId["gameplay.room_pool_near_capacity"], "no");
    assert.equal(byId["gameplay.rooms_created_per_min"], "2.3");
    assert.equal(byId["gameplay.rooms_creation_limit_rejected_per_min"], "0");
    assert.equal(byId["gameplay.rooms_created_total"], "9");
    assert.equal(byId["gameplay.rooms_creation_limit_total"], "1");

    console.log("  test 1 (seven gauge rows formatted) passed");

}

// --- Test 2: formatting edge cases -------------------------------------------

{

    assert.equal(formatUtilization(1), "100%");
    assert.equal(formatUtilization(0), "0%");
    assert.equal(formatUtilization(null), "—");
    assert.equal(formatUtilization(undefined), "—");

    assert.equal(formatPerMinute(0), "0");
    assert.equal(formatPerMinute(3), "3");
    assert.equal(formatPerMinute(null), "—");

    assert.equal(formatNearCapacity(1), "YES");
    assert.equal(formatNearCapacity(0), "no");
    assert.equal(formatNearCapacity(null), "—");

    console.log("  test 2 (formatting + null safety) passed");

}

// --- Test 3: null/empty roomPool does not crash ------------------------------

{

    for (const input of [null, undefined, {}]) {

        const rows = buildRoomPoolRows(input);

        assert.equal(rows.length, 7, "rows must always be present");

        for (const row of rows) {

            assert.equal(row.value, "—", "missing values must render as dash");

        }

    }

    console.log("  test 3 (null/empty pool renders dashes) passed");

}

// --- Test 4: panel wiring ------------------------------------------------------

{

    const source = readFileSync(
        join(panelDir, "MetricsPanel.jsx"),
        "utf8"
    );

    assert.ok(
        source.includes("buildRoomPoolRows(metrics.roomPool)"),
        "MetricsPanel must render the roomPool projection"
    );

    assert.ok(
        source.includes("Room pool"),
        "MetricsPanel must contain a Room pool section"
    );

    console.log("  test 4 (MetricsPanel wired to roomPool) passed");

}

console.log("metricsRoomPool.test.js: all passed");
