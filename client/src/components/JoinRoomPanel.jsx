import { useEffect, useState } from "react";

import socket from "../socket/socket";

import { usePlayerIdentity } from "../context/PlayerIdentityContext";

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

    const [roomId, setRoomId] = useState("");

    const { setIdentity } = usePlayerIdentity();

    useEffect(() => {

        function handleRoomState(data) {

            applyRoomPayload(setRoomState, data);

        }

        function handleRoomJoined(data) {

            applyRoomPayload(setRoomState, data);

            if (data?.roomId && data?.playerId) {

                setIdentity({
                    roomId: data.roomId,
                    playerId: data.playerId
                });

            }

        }

        function handleRoomError(data) {

            alert(data.message ?? "Unable to join room.");

        }

        function handleRoomClosed(data) {

            alert("The room was closed.");

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

    }, [setRoomState, setIdentity]);

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

                JOIN ROOM

            </button>

            <div className="joinForm">

                <label>

                    Room ID

                </label>

                <input

                    type="text"

                    value={roomId}

                    placeholder="Enter Room ID"

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

                        Connected ✓

                    </p>

                    <p>

                        Waiting for players...

                    </p>

                    <div className="playersCounter">

                        <div className="playersTitle">

                            Players connected

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