import "../styles/playerPaymentRow.css";

export default function PlayerPaymentRow({

    labelTitle,

    nickname,

    icon,

    walletRegistered = false,

    paymentStatus,

    paymentStatusLabel

}) {

    const statusLabel = paymentStatusLabel
        ?? (
            paymentStatus === "paid"
                ? "Paid"
                : paymentStatus === "failed"
                    ? "Failed"
                    : paymentStatus === "cancelled"
                        ? "Cancelled"
                        : "Waiting"
        );

    const isDone = paymentStatus === "paid" || paymentStatus === "confirmed";

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

            <div className="playerPaymentRow__group playerPaymentRow__group--wallet">

                <span className="playerPaymentRow__label">

                    Wallet

                </span>

                <span
                    className={
                        walletRegistered
                            ? "paymentStatus paymentStatus--done"
                            : "paymentStatus paymentStatus--awaiting"
                    }
                >

                    {walletRegistered
                        ? "Wallet Registered ✓"
                        : "Wallet Missing"}

                </span>

            </div>

            <div className="playerPaymentRow__group playerPaymentRow__group--status">

                <span className="playerPaymentRow__label">

                    Payment

                </span>

                <span
                    className={
                        isDone
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
