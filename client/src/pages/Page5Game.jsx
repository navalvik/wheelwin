import { useState } from "react";

import GameLayout from "../layouts/GameLayout";

import WheelPlaceholder from "../components/page5/WheelPlaceholder";
import PlayerPanel from "../components/page5/PlayerPanel";

import {
    DEFAULT_WHEEL_SECTOR_COUNT,
    getWheelDebugConfig
} from "../components/game/WheelEngine";

import { useRegisterEngineModule } from "../context/EngineBridgeContext";
import { useCentralButton } from "../context/CentralButtonContext";
import { useGameState } from "../context/GameStateContext";
import { useInputAck } from "../context/InputAckContext";
import { GameEngineProviders } from "../providers/GameEngineProviders";

import "../styles/page5game.css";

function Page5GameContent({
    onNavigate,
    wheelConfiguration,
    onWheelConfigurationChange
}) {

    const { gameState } = useGameState();

    const { lastAck } = useInputAck();

    const {
        snapshot: buttonSnapshot,
        press,
        release
    } = useCentralButton();

    useRegisterEngineModule("wheel", () => ({

        setConfiguration: (payload) => {

            if (payload?.sectors) {

                onWheelConfigurationChange({ sectors: payload.sectors });

                return;

            }

            if (payload?.sectorCount) {

                onWheelConfigurationChange(
                    getWheelDebugConfig(payload.sectorCount)
                );

            }

        },

        restoreWheel: (snapshot) => {

            const config = snapshot?.wheelConfiguration;

            if (!config) {

                return;

            }

            if (config.sectors) {

                onWheelConfigurationChange({ sectors: config.sectors });

                return;

            }

            if (config.sectorCount) {

                onWheelConfigurationChange(
                    getWheelDebugConfig(config.sectorCount)
                );

            }

        }

    }));

    return (

        <GameLayout
            message="YOU MUST WIN"
            backEnabled={true}
            onBack={() => onNavigate(6)}
            nextEnabled={false}
            onNext={() => onNavigate(8)}
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

                        <PlayerPanel />

                        <div className="wheelContainer gamePanel__wheelArea">

                            <WheelPlaceholder
                                wheelConfiguration={wheelConfiguration}
                                buttonSnapshot={buttonSnapshot}
                                onButtonPress={press}
                                onButtonRelease={release}
                            />

                        </div>

                    </div>

                </div>

            </div>

        </GameLayout>

    );

}

export default function Page5Game({ onNavigate }) {

    const [wheelConfiguration, setWheelConfiguration] = useState(
        () => getWheelDebugConfig(DEFAULT_WHEEL_SECTOR_COUNT)
    );

    return (

        <GameEngineProviders wheelConfiguration={wheelConfiguration}>

            <Page5GameContent
                onNavigate={onNavigate}
                wheelConfiguration={wheelConfiguration}
                onWheelConfigurationChange={setWheelConfiguration}
            />

        </GameEngineProviders>

    );

}
