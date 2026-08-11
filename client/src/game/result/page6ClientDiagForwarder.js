/**
 * R12.5G — Forward Page6 client diagnostics over the existing Socket.IO lobby channel.
 * Observation only. Never navigates or mutates gameplay state.
 *
 * Socket is loaded lazily so pure unit tests can import diag helpers without
 * initializing the client socket module.
 */

import { LOBBY_OUTGOING_EVENTS } from "../../socket/socketEvents";

import {
    buildPage6ClientDiagPayload,
    resolvePage6ClientType,
    shouldAttachPage6DomSnapshot
} from "./page6ClientDiagBridge.js";

let lastForwardFingerprint = "";

/**
 * Emit a sanitized client diagnostic record to the server.
 * Silent no-op when the socket is unavailable/disconnected.
 */
export function forwardPage6ClientDiag(event, fields = {}, options = {}) {

    const includeDom = options.includeDomSnapshot === true
        || shouldAttachPage6DomSnapshot(event);

    // Build payload first (pure). Socket emit is best-effort / async.
    const visibilityState = typeof document !== "undefined"
        ? document.visibilityState
        : null;

    const basePayload = buildPage6ClientDiagPayload({
        event,
        fields,
        roomId: fields?.roomId ?? null,
        gameId: fields?.gameId ?? null,
        playerId: fields?.playerId ?? null,
        socketId: null,
        clientType: resolvePage6ClientType(),
        socketConnected: null,
        visibilityState,
        includeDomSnapshot: includeDom
    });

    const fingerprint = JSON.stringify({
        event: basePayload.event,
        roomId: basePayload.roomId,
        playerId: basePayload.playerId,
        currentPage: basePayload.currentPage,
        footerMode: basePayload.footerMode,
        timerLabel: basePayload.timerLabel ?? basePayload.selectedLabel,
        timerValue: basePayload.timerValue ?? basePayload.selectedValue,
        combination: basePayload.combination,
        page6DomPresent: basePayload.page6DomPresent,
        infoBarTimerLabelText: basePayload.infoBarTimerLabelText,
        infoBarTimerValueText: basePayload.infoBarTimerValueText,
        resultSessionExpiresAt: basePayload.resultSessionExpiresAt,
        remainingResultSessionSeconds: basePayload.remainingResultSessionSeconds
    });

    if (!options.force && fingerprint === lastForwardFingerprint) {

        return null;

    }

    lastForwardFingerprint = fingerprint;

    Promise.resolve()
        .then(async () => {

            const socketModule = await import("../../socket/socket.js");

            const socket = socketModule.default;

            if (!socket || typeof socket.emit !== "function") {

                return;

            }

            if (socket.connected !== true && options.requireConnected !== false) {

                return;

            }

            const payload = {
                ...basePayload,
                socketId: socket.id ?? null,
                socketConnected: socket.connected === true
            };

            socket.emit(LOBBY_OUTGOING_EVENTS.PAGE6_CLIENT_DIAG, payload);

        })
        .catch(() => {

            // Diagnostics must never throw into UI paths.

        });

    return basePayload;

}

export function resetPage6ClientDiagForwarderForTests() {

    lastForwardFingerprint = "";

}
