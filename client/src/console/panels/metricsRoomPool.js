/**
 * R17.9T.8-completion — pure mapping of the console metrics projection's
 * roomPool object into display rows for the Metrics panel.
 * No calculations; null-safe formatting only.
 */

export function formatUtilization(utilization) {

    if (!Number.isFinite(utilization)) {

        return "—";

    }

    return `${Math.round(utilization * 100)}%`;

}

export function formatPerMinute(value) {

    if (!Number.isFinite(value)) {

        return "—";

    }

    return Number(value.toFixed(1)).toString();

}

export function formatNearCapacity(nearCapacity) {

    if (!Number.isFinite(nearCapacity)) {

        return "—";

    }

    return nearCapacity >= 1 ? "YES" : "no";

}

export function buildRoomPoolRows(roomPool) {

    const pool = roomPool ?? {};

    // DataTable contract: { id, data: { name, value } } — matches existing
    // timing/counter row shapes in MetricsPanel.
    const total = (value) =>
        Number.isFinite(value) ? value.toString() : "—";

    return [
        {
            id: "gameplay.room_pool_max",
            data: { name: "Room pool max", value: total(pool.max) }
        },
        {
            id: "gameplay.room_pool_utilization",
            data: { name: "Room pool utilization", value: formatUtilization(pool.utilization) }
        },
        {
            id: "gameplay.room_pool_near_capacity",
            data: { name: "Near capacity", value: formatNearCapacity(pool.nearCapacity) }
        },
        {
            id: "gameplay.rooms_created_per_min",
            data: { name: "Rooms created / min", value: formatPerMinute(pool.createdPerMin) }
        },
        {
            id: "gameplay.rooms_creation_limit_rejected_per_min",
            data: { name: "Limit rejections / min", value: formatPerMinute(pool.limitRejectionsPerMin) }
        },
        {
            id: "gameplay.rooms_created_total",
            data: { name: "Rooms created (total)", value: total(pool.createdTotal) }
        },
        {
            id: "gameplay.rooms_creation_limit_total",
            data: { name: "Limit rejections (total)", value: total(pool.limitTotal) }
        }
    ];

}
