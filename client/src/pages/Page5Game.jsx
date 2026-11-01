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
import { useGameClock } from "../context/GameClockContext";
import { usePhysics } from "../context/PhysicsContext";
import { noteLocalMainThreadStall } from "../game/diagnostics/page5LocalReport.js";
import {
    configurePage5Diagnostics,
    recordPage5Diagnostic,
    flushPage5Diagnostics
} from "../game/diagnostics/page5Telemetry.js";
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

    const { clock } = useGameClock();

    const { getFrame } = usePhysics();

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

    const diagnosticGameId = identity.gameId ?? authoritative.gameId ?? null;

    useEffect(() => {

        if (!configurePage5Diagnostics({
            roomId: identity.roomId ?? authoritative.roomId,
            gameId: diagnosticGameId,
            playerId: localPlayerId,
            nickname: identity.nickname
        })) return undefined;

        recordPage5Diagnostic({ kind: "page5_mount" });
        flushPage5Diagnostics();

        return () => {
            recordPage5Diagnostic({ kind: "page5_unmount" });
            flushPage5Diagnostics();
        };

    // Instrument the active identity, not subsequent gameplay state changes.
    }, [identity.roomId, authoritative.roomId, diagnosticGameId, localPlayerId]);

    // Visibility and runtime errors help distinguish an old WebView pause
    // from server/transport lag. Never record raw exception messages.
    useEffect(() => {
        if (typeof window === "undefined" || typeof document === "undefined") {
            return undefined;
        }

        const visibility = () => {
            recordPage5Diagnostic({
                kind: "visibility_changed",
                reason: document.visibilityState
            });
            flushPage5Diagnostics();
        };
        const onError = (event) => {
            const allowedErrors = new Set([
                "TypeError", "ReferenceError", "RangeError",
                "SyntaxError", "Error"
            ]);
            const name = event?.error?.name;
            recordPage5Diagnostic({
                kind: "client_error",
                reason: "window_error",
                errorName: allowedErrors.has(name) ? name : "Unknown"
            });
            flushPage5Diagnostics();
        };
        const onUnhandled = () => {
            recordPage5Diagnostic({ kind: "client_error", reason: "unhandled_rejection" });
            flushPage5Diagnostics();
        };
        document.addEventListener("visibilitychange", visibility);
        window.addEventListener("error", onError);
        window.addEventListener("unhandledrejection", onUnhandled);
        return () => {
            document.removeEventListener("visibilitychange", visibility);
            window.removeEventListener("error", onError);
            window.removeEventListener("unhandledrejection", onUnhandled);
        };
    }, []);

    const latestDiagnosticRef = useRef(null);
    useEffect(() => {
        latestDiagnosticRef.current = { gameState, clock, localConfirmed };
    }, [gameState, clock, localConfirmed]);

    useEffect(() => {

        let lastTickMono = typeof performance !== "undefined"
            ? performance.now() : null;
        const timer = setInterval(() => {
            const tickMono = typeof performance !== "undefined"
                ? performance.now() : null;
            if (lastTickMono !== null && tickMono !== null) {
                noteLocalMainThreadStall(Math.max(0, tickMono - lastTickMono - 1000));
            }
            lastTickMono = tickMono;
            const current = latestDiagnosticRef.current;
            if (!current) return;
            const frame = getFrame();
            recordPage5Diagnostic({
                kind: "sample",
                displayedPhase: current.gameState,
                phase: current.clock?.phase ?? null,
                clockValue: current.clock?.remainingSeconds ?? null,
                wheelAngle: frame?.wheelAngle ?? null,
                pointerAngle: frame?.triangleAngle ?? null,
                renderMs: typeof performance !== "undefined"
                    ? Math.round(performance.now()) : null
            });
            flushPage5Diagnostics();
        }, 1000);

        return () => clearInterval(timer);

    }, [getFrame]);

    useEffect(() => {

        recordPage5Diagnostic({
            kind: "phase_changed",
            displayedPhase: gameState,
            phase: clock.phase,
            renderMs: typeof performance !== "undefined"
                ? Math.round(performance.now()) : null
        });
        flushPage5Diagnostics();

    }, [gameState, clock.phase]);


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
        recordPage5Diagnostic({
            kind: "button_state",
            displayedPhase: gameState,
            buttonState: buttonSnapshot.state,
            buttonEnabled: buttonSnapshot.presentation?.enabled === true
                && (isPreGameReadyPhase || !buttonInputDisabled),
            buttonLocked: buttonSnapshot.locked === true,
            readyConfirmed: localConfirmed,
            reason: buttonInputDisabled && !isPreGameReadyPhase
                ? "page_gate" : "presentation_gate"
        });
    }, [
        gameState, buttonSnapshot.state, buttonSnapshot.enabled,
        buttonSnapshot.locked, buttonSnapshot.presentation?.enabled,
        buttonInputDisabled, isPreGameReadyPhase, localConfirmed
    ]);

    useEffect(() => {
        if (localConfirmed) {
            const current = latestDiagnosticRef.current;
            recordPage5Diagnostic({
                kind: "ready_ack",
                displayedPhase: current?.gameState ?? null,
                readyConfirmed: true
            });
            flushPage5Diagnostics();
        }
    }, [localConfirmed]);

    const onReadyTap = () => {
        recordPage5Diagnostic({
            kind: "ready_attempt",
            displayedPhase: gameState,
            buttonState: buttonSnapshot.state,
            buttonEnabled: buttonSnapshot.presentation?.enabled === true,
            buttonLocked: buttonSnapshot.locked,
            readyConfirmed: localConfirmed
        });
        const emitted = confirmPreGameReady();
        recordPage5Diagnostic({
            kind: emitted ? "ready_sent" : "ready_rejected",
            displayedPhase: gameState,
            buttonState: buttonSnapshot.state,
            reason: emitted ? "local_event_emitted" : "engine_gate_rejected"
        });
        flushPage5Diagnostics();
        return emitted;
    };

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
                                            ? onReadyTap
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
