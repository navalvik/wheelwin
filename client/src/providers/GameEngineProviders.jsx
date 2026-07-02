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

function GameEngineProviderStack({
    children,
    wheelConfiguration
}) {

    const { pushFromReady } = useGameState();

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
    children,
    wheelConfiguration
}) {

    return (

        <EngineBridgeProvider>

            <GameStateProvider>

                <PhysicsProvider>

                    <InputAckProvider>

                        <GameEngineProviderStack
                            wheelConfiguration={wheelConfiguration}
                        >

                            {children}

                        </GameEngineProviderStack>

                    </InputAckProvider>

                </PhysicsProvider>

            </GameStateProvider>

        </EngineBridgeProvider>

    );

}
