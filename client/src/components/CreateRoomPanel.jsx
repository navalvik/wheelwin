import { useEffect, useState } from "react";

import "../styles/createRoomPanel.css";
import socket from "../socket/socket";

import { useLanguage } from "../context/LanguageContext";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";

// R20 — authoritative room network values (server-normalized, lowercase).
const ROOM_NETWORK_TESTNET = "testnet";
const ROOM_NETWORK_MAINNET = "mainnet";

function applyRoomPayload(setRoomState, data) {

    setRoomState((prev) => ({

        ...prev,

        roomCreated: true,

        roomCode: data.roomId,

        connectedPlayers: data.connectedPlayers ?? data.playerCount ?? 0,

        maxPlayers: data.maxPlayers ?? 3,

        players: data.players ?? [],

        // R20 — authoritative room network. null until the room Owner has
        // committed the one-time Testnet/Mainnet selection server-side.
        network: data.network ?? prev.network ?? null

    }));

}

export default function CreateRoomPanel({

    roomState,

    setRoomState

}) {

    const { setIdentity } = usePlayerIdentity();

    const { t } = useLanguage();

    // R20 — the room creator is the socket that received ROOM_CREATED; the
    // server delivers that event to the creating socket only. Ownership is
    // never inferred from hostname or client-side identity.
    const [isCreator, setIsCreator] = useState(false);

    // R20 — true while the Owner's selection is in flight. Both choices stay
    // disabled until the server confirms via ROOM_NETWORK_SELECTED / roomState.
    const [selectionPending, setSelectionPending] = useState(false);

    useEffect(() => {

        function handleRoomState(data) {

            applyRoomPayload(setRoomState, data);

        }

        function handleRoomCreated(data) {

            applyRoomPayload(setRoomState, data);

            setIsCreator(true);

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

        // R20 — authoritative one-time network selection broadcast. Creator
        // and joiners render the confirmed value; no client-side state wins.
        function handleRoomNetworkSelected(data) {

            setRoomState((prev) => ({

                ...prev,

                network: data?.network ?? prev.network ?? null

            }));

            setSelectionPending(false);

        }

        socket.on("roomState", handleRoomState);

        socket.on("roomCreated", handleRoomCreated);

        socket.on("roomNetworkSelected", handleRoomNetworkSelected);

        return () => {

            socket.off("roomState", handleRoomState);

            socket.off("roomCreated", handleRoomCreated);

            socket.off("roomNetworkSelected", handleRoomNetworkSelected);

        };

    }, [setRoomState, setIdentity]);

    function createRoom() {

        if (roomState.roomCreated) return;

        socket.emit("createRoom");

    }

    // R20 — Owner-only, one-time room network selection. The server enforces
    // ownership and irreversibility; this control renders for the creator only
    // and only while the authoritative network is still pending.
    function selectRoomNetwork(network) {

        if (!isCreator || roomState.network || selectionPending) return;

        setSelectionPending(true);

        socket.emit("selectRoomNetwork", { network });

    }

    const showNetworkSelector = (
        roomState.roomCreated
        && isCreator
        && !roomState.network
    );

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

                    {

                        roomState.network &&

                        <p className="networkStatus">

                            {t("room.networkLabel")}:{" "}

                            {

                                roomState.network === ROOM_NETWORK_MAINNET

                                    ? t("room.networkMainnet")

                                    : t("room.networkTestnet")

                            }

                        </p>

                    }

                    {

                        showNetworkSelector &&

                        <div className="networkSelection">

                            <p className="networkPrompt">

                                {t("room.networkPrompt")}

                            </p>

                            <div className="networkButtons">

                                <button

                                    className="networkButton"

                                    onClick={() => selectRoomNetwork(ROOM_NETWORK_TESTNET)}

                                    disabled={selectionPending}

                                >

                                    {t("room.networkTestnet")}

                                </button>

                                <button

                                    className="networkButton"

                                    onClick={() => selectRoomNetwork(ROOM_NETWORK_MAINNET)}

                                    disabled={selectionPending}

                                >

                                    {t("room.networkMainnet")}

                                </button>

                            </div>

                        </div>

                    }

                </div>

            }

        </div>

    );

}
