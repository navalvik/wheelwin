import { useEffect, useMemo, useRef, useState } from "react";

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
import { useLanguage } from "../context/LanguageContext";
import { usePlayerIdentity } from "../context/PlayerIdentityContext";
import { useWheelConfig } from "../context/WheelConfigContext";
import { usePreGameReady } from "../context/PreGameReadyContext";
import { useRecoveryExperience } from "../context/RecoveryExperienceContext";
import { resolveLocalPlayerId } from "../game/session";
import {
    PAGE5_CONFIG_HYDRATION_GRACE_MS,
    logTerminalNav
} from "../game/session/gameplayTerminal";
import {
    APP_PAGES,
    hasGameplayIdentity
} from "../game/sessionRecovery/recoveryFlow";
import {
    isLocalPlayerWinner,
    resolveAuthoritativeWinnerPlayerId,
    resolvePersonalizedResultPresentation
} from "../game/result/personalizedResultPresentation";

import "../styles/page5game.css";

function resolvePage5HeaderMessage(result, localPlayerId, t) {

    if (!result) {

        return {
            message: t("game.youMustWin"),
            messageClassName: ""
        };

    }

    const winnerPlayerId = resolveAuthoritativeWinnerPlayerId({ result });

    const presentation = resolvePersonalizedResultPresentation(
        isLocalPlayerWinner(localPlayerId, winnerPlayerId)
    );

    if (presentation.variant === "win") {

        return {
            message: t("game.youWin"),
            messageClassName: "headerMessage--win"
        };

    }

    if (presentation.variant === "lost") {

        return {
            message: t("game.youLost"),
            messageClassName: "headerMessage--lost"
        };

    }

    return {
        message: t("game.youMustWin"),
        messageClassName: ""
    };

}

export default function Page5Game({ onNavigate: _onNavigate }) {

    const { gameState } = useGameState();

    const { localConfirmed } = usePreGameReady();

    const { result, hasResult } = useGameResult();

    const { t } = useLanguage();

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
            localPlayerId,
            t
        ),
        [hasResult, result, localPlayerId, t]
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

    const { requestSessionRecovery } = useRecoveryExperience();

    const hydrationRecoveryRequestedRef = useRef(false);

    const [hydrationGraceExpired, setHydrationGraceExpired] = useState(false);

    const hasIdentity = hasGameplayIdentity({
        roomId: identity.roomId ?? authoritative.roomId,
        playerId: identity.playerId
    });

    useEffect(() => {

        hydrationRecoveryRequestedRef.current = false;

        setHydrationGraceExpired(false);

        if (wheelConfiguration !== null || !hasIdentity) {

            return undefined;

        }

        const graceTimer = setTimeout(() => {

            setHydrationGraceExpired(true);

        }, PAGE5_CONFIG_HYDRATION_GRACE_MS);

        return () => {

            clearTimeout(graceTimer);

        };

    }, [wheelConfiguration, hasIdentity]);

    useEffect(() => {

        if (!hydrationGraceExpired || wheelConfiguration !== null || !hasIdentity) {

            return;

        }

        if (hydrationRecoveryRequestedRef.current) {

            return;

        }

        hydrationRecoveryRequestedRef.current = true;

        logTerminalNav({
            event: "hydration_recovery",
            currentPage: APP_PAGES.GAMEPLAY
        });

        requestSessionRecovery();

    }, [
        hydrationGraceExpired,
        wheelConfiguration,
        hasIdentity,
        requestSessionRecovery
    ]);

    const suppressStaleGameplayUi = hydrationGraceExpired
        && wheelConfiguration === null
        && hasIdentity;

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

                        {!suppressStaleGameplayUi && <Page5PlayerPanel />}

                        <div className="wheelContainer gamePanel__wheelArea">

                            {!suppressStaleGameplayUi && (
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
                            )}

                            {!suppressStaleGameplayUi && isResultPhase && (
                                <Page5ResultOverlay />
                            )}

                        </div>

                    </div>

                </div>

            </div>

        </GameLayout>

    );

}
