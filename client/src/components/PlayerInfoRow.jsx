import "../styles/playerInfoRow.css";

export default function PlayerInfoRow({

    labelTitle,

    nickname,

    icon,

    age,

    sectorLabel,

    sectorValue,

    paymentLabel = "YOU NEED PAY",

    paymentDisplay = null,

    isLocal = false

}) {

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

                    {labelTitle}

                </span>

                <span className="playerInfoRow__value">

                    {nickname}

                </span>

            </div>

            <div className="playerInfoRow__group playerInfoRow__group--icon">

                <span className="playerInfoRow__label">

                    ICON

                </span>

                <span className="playerIconBadge" aria-hidden="true">

                    {icon}

                </span>

            </div>

            <div className="playerInfoRow__group">

                <span className="playerInfoRow__label">

                    AGE

                </span>

                <span className="playerInfoRow__value">

                    {age}

                </span>

            </div>

            <div className="playerInfoRow__group">

                <span className="playerInfoRow__label">

                    {sectorLabel}

                </span>

                <span className="playerInfoRow__value">

                    {sectorValue}

                </span>

            </div>

            {paymentDisplay != null && (

                <div className="playerInfoRow__group playerInfoRow__group--payment">

                    <span className="playerInfoRow__label">

                        {paymentLabel}

                    </span>

                    <span className="playerInfoRow__value">

                        {paymentDisplay}

                    </span>

                </div>

            )}

        </div>

    );

}
