/**
 * Page5/READY observation-only telemetry. Never reads financial data and
 * never changes game phases, input handling, or client physics.
 *
 * Uses the existing PAGE6_CLIENT_DIAG socket event with an acked PAGE5 batch.
 * Buffered records survive temporary disconnections until the page closes.
 */
import socket from "../../socket/socket.js";
import { LOBBY_OUTGOING_EVENTS } from "../../socket/socketEvents.js";
import { createPage5DiagnosticsBuffer } from "./page5DiagnosticsBuffer.js";
import { configureLocalPage5Report, recordLocalPage5Event } from "./page5LocalReport.js";

let buffer = createPage5DiagnosticsBuffer();
let identity = null;
let pending = [];
let sending = false;
let nextBatch = 0;
let retryAfter = 0;
const clientSession = "p5-" + Date.now().toString(36) + "-"
    + Math.floor(Math.random() * 0x7fffffff).toString(36);
const MAX_EVENTS_PER_BATCH = 16;
const MAX_PENDING_BATCHES = 15;

function monotonicMs() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
        ? Math.round(performance.now()) : null;
}

export function configurePage5Diagnostics(next) {
    const values = {
        roomId: next?.roomId ?? null,
        gameId: next?.gameId ?? null,
        playerId: next?.playerId ?? null
    };
    if (!values.roomId || !values.gameId || !values.playerId) return false;
    if (identity && (identity.roomId !== values.roomId
        || identity.gameId !== values.gameId
        || identity.playerId !== values.playerId)) {
        buffer = createPage5DiagnosticsBuffer();
        pending = [];
        sending = false;
    }
    identity = values;
    configureLocalPage5Report({
        ...values,
        nickname: next?.nickname ?? null
    });
    return true;
}

export function recordPage5Diagnostic(input) {
    if (!identity) return false;
    const observation = {
        ...input,
        receiveMs: input?.receiveMs ?? monotonicMs()
    };
    // The local report is independent of the server batch drain: even
    // rejected/late diagnostic uploads cannot erase the phone's evidence.
    recordLocalPage5Event(observation);
    return buffer.record(observation);
}

function queueBufferedEvents() {
    if (pending.length >= MAX_PENDING_BATCHES) return;
    const drained = buffer.drain();
    const records = drained.events;
    if (!records.length && !drained.droppedSamples && !drained.droppedImportant) return;
    for (let i = 0; i < records.length && pending.length < MAX_PENDING_BATCHES; i += MAX_EVENTS_PER_BATCH) {
        pending.push({
            clientSession,
            batchId: String(++nextBatch),
            events: records.slice(i, i + MAX_EVENTS_PER_BATCH),
            droppedSamples: i === 0 ? drained.droppedSamples : 0,
            droppedImportant: i === 0 ? drained.droppedImportant : 0
        });
    }
}

export function flushPage5Diagnostics() {
    if (!identity || !socket.connected || sending || Date.now() < retryAfter) return false;
    queueBufferedEvents();
    if (!pending.length) return false;
    sending = true;
    const batch = pending[0];
    const boundIdentity = { ...identity };
    const expectedBatch = batch.batchId;

    socket.timeout(3000).emit(LOBBY_OUTGOING_EVENTS.PAGE6_CLIENT_DIAG, {
        event: "PAGE5_SYNC_BATCH",
        ...boundIdentity,
        syncBatch: batch
    }, (error, response) => {
        sending = false;
        if (!error && response?.ok === true && pending[0]?.batchId === expectedBatch) {
            pending.shift();
            retryAfter = 0;
        } else {
            retryAfter = Date.now() + 3000;
        }
        // Do not spin on repeated denials; the next sample or reconnect
        // explicitly retries the same batch.
    });
    return true;
}

socket.on("connect", () => {
    recordPage5Diagnostic({ kind: "connection_changed", connected: true });
    flushPage5Diagnostics();
});
socket.on("disconnect", () => {
    recordPage5Diagnostic({ kind: "connection_changed", connected: false });
});

export function getPage5DiagnosticsStatus() {
    return {
        configured: Boolean(identity),
        buffered: buffer.snapshot().events.length,
        pending: pending.length,
        connected: socket.connected === true
    };
}
