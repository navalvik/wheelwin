import { useState } from "react";

import GameLayout from "../layouts/GameLayout";

import PlayerInfoRow from "../components/PlayerInfoRow";

import { useGameSession } from "../context/GameSessionContext";

import "../styles/page3verify.css";

export default function Page3VerifyPlayers({ onNavigate }) {

    const { session } = useGameSession();

    const [walletAddress, setWalletAddress] = useState("");

    const isWalletValid = walletAddress.trim().length > 0;

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

                        {session.players.map((player) => (

                            <PlayerInfoRow

                                key={player.id}

                                labelTitle={player.labelTitle}

                                nickname={player.nickname}

                                icon={player.icon}

                                age={player.age}

                                sectorLabel={player.sectorLabel}

                                sectorValue={player.sectorValue}

                            />

                        ))}

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
