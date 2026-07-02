import GameLayout from "../layouts/GameLayout";

import PlayerPaymentRow from "../components/PlayerPaymentRow";

import { useGameSession } from "../context/GameSessionContext";

import { getSmartContractStatusLabel } from "../utils/gameSession";

import "../styles/page4payment.css";

export default function Page4Payment({ onNavigate }) {

    const { session, allPaymentsConfirmed } = useGameSession();

    return (

        <GameLayout

            message="PAYMENT"

            backEnabled={true}

            onBack={() => onNavigate(5)}

            nextEnabled={allPaymentsConfirmed}

            onNext={() => onNavigate(7)}

        >

            <div className="page4">

                <div className="paymentPanel">

                    <div className="paymentPlayers">

                        {session.players.map((player) => (

                            <PlayerPaymentRow

                                key={player.id}

                                labelTitle={
                                    player.paymentLabelTitle
                                    || player.labelTitle
                                }

                                nickname={player.nickname}

                                icon={player.icon}

                                paymentStatus={player.paymentStatus}

                            />

                        ))}

                    </div>

                    <div className="smartContractStatus">

                        {getSmartContractStatusLabel(
                            session.smartContractStatus
                        )}

                    </div>

                </div>

            </div>

        </GameLayout>

    );

}
