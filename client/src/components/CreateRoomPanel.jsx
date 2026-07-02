import { useEffect } from "react";

import "../styles/createRoomPanel.css";
import socket from "../socket/socket";

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

    useEffect(() => {

        function handleRoomState(data) {

            applyRoomPayload(setRoomState, data);

        }

        function handleRoomCreated(data) {

            applyRoomPayload(setRoomState, data);

        }

        socket.on("roomState", handleRoomState);

        socket.on("roomCreated", handleRoomCreated);

        return () => {

            socket.off("roomState", handleRoomState);

            socket.off("roomCreated", handleRoomCreated);

        };

    }, [setRoomState]);

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

                        ? "ROOM CREATED ✓"

                        : "CREATE ROOM"

                }

            </button>

            {

                roomState.roomCreated &&

                <div className="roomInfo">

                    <h2>Room ID</h2>

                    <div className="roomCode">

                        {roomState.roomCode}

                    </div>

                    <p className="waiting">

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