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

            <WheelConfigProvider>

                <GameStateProvider>

                    <PhysicsProvider>

                        <InputAckProvider>

                            <GameEngineProviderStack>

                                {children}

                            </GameEngineProviderStack>

                        </InputAckProvider>

                    </PhysicsProvider>

                </GameStateProvider>

            </WheelConfigProvider>

        </EngineBridgeProvider>

    );

}
