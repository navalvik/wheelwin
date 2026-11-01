/**
 * Client-owned, bounded Page5 observations for comparing one handset with
 * the server's R2 ZIP. This module has no network, storage, React or wallet access.
 *
 * Monotonic timestamps are ONLY comparable within the same handset.
 * Wall times and server timestamps are retained separately; they must not be
 * subtracted across devices without a measured clock offset.
 */
export const LOCAL_PAGE5_REPORT_SCHEMA = "wheelwin.page5-device-diagnostics.v1";
export const LOCAL_REPORT_MAX_EVENTS = 260;
export const LOCAL_REPORT_MAX_BUCKETS = 180;

const FIELDS = new Set([
    "kind", "phase", "displayedPhase", "reason", "buttonState",
    "buttonEnabled", "buttonLocked", "readyConfirmed", "connected",
    "clockValue", "serverTimestamp", "sequence", "receiveMs",
    "applyMs", "renderMs", "wheelAngle", "pointerAngle", "errorName",
    "clockLabel", "build"
]);

const IMPORTANT = new Set([
    "page5_mount", "page5_unmount", "page6_received", "page6_rendered",
    "phase_changed", "ready_attempt", "ready_sent", "ready_ack",
    "ready_rejected", "state_rejected", "clock_rejected", "client_error",
    "connection_changed", "visibility_changed", "recovery",
    "ready_phase_started", "ready_phase_completed", "main_thread_stall"
]);

const EVENT_TYPES = new Set([
    "GAME_STATE", "GAME_CLOCK_UPDATE", "OPEN_PAGE5", "OPEN_PAGE6",
    "GAME_RESULT", "SESSION_SNAPSHOT", "SESSION_RECOVERY_FAILED",
    "PRE_GAME_READY_STARTED", "PRE_GAME_READY_UPDATED",
    "PRE_GAME_READY_COMPLETED", "GAME_START_AUTHORIZED"
]);

function numeric(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeString(value, max = 80) {
    return typeof value === "string" ? value.slice(0, max) : null;
}

function cleanEvent(input, nowWall, nowMono) {
    const event = { wallMs: nowWall, monoMs: nowMono };
    for (const key of FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
        const value = input[key];
        if (typeof value === "boolean") event[key] = value;
        else if (typeof value === "string") event[key] = safeString(value);
        else event[key] = numeric(value);
    }
    return event;
}

function defaultStats() {
    return {
        physicsReceived: 0, physicsDispatchMaxMs: 0,
        physicsDispatchTotalMs: 0, physicsGapMaxMs: 0,
        physicsLateGapOver250Ms: 0, lastPhysicsMonoMs: null,
        lastSimulationTime: null, lastServerTimestamp: null,
        wheelPaints: 0, pointerPaints: 0, wheelPaintMaxMs: 0,
        pointerPaintMaxMs: 0, wheelPaintTotalMs: 0,
        pointerPaintTotalMs: 0, mainThreadStalls: 0,
        maxMainThreadDelayMs: 0, page6PacketMonoMs: null,
        page6RenderedMonoMs: null
    };
}

/**
 * @param {{now?:()=>number, mono?:()=>number}} clocks
 */
export function createLocalPage5Report({ now = Date.now, mono = () => null } = {}) {
    let identity = null;
    let events = [];
    let buckets = [];
    let stats = defaultStats();
    let droppedEvents = 0;
    let lastSample = new Map();
    let source = null;

    function bucketAt(wallMs) {
        const second = Math.floor(wallMs / 1000) * 1000;
        const last = buckets[buckets.length - 1];
        if (last?.second === second) return last;
        // If the device clock jumps backwards do not rewrite older buckets.
        const bucket = {
            second, physicsPackets: 0, wheelPaints: 0, pointerPaints: 0,
            dispatchMaxMs: 0, wheelPaintMaxMs: 0, pointerPaintMaxMs: 0
        };
        buckets.push(bucket);
        if (buckets.length > LOCAL_REPORT_MAX_BUCKETS) buckets.shift();
        return bucket;
    }

    function append(input, wallMs = now(), monoMs = mono()) {
        if (!identity || !input || typeof input.kind !== "string") return false;
        const important = IMPORTANT.has(input.kind);
        if (!important && wallMs - (lastSample.get(input.kind) ?? -Infinity) < 1000) {
            return false;
        }
        if (!important) lastSample.set(input.kind, wallMs);
        if (events.length >= LOCAL_REPORT_MAX_EVENTS) {
            const sampleIndex = events.findIndex(event => !IMPORTANT.has(event.kind));
            events.splice(sampleIndex < 0 ? 0 : sampleIndex, 1);
            droppedEvents += 1;
        }
        events.push(cleanEvent(input, wallMs, monoMs));
        return true;
    }

    function configure(next, extra = null) {
        const newIdentity = {
            roomId: safeString(next?.roomId),
            gameId: safeString(next?.gameId),
            playerId: safeString(next?.playerId),
            nickname: safeString(next?.nickname, 36)
        };
        if (!newIdentity.roomId || !newIdentity.gameId || !newIdentity.playerId) {
            return false;
        }
        if (identity && (identity.roomId !== newIdentity.roomId
            || identity.gameId !== newIdentity.gameId
            || identity.playerId !== newIdentity.playerId)) {
            events = [];
            buckets = [];
            stats = defaultStats();
            droppedEvents = 0;
            lastSample = new Map();
        }
        identity = { ...newIdentity, nickname: newIdentity.nickname ?? identity?.nickname ?? null };
        if (extra && typeof extra === "object") {
            source = {
                buildSha: safeString(extra.buildSha, 64),
                buildMode: safeString(extra.buildMode, 24),
                platform: safeString(extra.platform, 40),
                androidMajor: numeric(extra.androidMajor),
                chromeMajor: numeric(extra.chromeMajor),
                telegramVersion: safeString(extra.telegramVersion, 24),
                dpr: numeric(extra.dpr),
                screenWidth: numeric(extra.screenWidth),
                screenHeight: numeric(extra.screenHeight),
                hardwareConcurrency: numeric(extra.hardwareConcurrency),
                deviceMemoryGb: numeric(extra.deviceMemoryGb),
                timeZoneOffsetMin: numeric(extra.timeZoneOffsetMin),
                timeOriginMs: numeric(extra.timeOriginMs)
            };
        }
        return true;
    }

    function recordSocket(type, payload = {}, wallMs = now(), monoMs = mono()) {
        if (!identity) return;
        const bucket = bucketAt(wallMs);
        if (type === "PHYSICS_UPDATE") {
            stats.physicsReceived += 1;
            bucket.physicsPackets += 1;
            if (stats.lastPhysicsMonoMs !== null && monoMs !== null) {
                const gap = Math.max(0, monoMs - stats.lastPhysicsMonoMs);
                stats.physicsGapMaxMs = Math.max(stats.physicsGapMaxMs, gap);
                if (gap > 250) stats.physicsLateGapOver250Ms += 1;
            }
            stats.lastPhysicsMonoMs = monoMs;
            if (numeric(payload?.simulationTime) !== null) {
                stats.lastSimulationTime = payload.simulationTime;
            }
            if (numeric(payload?.serverTimestamp) !== null) {
                stats.lastServerTimestamp = payload.serverTimestamp;
            }
            return;
        }
        if (!EVENT_TYPES.has(type)) return;
        if (type === "OPEN_PAGE6" && stats.page6PacketMonoMs === null) {
            stats.page6PacketMonoMs = monoMs;
        }
        append({
            kind: "socket_received", reason: type,
            phase: safeString(payload?.state ?? payload?.currentState ?? payload?.phase),
            serverTimestamp: numeric(payload?.serverTimestamp ?? payload?.timestamp),
            clockValue: numeric(payload?.remainingSeconds)
        }, wallMs, monoMs);
    }

    function recordDispatch(type, durationMs, wallMs = now()) {
        if (!identity || type !== "PHYSICS_UPDATE") return;
        const value = numeric(durationMs);
        if (value === null) return;
        stats.physicsDispatchMaxMs = Math.max(stats.physicsDispatchMaxMs, value);
        stats.physicsDispatchTotalMs += value;
        const bucket = bucketAt(wallMs);
        bucket.dispatchMaxMs = Math.max(bucket.dispatchMaxMs, value);
    }

    function recordCanvas(which, durationMs, wallMs = now()) {
        if (!identity) return;
        const elapsed = numeric(durationMs);
        if (elapsed === null) return;
        const bucket = bucketAt(wallMs);
        if (which === "wheel") {
            stats.wheelPaints++;
            stats.wheelPaintTotalMs += elapsed;
            stats.wheelPaintMaxMs = Math.max(stats.wheelPaintMaxMs, elapsed);
            bucket.wheelPaints++;
            bucket.wheelPaintMaxMs = Math.max(bucket.wheelPaintMaxMs, elapsed);
        } else if (which === "pointer") {
            stats.pointerPaints++;
            stats.pointerPaintTotalMs += elapsed;
            stats.pointerPaintMaxMs = Math.max(stats.pointerPaintMaxMs, elapsed);
            bucket.pointerPaints++;
            bucket.pointerPaintMaxMs = Math.max(bucket.pointerPaintMaxMs, elapsed);
        }
    }

    function recordStall(delayMs) {
        if (!identity || !Number.isFinite(delayMs) || delayMs < 250) return;
        stats.mainThreadStalls++;
        stats.maxMainThreadDelayMs = Math.max(stats.maxMainThreadDelayMs, delayMs);
        append({ kind: "main_thread_stall", renderMs: Math.round(delayMs) });
    }

    function recordEvent(input) {
        if (input?.kind === "page6_rendered" && stats.page6RenderedMonoMs === null) {
            stats.page6RenderedMonoMs = mono();
        }
        return append(input);
    }

    function snapshot() {
        if (!identity) return null;
        return {
            schema: LOCAL_PAGE5_REPORT_SCHEMA,
            roomId: identity.roomId,
            gameId: identity.gameId,
            playerId: identity.playerId,
            nickname: identity.nickname,
            exportedAt: new Date(now()).toISOString(),
            device: source,
            timestampNotes: {
                wallMs: "Device Date.now(); device clocks may differ",
                monoMs: "performance.now(); compare only within same handset",
                serverTimestamp: "Server clock; not an exact transit latency without offset",
                render: "Canvas draw callback measured, not physical screen presentation"
            },
            metrics: {
                ...stats,
                physicsDispatchAverageMs: stats.physicsReceived
                    ? Number((stats.physicsDispatchTotalMs / stats.physicsReceived).toFixed(3)) : 0,
                wheelPaintAverageMs: stats.wheelPaints
                    ? Number((stats.wheelPaintTotalMs / stats.wheelPaints).toFixed(3)) : 0,
                pointerPaintAverageMs: stats.pointerPaints
                    ? Number((stats.pointerPaintTotalMs / stats.pointerPaints).toFixed(3)) : 0,
                page6ReceiveToRenderMs: stats.page6PacketMonoMs !== null
                    && stats.page6RenderedMonoMs !== null
                    ? Math.max(0, Math.round(stats.page6RenderedMonoMs - stats.page6PacketMonoMs))
                    : null
            },
            droppedEvents,
            buckets: buckets.map(row => ({ ...row })),
            events: events.map(row => ({ ...row }))
        };
    }

    function hydrate(saved) {
        if (!saved || saved.schema !== LOCAL_PAGE5_REPORT_SCHEMA
            || typeof saved.roomId !== "string"
            || typeof saved.gameId !== "string"
            || typeof saved.playerId !== "string"
            || !Array.isArray(saved.events) || !Array.isArray(saved.buckets)) {
            return false;
        }
        // Reload only whitelisted, bounded observations. Never restore a
        // custom object graph, HTML, Telegram initData or wallet fields.
        if (!configure(saved, saved.device ?? null)) return false;
        events = saved.events.slice(-LOCAL_REPORT_MAX_EVENTS)
            .filter(row => row && typeof row.kind === "string")
            .map(row => cleanEvent(row, numeric(row.wallMs), numeric(row.monoMs)));
        buckets = saved.buckets.slice(-LOCAL_REPORT_MAX_BUCKETS)
            .filter(row => row && Number.isFinite(row.second))
            .map(row => ({
                second: row.second,
                physicsPackets: numeric(row.physicsPackets) ?? 0,
                wheelPaints: numeric(row.wheelPaints) ?? 0,
                pointerPaints: numeric(row.pointerPaints) ?? 0,
                dispatchMaxMs: numeric(row.dispatchMaxMs) ?? 0,
                wheelPaintMaxMs: numeric(row.wheelPaintMaxMs) ?? 0,
                pointerPaintMaxMs: numeric(row.pointerPaintMaxMs) ?? 0
            }));
        const old = saved.metrics ?? {};
        stats = defaultStats();
        for (const key of Object.keys(stats)) {
            if (numeric(old[key]) !== null) stats[key] = old[key];
        }
        droppedEvents = Math.max(0, Math.floor(numeric(saved.droppedEvents) ?? 0));
        return true;
    }

    return {
        configure, recordEvent, recordSocket, recordDispatch,
        recordCanvas, recordStall, snapshot, hydrate
    };
}
