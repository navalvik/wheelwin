import { useEffect } from "react";

import "../styles/createRoomPanel.css";
import socket from "../socket/socket";

import {
    isTestnetRuntime,
    launchMainnetMiniApp,
    storeHandoff,
    validateHandoffReadyPayload
} from "../network/roomNetworkHandoff.js";

import { useLanguage } from "../context/LanguageContext";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";

function applyRoomPayload(setRoomState, data) {

    setRoomState((prev) => ({

        ...prev,

        roomCreated: true,

        roomCode: data.roomId,

        connectedPlayers: data.connectedPlayers ?? data.playerCount ?? 0,

        maxPlayers: data.maxPlayers ?? 3,

        players: data.players ?? [],

        // Server-resolved network for the Telegram bot/runtime.
        network: data.network ?? prev.network ?? null

    }));

}

export default function CreateRoomPanel({

    roomState,

    setRoomState

}) {

    const { setIdentity } = usePlayerIdentity();

    const { t } = useLanguage();

    useEffect(() => {

        function handleRoomState(data) {

            applyRoomPayload(setRoomState, data);

        }

        function handleRoomCreated(data) {

            applyRoomPayload(setRoomState, data);

            if (data?.roomId && data?.playerId) {

                setIdentity({
                    roomId: data.roomId,
                    playerId: data.playerId,
                    ...(data.recoveryCredential
                        ? { recoveryCredential: data.recoveryCredential }
                        : {})
                });

            }

        }

        function handleRoomError(data) {

            const message = data?.code === "ROOM_CREATION_REQUIRES_TELEGRAM"
                ? t("room.telegramRequired")
                : data?.message ?? t("room.unableToJoin");

            alert(message);

        }

        // Compatibility with rooms created by an older server instance.
        function handleRoomNetworkSelected(data) {

            setRoomState((prev) => ({

                ...prev,

                network: data?.network ?? prev.network ?? null

            }));

        }

        // R24 — Owner-only cross-runtime MAINNET continuation. The server
        // delivers roomNetworkHandoffReady ONLY to the verified Owner's
        // socket (never in any room-wide broadcast). The Testnet client
        // persists the MINIMUM opaque fields and immediately launches the
        // Mainnet Mini App through the established Telegram mechanism. The
        // handoffId never enters room-wide state and is never displayed;
        // ownership is never validated client-side.
        function handleRoomNetworkHandoffReady(data) {

            if (!isTestnetRuntime()) {

                // The handoff continuation is meaningful only from the
                // Testnet runtime (a Mainnet room must never loop back into
                // the deep-link launch).
                return;

            }

            const handoff = validateHandoffReadyPayload(data);

            if (!handoff) {

                // Invalid or already-expired handoff: nothing is stored and
                // Mainnet is never launched with it.
                return;

            }

            storeHandoff(handoff);

            launchMainnetMiniApp();

        }

        socket.on("roomState", handleRoomState);

        socket.on("roomCreated", handleRoomCreated);

        socket.on("roomError", handleRoomError);

        socket.on("roomNetworkSelected", handleRoomNetworkSelected);

        socket.on("roomNetworkHandoffReady", handleRoomNetworkHandoffReady);

        return () => {

            socket.off("roomState", handleRoomState);

            socket.off("roomCreated", handleRoomCreated);

            socket.off("roomError", handleRoomError);

            socket.off("roomNetworkSelected", handleRoomNetworkSelected);

            socket.off("roomNetworkHandoffReady", handleRoomNetworkHandoffReady);

        };

    }, [setRoomState, setIdentity, t]);

    function createRoom() {

        if (roomState.roomCreated) return;

        socket.emit("createRoom");

    }

    return (

        <div className="createRoomPanel">

            <button

                className={`primaryButton ${roomState.roomCreated ? "created" : ""}`}

                onClick={createRoom}

                disabled={roomState.roomCreated}

            >

                {

                    roomState.roomCreated

                        ? t("room.roomCreated")

                        : t("room.createRoom")

                }

            </button>

            {

                roomState.roomCreated &&

                <div className="roomInfo">

                    <h2>{t("room.roomId")}</h2>

                    <div className="roomCode">

                        {roomState.roomCode}

                    </div>

                    <p className="waiting">

                        {t("room.waitingForPlayers")}

                    </p>

                    <div className="playersCounter">

                        <div className="playersTitle">

                            {t("room.playersConnected")}

                        </div>

                        <div className="playersValue">

                            {roomState.connectedPlayers} / {roomState.maxPlayers ?? 3}

                        </div>

                    </div>

                </div>

            }

        </div>

    );

}
