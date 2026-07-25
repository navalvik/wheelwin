import { CONNECTION_STATE } from "../../models/ConnectionState.js";

/**
 * R6.0C — Recovery overview DTO.
 */
export function buildRecoveryOverview({
    recoveryEngine,
    recoverySnapshotCache,
    playerManager
}) {

    const activeIds = recoveryEngine?.listActiveRecoveryGameIds?.() ?? [];
    const cached = recoverySnapshotCache?.listCachedSummaries?.() ?? [];
    const players = playerManager?.getDebugSnapshot?.()?.players ?? [];

    const waitingReconnectPlayers = players.filter(
        (player) => player.connectionState === CONNECTION_STATE.RECONNECTING
    );

    const activeGameIdSet = new Set(activeIds);
    const cachedWaiting = cached.filter(
        (entry) => !activeGameIdSet.has(entry.gameId)
    );

    // Cache entries without a live RecoveryEngine snapshot are treated as
    // waiting-reconnect restore surfaces. Explicit TTL expiry is not tracked yet.
    const expired = 0;

    return Object.freeze({
        activeRecoveries: activeIds.length,
        waitingReconnect:
            waitingReconnectPlayers.length + cachedWaiting.length,
        expired,
        active: Object.freeze(
            activeIds.map((gameId) => Object.freeze({ gameId, status: "active" }))
        ),
        waiting: Object.freeze([
            ...waitingReconnectPlayers.map((player) => Object.freeze({
                playerId: player.playerId,
                roomId: player.roomId ?? null,
                gameId: player.gameId ?? null,
                status: "waiting_reconnect"
            })),
            ...cachedWaiting.map((entry) => Object.freeze({
                gameId: entry.gameId,
                capturedAt: entry.capturedAt,
                paymentStatus: entry.paymentStatus,
                auditStatus: entry.auditStatus,
                status: "cache_waiting"
            }))
        ]),
        cacheCount: cached.length
    });

}
