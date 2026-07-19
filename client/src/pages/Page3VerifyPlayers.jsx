import { useEffect, useMemo, useState } from "react";

import GameLayout from "../layouts/GameLayout";

import PlayerInfoRow from "../components/PlayerInfoRow";

import { useAuthoritativeSession } from "../context/AuthoritativeSessionContext";
import { useGameSession } from "../context/GameSessionContext";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";

import {
    getAuthoritativePlayerSectorCount,
    hasAuthoritativePlayers,
    listAuthoritativePlayers,
    mapAuthoritativePlayerToInfoProp
} from "../game/session";

import { calculatePaymentGram } from "../utils/playerProfileRules";

import socket from "../socket/socket";

import "../styles/page3verify.css";

export default function Page3VerifyPlayers({ onNavigate }) {

    // AuthoritativeSession.players → lookup by playerId → nickname / sectorCount /
    // payment for highlight + footer. Never by array order.
    const authoritative = useAuthoritativeSession();

    const { session } = useGameSession();

    const { identity } = usePlayerIdentity();

    const localPlayerId = identity.playerId ?? null;

    const localAuthoritativePlayer = localPlayerId
        ? (authoritative.players[localPlayerId] ?? null)
        : null;

    const verifyCompleted = authoritative.lifecycle?.verifyCompleted === true;

    const [walletAddress, setWalletAddress] = useState("");

    const [waitingForVerify, setWaitingForVerify] = useState(false);

    const isWalletValid = walletAddress.trim().length > 0;

    const playersReady = hasAuthoritativePlayers(authoritative.players);

    const players = useMemo(
        () => listAuthoritativePlayers(authoritative.players)
            .map((player, index) => mapAuthoritativePlayerToInfoProp(
                player,
                index,
                {
                    localPlayerId,
                    baseStake: session.baseStake
                }
            )),
        [authoritative.players, localPlayerId, session.baseStake]
    );

    // Footer YOU NEED PAY — from the authoritative local player record only.
    const youNeedPay = calculatePaymentGram(
        session.baseStake,
        getAuthoritativePlayerSectorCount(localAuthoritativePlayer)
    );

    useEffect(() => {

        if (verifyCompleted) {

            setWaitingForVerify(false);

        }

    }, [verifyCompleted]);

    function handleConfirmVerify() {

        if (!isWalletValid || waitingForVerify || verifyCompleted) {

            return;

        }

        setWaitingForVerify(true);

        socket.emit("confirmVerify");

    }

    function handleNext() {

        if (verifyCompleted) {

            onNavigate(6);

            return;

        }

        handleConfirmVerify();

    }

    return (

        <GameLayout

            message="VERIFY"

            backEnabled={!waitingForVerify && !verifyCompleted}

            onBack={() => onNavigate(4)}

            nextEnabled={
                verifyCompleted
                    || (isWalletValid && !waitingForVerify)
            }

            onNext={handleNext}

        >

            <div className="page3">

                <div className="verifyPanel">

                    <div className="verifyPlayers">

                        {playersReady ? (

                            players.map((player) => (

                                <PlayerInfoRow

                                    key={player.key}

                                    labelTitle={player.labelTitle}

                                    nickname={player.nickname}

                                    icon={player.icon}

                                    age={player.age}

                                    sectorLabel={player.sectorLabel}

                                    sectorValue={player.sectorValue}

                                    paymentLabel={player.paymentLabel}

                                    paymentDisplay={player.paymentDisplay}

                                    isLocal={player.isLocal}

                                />

                            ))

                        ) : (

                            <div
                                className="verifyPlayersWaiting"
                                aria-live="polite"
                            >

                                Waiting for players…

                            </div>

                        )}

                    </div>

                    {waitingForVerify && !verifyCompleted && (

                        <div
                            className="verifyPlayersWaiting"
                            aria-live="polite"
                        >

                            Waiting for all players to confirm…

                        </div>

                    )}

                    {verifyCompleted && (

                        <div
                            className="verifyPlayersWaiting"
                            aria-live="polite"
                        >

                            Players verified. Continue to payment.

                        </div>

                    )}

                    <div className="verifyFinanceRow">

                        <div className="verifyFinanceGroup">

                            <span className="verifyFinanceLabel">

                                BASE STAKE

                            </span>

                            <span className="verifyFinanceValue">

                                {session.baseStake}

                            </span>

                        </div>

                        <div className="verifyFinanceGroup">

                            <span className="verifyFinanceLabel">

                                YOU NEED PAY GRAM

                            </span>

                            <span className="verifyFinanceValue">

                                {youNeedPay}

                            </span>

                        </div>

                    </div>

                    <div className="verifyWallet">

                        <label
                            className="verifyWalletLabel"
                            htmlFor="verifyWalletAddress"
                        >

                            ENTER YOUR GRAM (TON) TELEGRAM WALLET ADDRESS

                        </label>

                        <input
                            id="verifyWalletAddress"
                            className="verifyWalletInput"
                            type="text"
                            value={walletAddress}
                            disabled={waitingForVerify || verifyCompleted}
                            onChange={(e) =>
                                setWalletAddress(e.target.value)
                            }
                        />

                    </div>

                </div>

            </div>

        </GameLayout>

    );

}
