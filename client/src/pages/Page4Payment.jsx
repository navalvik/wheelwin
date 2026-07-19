import GameLayout from "../layouts/GameLayout";

import PlayerPaymentRow from "../components/PlayerPaymentRow";

import { useAuthoritativeSession } from "../context/AuthoritativeSessionContext";

import {
    mapEntryPaymentRows,
    mapEntrySmartContractLabel,
    shouldShowEntryPaymentWaiting
} from "../game/session";

import "../styles/page4payment.css";

export default function Page4Payment({ onNavigate }) {

    // C5.8C/E — Page4 mirrors AuthoritativeSession.entryPayment.
    // R1.3D — Page5 opens only via authoritative OPEN_PAGE5 (not locally).
    const authoritative = useAuthoritativeSession();

    const entryPayment = authoritative.entryPayment;

    const entryPaymentCompleted = authoritative.lifecycle
        ?.entryPaymentCompleted === true;

    const waiting = shouldShowEntryPaymentWaiting(entryPayment);

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

            backEnabled={!entryPaymentCompleted}

            onBack={() => onNavigate(5)}

            nextEnabled={false}

            onNext={() => {}}

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
