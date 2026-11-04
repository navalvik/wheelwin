import { useEffect, useRef } from "react";

import { usePlayerIdentity } from "../context/PlayerIdentityContext";
import {
    CLIENT_PAGE_NAMES,
    createClientPageConfirmation,
    createClientPageConfirmationOutbox,
    inspectPageUi,
    nextClientPageSequence
} from "../game/diagnostics/clientPageConfirmation.js";
import { LOBBY_OUTGOING_EVENTS } from "../socket/socketEvents.js";
import socket from "../socket/socket.js";

function sequenceStorageKey() {
    // One monotonic stream per browser tab survives PlayerIdentityProvider
    // resets at FINISH, including the final Page1 confirmation.
    return "wheelwin.clientPageSequence";
}

function readSequence(key) {
    try {
        const value = Number(window.sessionStorage?.getItem(key));
        return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    } catch {
        return 0;
    }
}

function writeSequence(key, sequence) {
    try {
        window.sessionStorage?.setItem(key, String(sequence));
    } catch {
        // Diagnostics must never interrupt local navigation.
    }
}

function recordAcknowledgement(reference, event, error, result) {
    const acknowledgement = error
        ? { sequenceNumber: event.sequenceNumber, accepted: false, reason: "ACK_TIMEOUT" }
        : { sequenceNumber: event.sequenceNumber, ...result };
    reference.current = acknowledgement;
    try {
        window.dispatchEvent(new CustomEvent("wheelwin:client-page-confirmation-ack", {
            detail: acknowledgement
        }));
    } catch {
        // Local diagnostics are best effort only.
    }
}

export default function ClientPageConfirmationReporter({ currentPage, lastNavigationRequest = null }) {
    const { identity } = usePlayerIdentity();
    const outboxRef = useRef(null);
    const sequenceRef = useRef(0);
    const acknowledgementRef = useRef(null);
    if (!outboxRef.current) outboxRef.current = createClientPageConfirmationOutbox();

    const pageName = CLIENT_PAGE_NAMES[currentPage] ?? null;
    const roomId = identity?.roomId ?? null;
    const gameId = identity?.gameId ?? null;
    const playerId = identity?.playerId ?? null;
    const currentReportRef = useRef(null);
    currentReportRef.current = { roomId, gameId, playerId, currentPage, pageName };

    useEffect(() => {
        if (!pageName || typeof window === "undefined" || typeof document === "undefined") {
            return undefined;
        }
        const key = sequenceStorageKey();
        const sequenceNumber = nextClientPageSequence(
            sequenceRef.current,
            readSequence(key)
        );
        sequenceRef.current = sequenceNumber;
        writeSequence(key, sequenceNumber);
        const clientEventAt = Date.now();
        let frameId = null;

        const send = (event) => {
            if (!event || !socket.connected) return;
            const acknowledge = (error, result) => recordAcknowledgement(
                acknowledgementRef, event, error, result
            );
            if (typeof socket.timeout === "function") {
                socket.timeout(2000).emit(
                    LOBBY_OUTGOING_EVENTS.CLIENT_PAGE_CONFIRMED,
                    event,
                    acknowledge
                );
            } else {
                socket.emit(
                    LOBBY_OUTGOING_EVENTS.CLIENT_PAGE_CONFIRMED,
                    event,
                    (result) => acknowledge(null, result)
                );
            }
        };

        const publishAfterCommit = () => {
            const uiState = inspectPageUi(document, pageName);
            const event = createClientPageConfirmation({
                roomId,
                gameId,
                playerId,
                page: currentPage,
                sequenceNumber,
                clientEventAt,
                requestedPage: lastNavigationRequest?.toPage === currentPage
                    ? lastNavigationRequest.toPage
                    : null,
                requestedFromPage: lastNavigationRequest?.toPage === currentPage
                    ? lastNavigationRequest.fromPage
                    : null,
                navigationRequestedAt: lastNavigationRequest?.toPage === currentPage
                    ? lastNavigationRequest.requestedAt
                    : null,
                uiState
            });
            outboxRef.current.publish(event, socket.connected, send);
        };

        frameId = window.requestAnimationFrame(publishAfterCommit);
        return () => {
            if (frameId != null) window.cancelAnimationFrame(frameId);
        };
    }, [currentPage, pageName, roomId, gameId, playerId, lastNavigationRequest]);

    useEffect(() => {
        const replayLatest = () => {
            const latest = outboxRef.current.getLatest();
            const current = currentReportRef.current;
            if (latest && current?.pageName && typeof document !== "undefined") {
                outboxRef.current.replaceLatest(Object.freeze({
                    ...latest,
                    roomId: current.roomId ?? latest.roomId,
                    gameId: current.gameId ?? latest.gameId,
                    playerId: current.playerId ?? latest.playerId,
                    page: current.pageName,
                    uiState: inspectPageUi(document, current.pageName)
                }));
            }
            outboxRef.current.replay(socket.connected, (event) => {
                if (!socket.connected) return;
                const acknowledge = (error, result) => recordAcknowledgement(
                    acknowledgementRef, event, error, result
                );
                if (typeof socket.timeout === "function") {
                    socket.timeout(2000).emit(
                        LOBBY_OUTGOING_EVENTS.CLIENT_PAGE_CONFIRMED,
                        event,
                        acknowledge
                    );
                } else {
                    socket.emit(
                        LOBBY_OUTGOING_EVENTS.CLIENT_PAGE_CONFIRMED,
                        event,
                        (result) => acknowledge(null, result)
                    );
                }
            });
        };
        socket.on("connect", replayLatest);
        socket.on("ROOM_RECOVERY_SYNC", replayLatest);
        return () => {
            socket.off("connect", replayLatest);
            socket.off("ROOM_RECOVERY_SYNC", replayLatest);
        };
    }, []);

    return null;
}
