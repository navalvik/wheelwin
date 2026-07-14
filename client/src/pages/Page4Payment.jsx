import GameLayout from "../layouts/GameLayout";

import PlayerPaymentRow from "../components/PlayerPaymentRow";

import { useAuthoritativeSession } from "../context/AuthoritativeSessionContext";

import {
    hasAuthoritativePlayers,
    isAuthoritativePaymentComplete,
    listAuthoritativePlayers,
    mapAuthoritativePaymentToContractLabel,
    mapAuthoritativePaymentToRowStatus,
    mapAuthoritativePlayerToInfoRow,
    shouldShowPaymentWaiting
} from "../game/session";

import { PAYMENT_STATUS } from "../utils/gameSession";

import "../styles/page4payment.css";

export default function Page4Payment({ onNavigate }) {

    // C5.5 — payment display comes from AuthoritativeSession.payment only.
    // Players come from AuthoritativeSession.players (C5.3).
    // No GameSession mock statuses and no client auto-confirm.
    const authoritative = useAuthoritativeSession();

    const playersReady = hasAuthoritativePlayers(authoritative.players);

    const payment = authoritative.payment;

    const rowStatus = mapAuthoritativePaymentToRowStatus(payment)
        ?? PAYMENT_STATUS.waiting;

    const waiting = shouldShowPaymentWaiting(playersReady, payment);

    const nextEnabled = isAuthoritativePaymentComplete(payment);

    const contractLabel = mapAuthoritativePaymentToContractLabel(payment);

    const players = listAuthoritativePlayers(authoritative.players)
        .map(mapAuthoritativePlayerToInfoRow);

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

                                    paymentStatus={rowStatus}

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
