import {
    getPaymentStatusLabel,
    PAYMENT_STATUS
} from "../utils/gameSession";

import "../styles/playerPaymentRow.css";

export default function PlayerPaymentRow({

    labelTitle,

    nickname,

    icon,

    paymentStatus

}) {

    const statusLabel = getPaymentStatusLabel(paymentStatus);

    const isConfirmed = paymentStatus === PAYMENT_STATUS.confirmed;

    return (

        <div className="playerPaymentRow">

            <div className="playerPaymentRow__group">

                <span className="playerPaymentRow__label">

                    {labelTitle}

                </span>

                <span className="playerPaymentRow__value">

                    {nickname}

                </span>

            </div>

            <div className="playerPaymentRow__group playerPaymentRow__group--icon">

                <span className="playerPaymentRow__label">

                    ICON

                </span>

                <span className="playerIconBadge" aria-hidden="true">

                    {icon}

                </span>

            </div>

            <div className="playerPaymentRow__group playerPaymentRow__group--status">

                <span
                    className={
                        isConfirmed
                            ? "paymentStatus paymentStatus--done"
                            : "paymentStatus paymentStatus--awaiting"
                    }
                >

                    {statusLabel}

                </span>

            </div>

        </div>

    );

}
