import { AuthoritativeSessionProvider } from "../context/AuthoritativeSessionContext";
import { CentralButtonProvider } from "../context/CentralButtonContext";
import { EngineBridgeProvider } from "../context/EngineBridgeContext";
import { GameResultProvider } from "../context/GameResultContext";
import { GameSessionProvider } from "../context/GameSessionContext";
import { GameStateProvider, useGameState } from "../context/GameStateContext";
import { PhysicsProvider } from "../context/PhysicsContext";
import { PlayerUIProvider } from "../context/PlayerUIContext";
import { AudioProvider } from "../context/AudioContext";
import { RecoveryExperienceProvider } from "../context/RecoveryExperienceContext";
import { SessionRecoveryProvider } from "../context/SessionRecoveryContext";
import { SocketSyncProvider } from "../context/SocketSyncContext";
import { InputAckProvider } from "../context/InputAckContext";
import { WinnerResolverProvider } from "../context/WinnerResolverContext";
import { WheelConfigProvider, useWheelConfig } from "../context/WheelConfigContext";
import { GameClockProvider } from "../context/GameClockContext";
import { PreGameReadyProvider } from "../context/PreGameReadyContext";
import { DEV_MODE } from "../config/devMode";
import { APP_PAGES } from "../game/sessionRecovery/recoveryFlow";

/**
 * Non-gameplay sentinel for Debug / Admin / Test mounts.
 * WELCOME is not a pre-game or gameplay recovery page, so RecoveryExperience
 * will not drive Page5/Page6 navigation from this default alone.
 */
const DEFAULT_CURRENT_PAGE = APP_PAGES.WELCOME;

/**
 * No-op navigation for non-gameplay mounts (e.g. /debug).
 * RecoveryExperience may call this; it must never throw.
 */
function noopNavigate() {}

function isGameFlowPage(page) {

    return page === APP_PAGES.LOBBY
        || page === APP_PAGES.PLAYER_SETUP
        || page === APP_PAGES.MATRIX
        || page === APP_PAGES.VERIFY
        || page === APP_PAGES.PAYMENT
        || page === APP_PAGES.GAMEPLAY
        || page === APP_PAGES.RESULT;

}

/**
 * Resolve gameplay-only props with safe defaults for non-gameplay routes.
 * Warn in development when a GameFlow-looking mount is missing a required prop.
 */
function resolveGameplayProps({ currentPage, onNavigate }) {

    const missingOnNavigate = onNavigate == null;
    const missingCurrentPage = currentPage == null;

    const resolvedOnNavigate = missingOnNavigate ? noopNavigate : onNavigate;
    const resolvedCurrentPage = missingCurrentPage
        ? DEFAULT_CURRENT_PAGE
        : currentPage;

    if (DEV_MODE) {

        // Intentional non-gameplay mount (both omitted) — silent defaults.
        // Warn only when the mount looks like gameplay but a prop is missing.
        if (missingOnNavigate && !missingCurrentPage && isGameFlowPage(currentPage)) {

            console.warn(
                "[GameEngineProviders] Missing required gameplay prop: onNavigate"
            );

        }

        if (missingCurrentPage && !missingOnNavigate) {

            console.warn(
                "[GameEngineProviders] Missing required gameplay prop: currentPage"
            );

        }

    }

    return {
        currentPage: resolvedCurrentPage,
        onNavigate: resolvedOnNavigate
    };

}

function GameEngineProviderStack({
    children,
    currentPage,
    onNavigate
}) {

    const { pushFromReady } = useGameState();

    const { wheelConfiguration } = useWheelConfig();

    // RecoveryExperience must mount AFTER AuthoritativeSessionProvider (it calls
    // useAuthoritativeSession) and BEFORE SessionRecoveryProvider (which calls
    // useRecoveryExperience). Always keep this nesting — never mount
    // SessionRecovery alone. Independent of routing.
    return (

        <CentralButtonProvider onReadyComplete={pushFromReady}>

            <PlayerUIProvider>

                <WinnerResolverProvider wheelConfiguration={wheelConfiguration}>

                    <AudioProvider>

                        <SocketSyncProvider>

                            <RecoveryExperienceProvider
                                currentPage={currentPage}
                                onNavigate={onNavigate}
                            >

                                <SessionRecoveryProvider>

                                    {children}

                                </SessionRecoveryProvider>

                            </RecoveryExperienceProvider>

                        </SocketSyncProvider>

                    </AudioProvider>

                </WinnerResolverProvider>

            </PlayerUIProvider>

        </CentralButtonProvider>

    );

}

/**
 * Single reusable provider stack for gameplay and developer pages.
 *
 * Gameplay-only props (safe defaults for /debug and future Admin/Test):
 * - onNavigate  → noopNavigate  (no page machine outside GameFlow)
 * - currentPage → APP_PAGES.WELCOME (non-gameplay recovery sentinel)
 *
 * gameId / roomId are not provider props; they live on AuthoritativeSession
 * and are filled by the server over the socket.
 */
export function GameEngineProviders({
    children,
    currentPage,
    onNavigate
}) {

    const resolved = resolveGameplayProps({ currentPage, onNavigate });

    return (

        <EngineBridgeProvider>

            {/*
                C5.2 — Authoritative session mirror. Observes EngineBridge
                events only. GameSessionContext retains unmigrated finance fields.
            */}
            <AuthoritativeSessionProvider>

                <WheelConfigProvider>

                    <GameClockProvider>

                        <PreGameReadyProvider>

                            <GameStateProvider>

                                <PhysicsProvider>

                                    <InputAckProvider>

                                        {/*
                                            GameSession / GameResult sit here so
                                            RecoveryExperience (and /debug) always
                                            have them — one stack, no route forks.
                                        */}
                                        <GameSessionProvider
                                            currentPage={resolved.currentPage}
                                            onNavigate={resolved.onNavigate}
                                        >

                                            <GameResultProvider
                                                currentPage={resolved.currentPage}
                                                onNavigate={resolved.onNavigate}
                                            >

                                                <GameEngineProviderStack
                                                    currentPage={resolved.currentPage}
                                                    onNavigate={resolved.onNavigate}
                                                >

                                                    {children}

                                                </GameEngineProviderStack>

                                            </GameResultProvider>

                                        </GameSessionProvider>

                                    </InputAckProvider>

                                </PhysicsProvider>

                            </GameStateProvider>

                        </PreGameReadyProvider>

                    </GameClockProvider>

                </WheelConfigProvider>

            </AuthoritativeSessionProvider>

        </EngineBridgeProvider>

    );

}
