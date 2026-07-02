import { useEffect, useState } from "react";

import GameLayout from "../layouts/GameLayout";

import CreateRoomPanel from "../components/CreateRoomPanel";
import JoinRoomPanel from "../components/JoinRoomPanel";

import { usePlayerIdentity } from "../context/PlayerIdentityContext";

import socket from "../socket/socket";

import { ROOM_DEFAULTS } from "../utils/roomDefaults";

import "../styles/roomLobby.css";

export default function RoomLobby({

    onNavigate

}) {

    const [roomState, setRoomState] = useState(ROOM_DEFAULTS);

    const { setIdentity } = usePlayerIdentity();

    useEffect(() => {

        function handleStartGame(data) {

            setRoomState((prev) => ({

                ...prev,

                roomCode: data.roomId,

                connectedPlayers: data.players.length,

                players: data.players

            }));

            if (data?.gameId) {

                setIdentity({ gameId: data.gameId });

            }

            if (onNavigate) {

                onNavigate(3);

            }

        }

        socket.on("startGame", handleStartGame);

        return () => {

            socket.off("startGame", handleStartGame);

        };

    }, [onNavigate, setIdentity]);

    return (

        <GameLayout

            message="CREATE OR JOIN ROOM"

            showNextButton={false}

        >

            <div className="roomLobbyGrid">

                <CreateRoomPanel

                    roomState={roomState}

                    setRoomState={setRoomState}

                />

                <JoinRoomPanel

                    roomState={roomState}

                    setRoomState={setRoomState}

                />

            </div>

        </GameLayout>

    );

}