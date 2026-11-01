/**
 * Per-WebView Page5 capture; one local report per room/game/player. The
 * existing server ZIP is NOT replaced or modified by this independent file.
 */
import { createLocalPage5Report } from "./localPage5ReportCore.js";

const STORAGE_KEY = "wheelwin.page5DeviceDiagnostics.v1";
const report = createLocalPage5Report({
    now: Date.now,
    mono: () => typeof performance !== "undefined" && typeof performance.now === "function"
        ? Math.round(performance.now() * 100) / 100
        : null
});
let lastPersistAt = 0;

function readDeviceInfo() {
    const nav = typeof navigator !== "undefined" ? navigator : {};
    const ua = nav.userAgent ?? "";
    const android = /Android\s+([0-9]+)/i.exec(ua);
    const chrome = /(?:Chrome|CriOS)\/([0-9]+)/i.exec(ua);
    const device = typeof window !== "undefined" ? window : null;
    const telegram = device?.Telegram?.WebApp;
    return {
        buildSha: typeof __WHEELWIN_BUILD_SHA__ !== "undefined"
            ? __WHEELWIN_BUILD_SHA__ : "unknown",
        buildMode: import.meta.env?.MODE ?? "unknown",
        platform: android ? "Android" : (/iPhone|iPad/i.test(ua) ? "iOS" : "Other"),
        androidMajor: android ? Number(android[1]) : null,
        chromeMajor: chrome ? Number(chrome[1]) : null,
        telegramVersion: telegram?.version ?? null,
        dpr: device?.devicePixelRatio ?? null,
        screenWidth: device?.screen?.width ?? null,
        screenHeight: device?.screen?.height ?? null,
        hardwareConcurrency: nav.hardwareConcurrency ?? null,
        deviceMemoryGb: nav.deviceMemory ?? null,
        timeZoneOffsetMin: new Date().getTimezoneOffset(),
        timeOriginMs: typeof performance !== "undefined"
            ? performance.timeOrigin ?? null : null
    };
}

function getStorage() {
    try {
        return typeof window !== "undefined" ? window.sessionStorage : null;
    } catch {
        return null;
    }
}

try {
    const raw = getStorage()?.getItem(STORAGE_KEY);
    if (raw && raw.length <= 250000) report.hydrate(JSON.parse(raw));
} catch {
    // In-memory capture remains available if sessionStorage is restricted.
}

function persist(force = false) {
    const current = Date.now();
    if (!force && current - lastPersistAt < 3000) return;
    const snapshot = report.snapshot();
    if (!snapshot) return;
    lastPersistAt = current;
    try {
        getStorage()?.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
        // WebViews with restricted/quota-exceeded storage remain in memory.
    }
}

export function configureLocalPage5Report(identity) {
    const configured = report.configure(identity, readDeviceInfo());
    if (configured) persist(true);
    return configured;
}

export function recordLocalPage5Event(event) {
    const ok = report.recordEvent(event);
    if (ok) persist(event?.kind === "page6_rendered"
        || event?.kind === "page5_unmount");
    return ok;
}

export function noteLocalPage5Socket(type, payload, wallMs, monoMs) {
    report.recordSocket(type, payload, wallMs, monoMs);
}

export function noteLocalPage5Dispatch(type, durationMs, wallMs) {
    report.recordDispatch(type, durationMs, wallMs);
}

export function noteLocalPage5Canvas(which, durationMs) {
    report.recordCanvas(which, durationMs);
}

export function noteLocalMainThreadStall(delayMs) {
    report.recordStall(delayMs);
    persist();
}

export function getLocalPage5Report(identity = null) {
    const snapshot = report.snapshot();
    if (!snapshot) return null;
    if (identity && (
        (identity.roomId && snapshot.roomId !== identity.roomId)
        || (identity.gameId && snapshot.gameId !== identity.gameId)
        || (identity.playerId && snapshot.playerId !== identity.playerId)
    )) return null;
    // Must remain pure when called by React during a Page6 render.
    return snapshot;
}

export function persistLocalPage5Report() {
    persist(true);
}

if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => persist(true));
}
