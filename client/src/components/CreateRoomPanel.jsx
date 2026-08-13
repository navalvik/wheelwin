import { useEffect } from "react";

import "../styles/createRoomPanel.css";
import socket from "../socket/socket";

import { useLanguage } from "../context/LanguageContext";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";

function applyRoomPayload(setRoomState, data) {

    setRoomState((prev) => ({

        ...prev,

        roomCreated: true,

        roomCode: data.roomId,

        connectedPlayers: data.connectedPlayers ?? data.playerCount ?? 0,

        maxPlayers: data.maxPlayers ?? 3,

        players: data.players ?? []

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

        socket.on("roomState", handleRoomState);

        socket.on("roomCreated", handleRoomCreated);

        return () => {

            socket.off("roomState", handleRoomState);

            socket.off("roomCreated", handleRoomCreated);

        };

    }, [setRoomState, setIdentity]);

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
