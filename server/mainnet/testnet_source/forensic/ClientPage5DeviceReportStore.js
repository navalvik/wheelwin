/**
 * Durable, bounded, observation-only Page5 device reports.
 *
 * A single sanitized JSON file per authenticated room/game/player is staged
 * before the immutable single R2 ZIP is uploaded. No raw client object is
 * stored, and this store does not change gameplay, ledgers or room lifecycle.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const PAGE5_DEVICE_REPORT_SCHEMA = "wheelwin.page5-device-diagnostics.v1";
export const PAGE5_DEVICE_REPORT_WAIT_MS = 90_000;
export const PAGE5_DEVICE_REPORT_MAX_BYTES = 180_000;
export const PAGE5_DEVICE_REPORT_MAX_EVENTS = 260;
export const PAGE5_DEVICE_REPORT_MAX_BUCKETS = 180;
export const PAGE5_DEVICE_REPORT_EXPECTED_PLAYERS = 3;

const EVENT_KEYS = new Set([
    "wallMs", "monoMs", "kind", "phase", "displayedPhase", "reason",
    "buttonState", "buttonEnabled", "buttonLocked", "readyConfirmed",
    "connected", "clockValue", "clockLabel", "serverTimestamp",
    "phaseStartedAt", "phaseEndsAt", "sequence", "receiveMs", "applyMs",
    "renderMs", "wheelAngle", "pointerAngle", "errorName",
    "errorMessage", "errorStack", "errorFile", "errorLine", "errorColumn",
    "build"
]);
const DEVICE_KEYS = new Set([
    "buildSha", "buildMode", "platform", "androidMajor", "chromeMajor",
    "telegramVersion", "dpr", "screenWidth", "screenHeight",
    "hardwareConcurrency", "deviceMemoryGb", "timeZoneOffsetMin",
    "timeOriginMs"
]);
const METRIC_KEYS = new Set([
    "physicsReceived", "physicsDispatchMaxMs", "physicsDispatchTotalMs",
    "physicsDispatchAverageMs", "physicsGapMaxMs", "physicsLateGapOver250Ms",
    "lastPhysicsMonoMs", "lastSimulationTime", "lastServerTimestamp",
    "wheelPaints", "pointerPaints", "wheelPaintMaxMs",
    "pointerPaintMaxMs", "wheelPaintTotalMs", "pointerPaintTotalMs",
    "wheelPaintAverageMs", "pointerPaintAverageMs", "mainThreadStalls",
    "maxMainThreadDelayMs", "page6PacketMonoMs",
    "page6RenderedMonoMs", "page6ReceiveToRenderMs"
]);
const BUCKET_KEYS = new Set([
    "second", "physicsPackets", "wheelPaints", "pointerPaints",
    "firstSimulationTime", "lastSimulationTime", "firstServerTimestamp",
    "lastServerTimestamp", "physicsGapMaxMs", "dispatchMaxMs",
    "wheelPaintMaxMs", "pointerPaintMaxMs"
]);

function safeId(id, maxLength = 120) {
    return typeof id === "string" && id.length > 0 && id.length <= maxLength
        && /^[a-zA-Z0-9_-]+$/.test(id) ? id : null;
}
const SENSITIVE_ASSIGNMENT = /\b(api[_-]?key|access[_-]?key|secret|token|password|mnemonic|authorization|private[_-]?key)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const QUERY_VALUE = /([?&][^=&\s]+)=([^&#\s]*)/g;
const BEARER_VALUE = /\bBearer\s+[^\s,;]+/gi;
const URL_CREDENTIALS = /(https?:\/\/)[^/\s@]+:[^/\s@]+@/gi;

function permittedScalar(value, key) {
    if (value === null) return null;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
        const maxLength = key === "errorStack" ? 2048
            : key === "errorMessage" ? 512
                : key === "errorFile" ? 256 : 90;
        return value
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
            .replace(BEARER_VALUE, "Bearer [REDACTED]")
            .replace(URL_CREDENTIALS, "$1[REDACTED]@")
            .replace(QUERY_VALUE, "$1=[REDACTED]")
            .replace(SENSITIVE_ASSIGNMENT, "$1$2[REDACTED]")
            .slice(0, maxLength);
    }
    return null;
}
function pick(object, fields) {
    const out = {};
    for (const key of fields) {
        if (Object.hasOwn(object ?? {}, key)) out[key] = permittedScalar(object[key], key);
    }
    return out;
}
function asNumericOnly(object, fields) {
    const out = {};
    for (const key of fields) {
        const value = object?.[key];
        if (value === null) out[key] = null;
        else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    return out;
}

export function sanitizePage5DeviceReport({ roomId, gameId, playerId, rawReport } = {}) {
    const room = safeId(roomId, 64);
    const game = safeId(gameId);
    const player = safeId(playerId);
    if (!room || !game || !player || !rawReport || typeof rawReport !== "object"
        || Array.isArray(rawReport)) {
        return { ok:false, reason:"INVALID_BINDING" };
    }
    // Reject before JSON.stringify for extreme payloads and circular inputs.
    let encoded;
    try {
        encoded = JSON.stringify(rawReport);
    } catch {
        return { ok:false, reason:"INVALID_JSON" };
    }
    if (!encoded || encoded.length > PAGE5_DEVICE_REPORT_MAX_BYTES) {
        return { ok:false, reason:"REPORT_TOO_LARGE" };
    }
    if (rawReport.schema !== PAGE5_DEVICE_REPORT_SCHEMA
        || rawReport.roomId !== room
        || rawReport.gameId !== game
        || rawReport.playerId !== player) {
        return { ok:false, reason:"IDENTITY_MISMATCH" };
    }
    if (!Array.isArray(rawReport.events)
        || rawReport.events.length > PAGE5_DEVICE_REPORT_MAX_EVENTS
        || !Array.isArray(rawReport.buckets)
        || rawReport.buckets.length > PAGE5_DEVICE_REPORT_MAX_BUCKETS) {
        return { ok:false, reason:"INVALID_REPORT_SHAPE" };
    }
    if (rawReport.events.some(row => !row || typeof row !== "object" || Array.isArray(row))
        || rawReport.buckets.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
        return { ok:false, reason:"INVALID_REPORT_ENTRIES" };
    }
    const clean = {
        schema: PAGE5_DEVICE_REPORT_SCHEMA,
        roomId: room,
        gameId: game,
        playerId: player,
        nickname: typeof rawReport.nickname === "string"
            ? rawReport.nickname.slice(0, 36) : null,
        exportedAt: typeof rawReport.exportedAt === "string"
            ? rawReport.exportedAt.slice(0, 50) : null,
        device: pick(rawReport.device, DEVICE_KEYS),
        metrics: asNumericOnly(rawReport.metrics, METRIC_KEYS),
        droppedEvents: Number.isInteger(rawReport.droppedEvents)
            ? Math.max(0, Math.min(100000, rawReport.droppedEvents)) : 0,
        buckets: rawReport.buckets.map(row => asNumericOnly(row, BUCKET_KEYS)),
        events: rawReport.events.map(row => pick(row, EVENT_KEYS))
    };
    const cleanEncoded = JSON.stringify(clean);
    if (Buffer.byteLength(cleanEncoded, "utf8") > PAGE5_DEVICE_REPORT_MAX_BYTES) {
        return { ok:false, reason:"SANITIZED_REPORT_TOO_LARGE" };
    }
    return { ok:true, report:clean };
}

export class ClientPage5DeviceReportStore {
    constructor({ stagingDir, logger = null }) {
        if (!stagingDir || typeof stagingDir !== "string") {
            throw new Error("stagingDir required for durable Page5 reports");
        }
        this._stagingDir = stagingDir;
        this._logger = logger;
    }
    _dir(roomId) {
        const id = safeId(roomId, 64);
        return id ? join(this._stagingDir, id, "page5-device-reports") : null;
    }
    _file(roomId, playerId) {
        const dir = this._dir(roomId), id = safeId(playerId);
        return dir && id ? join(dir, id + ".json") : null;
    }
    record({ roomId, gameId, playerId, rawReport }) {
        const accepted = sanitizePage5DeviceReport({roomId,gameId,playerId,rawReport});
        if (!accepted.ok) return accepted;
        const file = this._file(roomId, playerId);
        if (!file) return {ok:false,reason:"INVALID_FILE_NAME"};
        const existing = this.readPlayer(roomId, gameId, playerId);
        if (existing) {
            return {ok:true,duplicate:true,received:this.snapshot(roomId,gameId).received};
        }
        const dir = this._dir(roomId);
        mkdirSync(dir, {recursive:true});
        // A previous server crash may leave an orphan temp file. A unique
        // name ensures reconnect retries can still publish this report.
        const temp = file + "." + randomUUID() + ".tmp";
        try {
            writeFileSync(temp, JSON.stringify(accepted.report) + "\n", {flag:"wx",mode:0o600});
            renameSync(temp,file);
        } catch (error) {
            try { rmSync(temp,{force:true}); } catch { /* ignore */ }
            this._logger?.warn?.("PAGE5_REPORT_PERSIST_FAILED | code="
                +(error?.code ?? "UNKNOWN"));
            return {ok:false,reason:"PERSIST_FAILED"};
        }
        this._logger?.info?.("PAGE5_DEVICE_REPORT_STORED | roomId="
            + roomId + " | playerId=" + playerId);
        return {ok:true,duplicate:false,received:this.snapshot(roomId,gameId).received};
    }
    readPlayer(roomId, gameId, playerId) {
        const file = this._file(roomId,playerId);
        if (!file || !existsSync(file)) return null;
        try {
            const raw = JSON.parse(readFileSync(file,"utf8"));
            if (raw?.roomId !== roomId || raw?.gameId !== gameId || raw?.playerId !== playerId
                || raw?.schema !== PAGE5_DEVICE_REPORT_SCHEMA) return null;
            return raw;
        } catch {
            return null;
        }
    }
    snapshot(roomId, gameId) {
        const dir = this._dir(roomId);
        const reports = [];
        if (dir && existsSync(dir)) {
            for (const file of readdirSync(dir).sort()) {
                if (!file.endsWith(".json")) continue;
                const playerId = file.slice(0,-5);
                const report = this.readPlayer(roomId,gameId,playerId);
                if (report) reports.push(report);
                if (reports.length >= PAGE5_DEVICE_REPORT_EXPECTED_PLAYERS) break;
            }
        }
        return {
            schemaVersion:1, roomId, gameId,
            expected:PAGE5_DEVICE_REPORT_EXPECTED_PLAYERS,
            received:reports.length,
            missing:Math.max(0,PAGE5_DEVICE_REPORT_EXPECTED_PLAYERS-reports.length),
            complete:reports.length === PAGE5_DEVICE_REPORT_EXPECTED_PLAYERS,
            reports
        };
    }
    hasAll(roomId,gameId) {
        return this.snapshot(roomId,gameId).complete;
    }
    remove(roomId) {
        const dir=this._dir(roomId);
        if (dir) rmSync(dir,{recursive:true,force:true});
    }
}
