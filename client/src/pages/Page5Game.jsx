import { useEffect } from "react";

import GameLayout from "../layouts/GameLayout";

import { DEV_MODE } from "../config/devMode";

import WheelPlaceholder from "../components/page5/WheelPlaceholder";
import Page5PlayerPanel from "../components/page5/Page5PlayerPanel";

import { useCentralButton } from "../context/CentralButtonContext";
import { useGameState } from "../context/GameStateContext";
import { GAME_STATES } from "../game/GameState";
import { useInputAck } from "../context/InputAckContext";
import { useWheelConfig } from "../context/WheelConfigContext";

import "../styles/page5game.css";

export default function Page5Game({ onNavigate: _onNavigate }) {

    // C5.9C — no client-owned leave during active gameplay.
    // Page5 → Page6 is driven only by authoritative GAME_RESULT
    // (GameResultContext). Back/Next must not navigate locally.

    const { gameState } = useGameState();

    const isReadyPhase = gameState === GAME_STATES.READY;

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
            backEnabled={false}
            onBack={() => {}}
            nextEnabled={false}
            onNext={() => {}}
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

                        <Page5PlayerPanel />

                        <div className="wheelContainer gamePanel__wheelArea">

                            <WheelPlaceholder
                                wheelConfiguration={wheelConfiguration}
                                buttonSnapshot={buttonSnapshot}
                                onButtonPress={isReadyPhase ? undefined : press}
                                onButtonRelease={isReadyPhase ? undefined : release}
                            />

                        </div>

                    </div>

                </div>

            </div>

        </GameLayout>

    );

}
