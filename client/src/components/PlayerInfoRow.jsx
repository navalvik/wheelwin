import "../styles/playerInfoRow.css";

export default function PlayerInfoRow({

    labelTitle,

    nickname,

    icon,

    age,

    sectorLabel,

    sectorValue

}) {

    return (

        <div className="playerInfoRow">

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

        </div>

    );

}
