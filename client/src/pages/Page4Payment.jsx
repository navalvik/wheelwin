import GameLayout from "../layouts/GameLayout";

import PlayerPaymentRow from "../components/PlayerPaymentRow";

import { useAuthoritativeSession } from "../context/AuthoritativeSessionContext";

import {
    isEntryPaymentComplete,
    mapEntryPaymentRows,
    mapEntrySmartContractLabel,
    shouldShowEntryPaymentWaiting
} from "../game/session";

import "../styles/page4payment.css";

export default function Page4Payment({ onNavigate }) {

    // C5.8C — Page4 displays AuthoritativeSession.entryPayment only.
    // Settlement AuthoritativeSession.payment / PaymentEngine are unused here.
    const authoritative = useAuthoritativeSession();

    const entryPayment = authoritative.entryPayment;

    const waiting = shouldShowEntryPaymentWaiting(entryPayment);

    const nextEnabled = isEntryPaymentComplete(entryPayment);

    const contractLabel = mapEntrySmartContractLabel(
        entryPayment?.smartContractStatus
    );

    const players = mapEntryPaymentRows(
        entryPayment,
        authoritative.players
    );

    return (

        <GameLayout

            message="PAYMENT"

            backEnabled={true}

            onBack={() => onNavigate(5)}

            nextEnabled={nextEnabled}

            onNext={() => onNavigate(7)}

        >

            <div className="page4">

                <div className="paymentPanel">

                    <div className="paymentPlayers">

                        {waiting ? (

                            <div
                                className="paymentPlayersWaiting"
                                aria-live="polite"
                            >

                                Waiting for payment…

                            </div>

                        ) : (

                            players.map((player) => (

                                <PlayerPaymentRow

                                    key={player.key}

                                    labelTitle={player.labelTitle}

                                    nickname={player.nickname}

                                    icon={player.icon}

                                    walletRegistered={player.walletRegistered}

                                    paymentStatus={player.paymentStatus}

                                    paymentStatusLabel={
                                        player.paymentStatusLabel
                                    }

                                />

                            ))

                        )}

                    </div>

                    <div className="smartContractStatus">

                        {contractLabel}

                    </div>

                </div>

            </div>

        </GameLayout>

    );

}
