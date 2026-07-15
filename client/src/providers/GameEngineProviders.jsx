import { AuthoritativeSessionProvider } from "../context/AuthoritativeSessionContext";
import { CentralButtonProvider } from "../context/CentralButtonContext";
import { EngineBridgeProvider } from "../context/EngineBridgeContext";
import { GameStateProvider, useGameState } from "../context/GameStateContext";
import { PhysicsProvider } from "../context/PhysicsContext";
import { PlayerUIProvider } from "../context/PlayerUIContext";
import { AudioProvider } from "../context/AudioContext";
import { SessionRecoveryProvider } from "../context/SessionRecoveryContext";
import { SocketSyncProvider } from "../context/SocketSyncContext";
import { InputAckProvider } from "../context/InputAckContext";
import { WinnerResolverProvider } from "../context/WinnerResolverContext";
import { WheelConfigProvider, useWheelConfig } from "../context/WheelConfigContext";
import { GameClockProvider } from "../context/GameClockContext";

function GameEngineProviderStack({
    children
}) {

    const { pushFromReady } = useGameState();

    const { wheelConfiguration } = useWheelConfig();

    return (

        <CentralButtonProvider onReadyComplete={pushFromReady}>

            <PlayerUIProvider>

                <WinnerResolverProvider wheelConfiguration={wheelConfiguration}>

                    <AudioProvider>

                        <SocketSyncProvider>

                            <SessionRecoveryProvider>

                                {children}

                            </SessionRecoveryProvider>

                        </SocketSyncProvider>

                    </AudioProvider>

                </WinnerResolverProvider>

            </PlayerUIProvider>

        </CentralButtonProvider>

    );

}

export function GameEngineProviders({
    children
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

                        <GameStateProvider>

                            <PhysicsProvider>

                                <InputAckProvider>

                                    <GameEngineProviderStack>

                                        {children}

                                    </GameEngineProviderStack>

                                </InputAckProvider>

                            </PhysicsProvider>

                        </GameStateProvider>

                    </GameClockProvider>

                </WheelConfigProvider>

            </AuthoritativeSessionProvider>

        </EngineBridgeProvider>

    );

}
