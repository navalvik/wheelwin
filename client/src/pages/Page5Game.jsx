import { useEffect } from "react";

import GameLayout from "../layouts/GameLayout";

import { DEV_MODE } from "../config/devMode";

import WheelPlaceholder from "../components/page5/WheelPlaceholder";
import PlayerPanel from "../components/page5/PlayerPanel";

import { useCentralButton } from "../context/CentralButtonContext";
import { useGameState } from "../context/GameStateContext";
import { useInputAck } from "../context/InputAckContext";
import { useWheelConfig } from "../context/WheelConfigContext";

import "../styles/page5game.css";

export default function Page5Game({ onNavigate }) {

    const { gameState } = useGameState();

    const { lastAck } = useInputAck();

    const { wheelConfiguration } = useWheelConfig();

    const {
        snapshot: buttonSnapshot,
        press,
        release
    } = useCentralButton();

    useEffect(() => () => {

        // Page5 is presentation only. The gameplay engine providers now live at
        // the flow root, so navigating away from Page5 no longer tears down any
        // socket subscription. This log simply marks the visual disposal.
        if (DEV_MODE) {

            console.debug("[GameResult] Page5 disposed");

        }

    }, []);

    return (

        <GameLayout
            message="YOU MUST WIN"
            backEnabled={true}
            onBack={() => onNavigate(6)}
            nextEnabled={false}
            onNext={() => onNavigate(8)}
        >

            <div className="page5" data-game-state={gameState}>

                <div className="page5__gameStateBadge" aria-live="polite">

                    {gameState}

                </div>

                {lastAck && (

                    <div
                        className={`page5__inputAckBadge page5__inputAckBadge--${lastAck.status}`}
                        aria-live="polite"
                    >

                        {lastAck.label}

                    </div>

                )}

                <div className="gamePanel">

                    <div className="gameArea gamePanel__body">

                        <PlayerPanel />

                        <div className="wheelContainer gamePanel__wheelArea">

                            <WheelPlaceholder
                                wheelConfiguration={wheelConfiguration}
                                buttonSnapshot={buttonSnapshot}
                                onButtonPress={press}
                                onButtonRelease={release}
                            />

                        </div>

                    </div>

                </div>

            </div>

        </GameLayout>

    );

}
