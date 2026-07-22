import { useEffect, useMemo } from "react";

import GameLayout from "../layouts/GameLayout";

import { DEV_MODE } from "../config/devMode";

import WheelPlaceholder from "../components/page5/WheelPlaceholder";
import Page5PlayerPanel from "../components/page5/Page5PlayerPanel";
import Page5ResultOverlay from "../components/page5/Page5ResultOverlay";

import { useAuthoritativeSession } from "../context/AuthoritativeSessionContext";
import { useCentralButton } from "../context/CentralButtonContext";
import { useGameResult } from "../context/GameResultContext";
import { useGameState } from "../context/GameStateContext";
import { GAME_STATES } from "../game/GameState";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";
import { useWheelConfig } from "../context/WheelConfigContext";
import { usePreGameReady } from "../context/PreGameReadyContext";
import { resolveLocalPlayerId } from "../game/session";

import "../styles/page5game.css";

function resolvePage5HeaderMessage(result, localPlayerId) {

    if (!result?.winner?.id || localPlayerId == null || localPlayerId === "") {

        return {
            message: "YOU MUST WIN",
            messageClassName: ""
        };

    }

    if (String(result.winner.id) === String(localPlayerId)) {

        return {
            message: "WIN",
            messageClassName: "headerMessage--win"
        };

    }

    return {
        message: "LOST",
        messageClassName: "headerMessage--lost"
    };

}

export default function Page5Game({ onNavigate: _onNavigate }) {

    const { gameState } = useGameState();

    const { localConfirmed } = usePreGameReady();

    const { result, hasResult } = useGameResult();

    const { identity } = usePlayerIdentity();

    const authoritative = useAuthoritativeSession();

    const localPlayerId = resolveLocalPlayerId(
        identity.playerId ?? null,
        authoritative.players,
        {
            verifyCompleted: Boolean(authoritative.lifecycle?.verifyCompleted)
        }
    );

    const header = useMemo(
        () => resolvePage5HeaderMessage(
            hasResult ? result : null,
            localPlayerId
        ),
        [hasResult, result, localPlayerId]
    );

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
            message={header.message}
            messageClassName={header.messageClassName}
            backEnabled={false}
            onBack={() => {}}
            nextEnabled={false}
            onNext={() => {}}
        >

            <div className="page5" data-game-state={gameState}>

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
