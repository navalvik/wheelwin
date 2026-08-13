import { useEffect, useState } from "react";

import socket from "../socket/socket";

import { useLanguage } from "../context/LanguageContext";

import "../styles/joinRoomPanel.css";

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

export default function JoinRoomPanel({

    roomState,

    setRoomState

}) {

    const { t } = useLanguage();

    const [roomId, setRoomId] = useState("");

    useEffect(() => {

        function handleRoomState(data) {

            applyRoomPayload(setRoomState, data);

        }

        function handleRoomJoined(data) {

            applyRoomPayload(setRoomState, data);

        }

        function handleRoomError(data) {

            alert(data.message ?? t("room.unableToJoin"));

        }

        function handleRoomClosed() {

            alert(t("room.closed"));

            setRoomState((prev) => ({

                ...prev,

                roomCreated: false,

                roomCode: "",

                connectedPlayers: 0,

                players: []

            }));

        }

        socket.on("roomState", handleRoomState);

        socket.on("roomJoined", handleRoomJoined);

        socket.on("roomError", handleRoomError);

        socket.on("roomClosed", handleRoomClosed);

        return () => {

            socket.off("roomState", handleRoomState);

            socket.off("roomJoined", handleRoomJoined);

            socket.off("roomError", handleRoomError);

            socket.off("roomClosed", handleRoomClosed);

        };

    }, [setRoomState, t]);

    function joinRoom() {

        if (roomId.trim() === "") return;

        socket.emit("joinRoom", roomId);

    }

    return (

        <div className="joinRoomPanel">

            <button

                className="primaryButton"

                onClick={joinRoom}

            >

                {t("room.joinRoom")}

            </button>

            <div className="joinForm">

                <label>

                    {t("room.roomId")}

                </label>

                <input

                    type="text"

                    value={roomId}

                    placeholder={t("room.enterRoomId")}

                    onChange={(e) =>
                        setRoomId(
                            e.target.value.trim()
                        )
                    }

                />

            </div>

            {

                roomState.connectedPlayers > 0 &&

                <div className="joinInfo">

                    <p>

                        {t("room.connected")}

                    </p>

                    <p>

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
