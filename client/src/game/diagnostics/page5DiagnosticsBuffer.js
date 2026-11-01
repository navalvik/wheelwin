// Bounded, non-sensitive Page5 diagnostics buffer. No network traffic is generated here.
// The existing authenticated diagnostic transport will drain these records when wired.
export const MAX_PAGE5_DIAGNOSTIC_EVENTS = 240;

const IMPORTANT_KINDS = new Set([
    "phase_changed", "ready_attempt", "ready_sent", "ready_ack", "ready_rejected",
    "state_rejected", "clock_rejected",
    "ready_phase_started", "ready_phase_completed",
    "connection_changed", "recovery", "page5_mount", "page5_unmount",
    "page6_received", "page6_rendered", "client_error"
]);

const ALLOWED_FIELDS = new Set([
    "kind", "phase", "displayedPhase", "clockLabel", "clockValue",
    "serverTimestamp", "sequence", "receiveMs", "applyMs", "renderMs",
    "buttonState", "buttonEnabled", "buttonLocked", "readyConfirmed",
    "connected", "reason", "wheelAngle", "pointerAngle", "build"
]);

function cleanValue(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") return value.slice(0, 80);
    return null;
}

export function createPage5DiagnosticsBuffer(limit = MAX_PAGE5_DIAGNOSTIC_EVENTS) {
    const capacity = Math.max(1, Math.min(MAX_PAGE5_DIAGNOSTIC_EVENTS, Math.floor(limit) || 1));
    const events = [];
    let droppedSamples = 0;
    let droppedImportant = 0;
    const lastSampleAt = new Map();

    return {
        record(input, nowMs = Date.now()) {
            if (!input || typeof input !== "object" || typeof input.kind !== "string") return false;
            const important = IMPORTANT_KINDS.has(input.kind);
            if (!important && nowMs - (lastSampleAt.get(input.kind) ?? -Infinity) < 1000) return false;
            if (!important) lastSampleAt.set(input.kind, nowMs);
            const event = { recordedAt: Number.isFinite(nowMs) ? nowMs : null };
            for (const key of ALLOWED_FIELDS) {
                if (Object.prototype.hasOwnProperty.call(input, key)) event[key] = cleanValue(input[key]);
            }
            if (events.length >= capacity) {
                const sampleIndex = events.findIndex((item) => !IMPORTANT_KINDS.has(item.kind));
                if (sampleIndex >= 0) {
                    events.splice(sampleIndex, 1);
                    droppedSamples++;
                } else if (!important) {
                    droppedSamples++;
                    return false;
                } else {
                    events.shift();
                    droppedImportant++;
                }
            }
            events.push(event);
            return true;
        },
        drain() {
            const result = { schemaVersion: 1, events: events.splice(0), droppedSamples, droppedImportant };
            droppedSamples = 0;
            droppedImportant = 0;
            return result;
        },
        snapshot() { return { schemaVersion: 1, events: events.slice(), droppedSamples, droppedImportant }; }
    };
}
