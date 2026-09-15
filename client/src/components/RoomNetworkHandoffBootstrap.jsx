import { useCallback, useEffect, useRef, useState } from "react";

import socket from "../socket/socket";

import {
    clearHandoff,
    hasTelegramInitData,
    isHandoffExpired,
    readHandoff,
    readMainnetStartParam,
    readStartParamHandoff,
    storeHandoff
} from "../network/roomNetworkHandoff.js";

/**
 * R24 — Mainnet-side consumption of the R22 cross-runtime room handoff.
 *
 * Mounted at the application flow root (both runtimes). When no handoff
 * continuation is present the component renders NOTHING and the normal
 * direct-Mainnet flow (Page1 → CREATE_ROOM → RoomLobby) is untouched.
 *
 * With a pending handoff:
 * 1. The opaque handoffId is recovered from the Telegram startapp
 *    start_param (the only value carried across the runtime transition) or
 *    from same-origin temporary storage (reload/retry).
 * 2. The client navigates into the normal RoomLobby page so the
 *    authoritative R23 room events (roomCreated / roomState) hydrate the
 *    existing lobby UI — nothing is fabricated client-side.
 * 3. When the socket is connected, `roomNetworkHandoffBootstrapRequest` is
 *    emitted with EXACTLY { handoffId } — never identity, room ids or any
 *    other field (the server already knows the authenticated identity).
 * 4. `roomNetworkHandoffBootstrapResult` { roomId, network: "mainnet" } →
 *    the temporary handoff storage is cleared. Reconnects re-submit the
 *    SAME handoffId (server-side R23 idempotency guarantees at most one
 *    Mainnet room); no new handoff or room is ever generated client-side
 *    and CREATE_ROOM is never used as a bootstrap fallback.
 * 5. `roomError` codes: ROOM_NETWORK_HANDOFF_BOOTSTRAP_INVALID is a
 *    definitive rejection (handoff cleared, no fallback); all other codes
 *    retain the handoff and expose a retry.
 */

const BOOTSTRAP_REQUEST_EVENT = "roomNetworkHandoffBootstrapRequest";

const BOOTSTRAP_RESULT_EVENT = "roomNetworkHandoffBootstrapResult";

const ROOM_ERROR_EVENT = "roomError";

const CODE_HANDOFF_INVALID = "ROOM_NETWORK_HANDOFF_BOOTSTRAP_INVALID";

const CODE_HANDOFF_RETRY_REQUIRED =
    "ROOM_NETWORK_HANDOFF_BOOTSTRAP_RETRY_REQUIRED";

const STATUS_PENDING = "pending";

const STATUS_RETRY = "retry";

const STATUS_FAILED = "failed";

const MESSAGES = Object.freeze({

    [STATUS_PENDING]: "Continuing on Mainnet…",

    [CODE_HANDOFF_RETRY_REQUIRED]:
        "Your Mainnet room is ready, but the handoff could not be finalized. Please retry.",

    [CODE_HANDOFF_INVALID]:
        "This Mainnet handoff is invalid or can no longer be used.",

    UNAVAILABLE:
        "The Mainnet handoff service is not available right now. Please retry.",

    REQUIRES_TELEGRAM:
        "Telegram authentication is required. Please reopen via Telegram."

});

const overlayStyle = Object.freeze({
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 60,
    display: "flex",
    gap: "12px",
    alignItems: "center",
    justifyContent: "center",
    padding: "10px 16px",
    background: "rgba(12, 16, 24, 0.92)",
    color: "#fff",
    fontSize: "14px"
});

const retryButtonStyle = Object.freeze({
    padding: "6px 14px",
    cursor: "pointer"
});

/**
 * Handoff ids whose bootstrap has definitively finished (succeeded) or was
 * definitively rejected (INVALID). Guards against re-arming the bootstrap
 * from the persistent Telegram start_param after the transition is done —
 * a re-armed bootstrap would violate the one-handoff-one-room discipline
 * on the client side and re-navigate the user.
 */
const CONSUMED_HANDOFF_IDS = new Set();

export default function RoomNetworkHandoffBootstrap({ onNavigate }) {

    const [status, setStatus] = useState(null);

    // Pending handoff record (null once cleared/consumed).
    const handoffRef = useRef(null);

    // One in-flight bootstrap request at a time.
    const inFlightRef = useRef(false);

    // Stable access to the (unstable) navigation callback.
    const onNavigateRef = useRef(onNavigate);

    onNavigateRef.current = onNavigate;

    useEffect(() => {

        let handoff = readHandoff();

        if (!handoff) {

            // Fresh Mainnet Mini App launch: the opaque handoffId arrives
            // via the Telegram startapp start_param (transport only).
            const startParamHandoffId =
                readStartParamHandoff(readMainnetStartParam());

            if (
                startParamHandoffId
                && !CONSUMED_HANDOFF_IDS.has(startParamHandoffId)
            ) {

                handoff = {
                    handoffId: startParamHandoffId,
                    targetNetwork: "mainnet",
                    expiresAt: null
                };

                storeHandoff(handoff);

            }

        }

        if (
            !handoff
            || CONSUMED_HANDOFF_IDS.has(handoff.handoffId)
            || isHandoffExpired(handoff)
        ) {

            if (handoff && isHandoffExpired(handoff)) {

                // An expired handoff must not be submitted to Mainnet.
                clearHandoff();

            }

            return undefined;

        }

        handoffRef.current = handoff;

        // Enter the normal Mainnet RoomLobby flow immediately so the
        // authoritative room events hydrate the existing lobby UI.
        onNavigateRef.current?.(2);

        const hasPendingHandoff = () => {

            const current = readHandoff();

            return Boolean(
                current
                && handoffRef.current
                && current.handoffId === handoffRef.current.handoffId
            );

        };

        const requestBootstrap = () => {

            if (inFlightRef.current || !hasPendingHandoff()) {

                return;

            }

            if (!socket.connected) {

                return;

            }

            if (!hasTelegramInitData()) {

                // Without fresh Telegram authentication the bootstrap cannot
                // succeed; retain the handoff and surface the controlled
                // state instead of submitting an unauthenticated request.
                setStatus({
                    kind: STATUS_RETRY,
                    message: MESSAGES.REQUIRES_TELEGRAM
                });

                return;

            }

            inFlightRef.current = true;

            setStatus({ kind: STATUS_PENDING });

            socket.emit(BOOTSTRAP_REQUEST_EVENT, {
                handoffId: handoffRef.current.handoffId
            });

        };

        const handleConnect = () => {

            inFlightRef.current = false;

            requestBootstrap();

        };

        const handleDisconnect = () => {

            inFlightRef.current = false;

        };

        const handleResult = (data) => {

            if (!hasPendingHandoff()) {

                return;

            }

            const roomId = typeof data?.roomId === "string"
                ? data.roomId
                : "";

            if (!roomId || data?.network !== "mainnet") {

                // Malformed result: keep the handoff; a reconnect/retry
                // re-submits the same handoffId (server-side idempotent).
                inFlightRef.current = false;

                setStatus({
                    kind: STATUS_RETRY,
                    message: MESSAGES[CODE_HANDOFF_RETRY_REQUIRED]
                });

                return;

            }

            // Success: the authoritative Mainnet room exists. Clear the
            // temporary handoff; the lobby hydration comes from the normal
            // roomCreated / roomState events of the R23 creation path.
            CONSUMED_HANDOFF_IDS.add(handoffRef.current.handoffId);

            handoffRef.current = null;

            inFlightRef.current = false;

            clearHandoff();

            setStatus(null);

            onNavigateRef.current?.(2);

        };

        const handleRoomError = (data) => {

            if (!hasPendingHandoff()) {

                return;

            }

            inFlightRef.current = false;

            const code = data?.code ?? null;

            if (code === CODE_HANDOFF_INVALID) {

                // Definitive rejection (expired / nonexistent / owner
                // mismatch / malformed). Clear the handoff; NEVER fall back
                // to ordinary CREATE_ROOM for this handoff.
                CONSUMED_HANDOFF_IDS.add(handoffRef.current.handoffId);

                handoffRef.current = null;

                clearHandoff();

                setStatus({
                    kind: STATUS_FAILED,
                    message: data?.message || MESSAGES[CODE_HANDOFF_INVALID]
                });

                return;

            }

            // Everything else (RETRY_REQUIRED, UNAVAILABLE, Telegram auth,
            // quota, draining, unknown) keeps the handoff and allows retry.
            const message = code === CODE_HANDOFF_RETRY_REQUIRED
                ? MESSAGES[CODE_HANDOFF_RETRY_REQUIRED]
                : (data?.message || MESSAGES.UNAVAILABLE);

            setStatus({ kind: STATUS_RETRY, message });

        };

        socket.on("connect", handleConnect);

        socket.on("disconnect", handleDisconnect);

        socket.on(BOOTSTRAP_RESULT_EVENT, handleResult);

        socket.on(ROOM_ERROR_EVENT, handleRoomError);

        requestBootstrap();

        return () => {

            socket.off("connect", handleConnect);

            socket.off("disconnect", handleDisconnect);

            socket.off(BOOTSTRAP_RESULT_EVENT, handleResult);

            socket.off(ROOM_ERROR_EVENT, handleRoomError);

        };

    }, []);

    const handleRetry = useCallback(() => {

        inFlightRef.current = false;

        if (socket.connected) {

            const current = readHandoff();

            if (current && handoffRef.current?.handoffId === current.handoffId) {

                inFlightRef.current = true;

                setStatus({ kind: STATUS_PENDING });

                socket.emit(BOOTSTRAP_REQUEST_EVENT, {
                    handoffId: current.handoffId
                });

            }

        }

    }, []);

    const handleDismiss = useCallback(() => {

        setStatus(null);

    }, []);

    if (!status) {

        return null;

    }

    return (

        <div style={overlayStyle} role="status">

            <span>{status.message}</span>

            {status.kind === STATUS_RETRY && (

                <button

                    type="button"

                    style={retryButtonStyle}

                    onClick={handleRetry}

                >

                    RETRY

                </button>

            )}

            {status.kind === STATUS_FAILED && (

                <button

                    type="button"

                    style={retryButtonStyle}

                    onClick={handleDismiss}

                >

                    CLOSE

                </button>

            )}

        </div>

    );

}
