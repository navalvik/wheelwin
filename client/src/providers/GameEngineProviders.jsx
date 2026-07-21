import { AuthoritativeSessionProvider } from "../context/AuthoritativeSessionContext";
import { CentralButtonProvider } from "../context/CentralButtonContext";
import { EngineBridgeProvider } from "../context/EngineBridgeContext";
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

function GameEngineProviderStack({
    children,
    currentPage,
    onNavigate
}) {

    const { pushFromReady } = useGameState();

    const { wheelConfiguration } = useWheelConfig();

    // RecoveryExperience must mount AFTER AuthoritativeSessionProvider (it calls
    // useAuthoritativeSession) and BEFORE SessionRecoveryProvider (which calls
    // useRecoveryExperience).
    const sessionTree = onNavigate != null
        ? (
            <RecoveryExperienceProvider
                currentPage={currentPage}
                onNavigate={onNavigate}
            >

                <SessionRecoveryProvider>

                    {children}

                </SessionRecoveryProvider>

            </RecoveryExperienceProvider>
        )
        : (
            <SessionRecoveryProvider>

                {children}

            </SessionRecoveryProvider>
        );

    return (

        <CentralButtonProvider onReadyComplete={pushFromReady}>

            <PlayerUIProvider>

                <WinnerResolverProvider wheelConfiguration={wheelConfiguration}>

                    <AudioProvider>

                        <SocketSyncProvider>

                            {sessionTree}

                        </SocketSyncProvider>

                    </AudioProvider>

                </WinnerResolverProvider>

            </PlayerUIProvider>

        </CentralButtonProvider>

    );

}

export function GameEngineProviders({
    children,
    currentPage,
    onNavigate
}) {

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

                                        <GameEngineProviderStack
                                            currentPage={currentPage}
                                            onNavigate={onNavigate}
                                        >

                                            {children}

                                        </GameEngineProviderStack>

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
