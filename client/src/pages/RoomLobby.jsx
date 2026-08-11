import { useEffect, useState } from "react";

import GameLayout from "../layouts/GameLayout";

import CreateRoomPanel from "../components/CreateRoomPanel";
import JoinRoomPanel from "../components/JoinRoomPanel";

import { useLanguage } from "../context/LanguageContext";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";

import socket from "../socket/socket";

import { ROOM_DEFAULTS } from "../utils/roomDefaults";

import "../styles/roomLobby.css";

export default function RoomLobby({

    onNavigate

}) {

    const { t } = useLanguage();

    const [roomState, setRoomState] = useState(ROOM_DEFAULTS);

    const { setIdentity } = usePlayerIdentity();

    useEffect(() => {

        // Identity listeners live on the lobby parent so they survive panel
        // unmount when startGame navigates away before roomJoined arrives.
        function handleRoomCreated(data) {

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

        function handleRoomJoined(data) {

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

        function handleStartGame(data) {

            setRoomState((prev) => ({

                ...prev,

                roomCode: data.roomId,

                connectedPlayers: data.players?.length ?? prev.connectedPlayers,

                players: data.players ?? prev.players

            }));

            // Binding playerId here covers the filling joiner: startGame can
            // arrive before roomJoined, after JoinRoomPanel has unmounted.
            setIdentity({
                roomId: data.roomId ?? undefined,
                gameId: data.gameId ?? undefined,
                ...(data.playerId ? { playerId: data.playerId } : {})
            });

            if (onNavigate) {

                onNavigate(3);

            }

        }

        socket.on("roomCreated", handleRoomCreated);

        socket.on("roomJoined", handleRoomJoined);

        socket.on("startGame", handleStartGame);

        return () => {

            socket.off("roomCreated", handleRoomCreated);

            socket.off("roomJoined", handleRoomJoined);

            socket.off("startGame", handleStartGame);

        };

    }, [onNavigate, setIdentity]);

    return (

        <GameLayout

            message={t("page.lobby.title")}

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
