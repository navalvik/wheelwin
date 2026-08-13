import "../styles/playerInfoRow.css";

import { useLanguage } from "../context/LanguageContext";

export default function PlayerInfoRow({

    labelTitle,

    labelOrdinal = null,

    nickname,

    icon,

    age,

    sectorLabel,

    sectorValue,

    paymentLabel = "verify.youNeedPay",

    paymentDisplay = null,

    isLocal = false

}) {

    const { t } = useLanguage();

    const resolvedTitle = labelTitle?.includes(".")
        ? t(labelTitle, labelOrdinal != null ? { n: labelOrdinal } : null)
        : labelTitle;

    const resolvedSectorLabel = sectorLabel === "SECTOR"
        || sectorLabel?.startsWith?.("player.")
        || sectorLabel?.startsWith?.("setup.")
        ? t(sectorLabel === "SECTOR" ? "player.sector" : sectorLabel)
        : sectorLabel;

    const resolvedPaymentLabel = paymentLabel?.includes(".")
        ? t(paymentLabel)
        : paymentLabel;

    return (

        <div
            className={
                isLocal
                    ? "playerInfoRow playerInfoRow--local"
                    : "playerInfoRow"
            }
            data-local-player={isLocal ? "true" : "false"}
        >

            <div className="playerInfoRow__group">

                <span className="playerInfoRow__label">

                    {resolvedTitle}

                </span>

                <span className="playerInfoRow__value">

                    {nickname}

                </span>

            </div>

            <div className="playerInfoRow__group playerInfoRow__group--icon">

                <span className="playerInfoRow__label">

                    {t("common.icon")}

                </span>

                <span className="playerIconBadge" aria-hidden="true">

                    {icon}

                </span>

            </div>

            <div className="playerInfoRow__group">

                <span className="playerInfoRow__label">

                    {t("player.age")}

                </span>

                <span className="playerInfoRow__value">

                    {age}

                </span>

            </div>

            <div className="playerInfoRow__group">

                <span className="playerInfoRow__label">

                    {resolvedSectorLabel}

                </span>

                <span className="playerInfoRow__value">

                    {sectorValue}

                </span>

            </div>

            {paymentDisplay != null && (

                <div className="playerInfoRow__group playerInfoRow__group--payment">

                    <span className="playerInfoRow__label">

                        {resolvedPaymentLabel}

                    </span>

                    <span className="playerInfoRow__value">

                        {paymentDisplay}

                    </span>

                </div>

            )}

        </div>

    );

}
