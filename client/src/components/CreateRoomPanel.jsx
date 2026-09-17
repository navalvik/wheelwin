import { useEffect, useState } from "react";

import "../styles/createRoomPanel.css";
import socket from "../socket/socket";

import { useLanguage } from "../context/LanguageContext";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";

const PAYMENT_NETWORK_TESTNET = "testnet";
const PAYMENT_NETWORK_MAINNET = "mainnet";

function applyRoomPayload(setRoomState, data) {

    setRoomState((prev) => ({

        ...prev,

        roomCreated: true,

        roomCode: data.roomId,

        connectedPlayers: data.connectedPlayers ?? data.playerCount ?? 0,

        maxPlayers: data.maxPlayers ?? 3,

        players: data.players ?? [],

        paymentNetwork: data.paymentNetwork ?? prev.paymentNetwork ?? PAYMENT_NETWORK_TESTNET,

        ownerPlayerId: data.ownerPlayerId ?? prev.ownerPlayerId ?? null

    }));

}

export default function CreateRoomPanel({

    roomState,

    setRoomState

}) {

    const { setIdentity } = usePlayerIdentity();

    const { t } = useLanguage();

    const [selectedPaymentNetwork, setSelectedPaymentNetwork] = useState(
        PAYMENT_NETWORK_TESTNET
    );

    useEffect(() => {

        function handleRoomState(data) {

            applyRoomPayload(setRoomState, data);

            if (data?.paymentNetwork === PAYMENT_NETWORK_MAINNET
                || data?.paymentNetwork === PAYMENT_NETWORK_TESTNET) {

                setSelectedPaymentNetwork(data.paymentNetwork);

            }

        }

        function handleRoomCreated(data) {

            applyRoomPayload(setRoomState, data);

            if (data?.paymentNetwork === PAYMENT_NETWORK_MAINNET
                || data?.paymentNetwork === PAYMENT_NETWORK_TESTNET) {

                setSelectedPaymentNetwork(data.paymentNetwork);

            }

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

    function toggleMainnet() {

        if (roomState.roomCreated) {

            return;

        }

        setSelectedPaymentNetwork((current) => (
            current === PAYMENT_NETWORK_MAINNET
                ? PAYMENT_NETWORK_TESTNET
                : PAYMENT_NETWORK_MAINNET
        ));

    }

    function createRoom() {

        if (roomState.roomCreated) return;

        socket.emit("createRoom", {
            paymentNetwork: selectedPaymentNetwork
        });

    }

    return (

        <div className="createRoomPanel">

            <button
                type="button"
                className={
                    selectedPaymentNetwork === PAYMENT_NETWORK_MAINNET
                        ? "mainnetPaymentButton selected"
                        : "mainnetPaymentButton"
                }
                onClick={toggleMainnet}
                disabled={roomState.roomCreated}
                aria-pressed={selectedPaymentNetwork === PAYMENT_NETWORK_MAINNET}
            >
                MAINNET
            </button>

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

                    <p className="networkStatus">

                        {t("room.networkLabel")}:{" "}

                        {

                            roomState.paymentNetwork === PAYMENT_NETWORK_MAINNET

                                ? t("room.networkMainnet")

                                : t("room.networkTestnet")

                        }

                    </p>

                </div>

            }

        </div>

    );

}
