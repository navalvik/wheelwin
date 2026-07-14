import { useState } from "react";

import GameLayout from "../layouts/GameLayout";

import PlayerInfoRow from "../components/PlayerInfoRow";

import { useAuthoritativeSession } from "../context/AuthoritativeSessionContext";
import { useGameSession } from "../context/GameSessionContext";

import {
    hasAuthoritativePlayers,
    listAuthoritativePlayers,
    mapAuthoritativePlayerToInfoRow
} from "../game/session";

import "../styles/page3verify.css";

export default function Page3VerifyPlayers({ onNavigate }) {

    // C5.3 — players come from AuthoritativeSession only.
    // Finance fields (stake / gram) stay on GameSessionContext until later stages.
    const authoritative = useAuthoritativeSession();

    const { session } = useGameSession();

    const [walletAddress, setWalletAddress] = useState("");

    const isWalletValid = walletAddress.trim().length > 0;

    const playersReady = hasAuthoritativePlayers(authoritative.players);

    const players = listAuthoritativePlayers(authoritative.players)
        .map(mapAuthoritativePlayerToInfoRow);

    return (

        <GameLayout

            message="VERIFY"

            backEnabled={true}

            onBack={() => onNavigate(4)}

            nextEnabled={isWalletValid}

            onNext={() => onNavigate(6)}

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

                                {session.paymentGram}

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
