import "../styles/playerPaymentRow.css";

export default function PlayerPaymentRow({

    labelTitle,

    nickname,

    icon,

    connectionStatus,

    connectionStatusLabel,

    // Legacy entry-payment props retained for compatibility.
    walletRegistered = false,

    paymentStatus,

    paymentStatusLabel

}) {

    const statusLabel = connectionStatusLabel
        ?? paymentStatusLabel
        ?? (
            paymentStatus === "paid"
                ? "Paid ✓"
                : paymentStatus === "failed"
                    ? "Failed"
                    : paymentStatus === "cancelled"
                        ? "Cancelled"
                        : "Waiting"
        );

    const normalized = connectionStatus
        ?? (
            paymentStatus === "paid" || paymentStatus === "confirmed"
                ? "CONNECTED"
                : "WAITING"
        );

    const isDone = normalized === "CONNECTED"
        || paymentStatus === "paid"
        || paymentStatus === "confirmed";

    const isMismatch = normalized === "ADDRESS_MISMATCH";

    const walletLabel = connectionStatus
        ? (
            normalized === "CONNECTED"
                ? "Wallet Connected ✓"
                : normalized === "ADDRESS_MISMATCH"
                    ? "Address Mismatch"
                    : normalized === "CONNECTING"
                        ? "Connecting…"
                        : "Wallet Pending"
        )
        : (
            walletRegistered
                ? "Wallet Registered ✓"
                : "Wallet Missing"
        );

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
                        isDone
                            ? "paymentStatus paymentStatus--done"
                            : isMismatch
                                ? "paymentStatus paymentStatus--awaiting"
                                : "paymentStatus paymentStatus--awaiting"
                    }
                >

                    {walletLabel}

                </span>

            </div>

            <div className="playerPaymentRow__group playerPaymentRow__group--status">

                <span className="playerPaymentRow__label">

                    Status

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
