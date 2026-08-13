import "../styles/playerPaymentRow.css";

import { useLanguage } from "../context/LanguageContext";

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

    const { t } = useLanguage();

    const resolveMaybeKey = (value) => (
        typeof value === "string" && value.includes(".")
            ? t(value)
            : value
    );

    const fallbackStatusLabel = (
        paymentStatus === "paid"
            || paymentStatus === "PAYMENT_CONFIRMED"
            ? t("payment.paid")
            : paymentStatus === "failed"
                || paymentStatus === "PAYMENT_FAILED"
                ? t("payment.failed")
                : paymentStatus === "cancelled"
                    ? t("payment.cancelled")
                    : t("common.waiting")
    );

    const statusLabel = resolveMaybeKey(connectionStatusLabel)
        ?? resolveMaybeKey(paymentStatusLabel)
        ?? fallbackStatusLabel;

    const normalized = connectionStatus
        ?? (
            paymentStatus === "paid"
                || paymentStatus === "confirmed"
                || paymentStatus === "PAYMENT_CONFIRMED"
                ? "CONNECTED"
                : "WAITING"
        );

    const isDone = normalized === "CONNECTED"
        || paymentStatus === "paid"
        || paymentStatus === "confirmed"
        || paymentStatus === "PAYMENT_CONFIRMED";

    const isMismatch = normalized === "ADDRESS_MISMATCH";

    const walletLabel = connectionStatus
        ? (
            normalized === "CONNECTED"
                ? t("payment.walletConnected")
                : normalized === "ADDRESS_MISMATCH"
                    ? t("payment.addressMismatch")
                    : normalized === "CONNECTING"
                        ? t("payment.connecting")
                        : t("payment.walletPending")
        )
        : (
            walletRegistered
                ? t("payment.walletRegistered")
                : t("payment.walletMissing")
        );

    const resolvedTitle = resolveMaybeKey(labelTitle) ?? labelTitle;

    return (

        <div className="playerPaymentRow">

            <div className="playerPaymentRow__group">

                <span className="playerPaymentRow__label">

                    {resolvedTitle}

                </span>

                <span className="playerPaymentRow__value">

                    {nickname}

                </span>

            </div>

            <div className="playerPaymentRow__group playerPaymentRow__group--icon">

                <span className="playerPaymentRow__label">

                    {t("common.icon")}

                </span>

                <span className="playerIconBadge" aria-hidden="true">

                    {icon}

                </span>

            </div>

            <div className="playerPaymentRow__group playerPaymentRow__group--wallet">

                <span className="playerPaymentRow__label">

                    {t("common.wallet")}

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

                    {t("common.status")}

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
