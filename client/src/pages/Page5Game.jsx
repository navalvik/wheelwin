import { useEffect } from "react";

import GameLayout from "../layouts/GameLayout";

import { DEV_MODE } from "../config/devMode";

import WheelPlaceholder from "../components/page5/WheelPlaceholder";
import Page5PlayerPanel from "../components/page5/Page5PlayerPanel";
import Page5ResultOverlay from "../components/page5/Page5ResultOverlay";

import { useCentralButton } from "../context/CentralButtonContext";
import { useGameState } from "../context/GameStateContext";
import { GAME_STATES } from "../game/GameState";
import { useInputAck } from "../context/InputAckContext";
import { useWheelConfig } from "../context/WheelConfigContext";
import { usePreGameReady } from "../context/PreGameReadyContext";

import "../styles/page5game.css";

export default function Page5Game({ onNavigate: _onNavigate }) {

    const { gameState } = useGameState();

    const { localConfirmed } = usePreGameReady();

    const isPreGameReadyPhase = gameState === GAME_STATES.PRE_GAME_READY;

    const isReadyPhase = gameState === GAME_STATES.READY;

    const isSelfTestPhase = gameState === GAME_STATES.SELF_TEST;

    const isBrakePhase = gameState === GAME_STATES.BRAKE;

    const isResultPhase = gameState === GAME_STATES.RESULT;

    const buttonInputDisabled = isReadyPhase
        || isSelfTestPhase
        || isBrakePhase
        || isResultPhase
        || (isPreGameReadyPhase && localConfirmed);

    const { lastAck } = useInputAck();

    const { wheelConfiguration } = useWheelConfig();

    const {
        snapshot: buttonSnapshot,
        press,
        release,
        confirmPreGameReady,
        applyPreGameReadyConfirmation
    } = useCentralButton();

    useEffect(() => {

        if (!isPreGameReadyPhase) {

            return;

        }

        applyPreGameReadyConfirmation(localConfirmed);

    }, [
        isPreGameReadyPhase,
        localConfirmed,
        applyPreGameReadyConfirmation
    ]);

    useEffect(() => () => {

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

                {!isPreGameReadyPhase && (

                    <div className="page5__gameStateBadge" aria-live="polite">

                        {gameState}

                    </div>

                )}

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
                                onButtonPress={
                                    isPreGameReadyPhase
                                        ? confirmPreGameReady
                                        : (buttonInputDisabled ? undefined : press)
                                }
                                onButtonRelease={
                                    isPreGameReadyPhase
                                        ? undefined
                                        : (buttonInputDisabled ? undefined : release)
                                }
                            />

                            {isResultPhase && <Page5ResultOverlay />}

                        </div>

                    </div>

                </div>

            </div>

        </GameLayout>

    );

}
