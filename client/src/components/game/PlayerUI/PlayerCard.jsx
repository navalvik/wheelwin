import { memo } from "react";

import { getPlayerIconGlyph } from "../../../game/playerUI";

import { PLAYER_UI_STATES } from "../../../game/playerUI/PlayerState";

function PlayerCard({ player }) {

    const isOffline = !player.online
        || player.state === PLAYER_UI_STATES.OFFLINE;

    const statusLabel = isOffline
        ? PLAYER_UI_STATES.OFFLINE
        : player.state;

    const statusClassName = [
        "playerCard__status",
        `playerCard__status--${statusLabel.toLowerCase()}`,
        isOffline ? "playerCard__status--offlineBlink" : ""
    ].filter(Boolean).join(" ");

    return (

        <div className="playerCard" data-player-id={player.id}>

            <span className="playerCard__iconLabel">

                ICON

            </span>

            <span
                className="playerCard__icon"
                data-player={player.id}
                aria-hidden="true"
            >

                {getPlayerIconGlyph(player.icon)}

            </span>

            <span className="playerCard__nickname">

                {player.nickname}

            </span>

            <span className={statusClassName}>

                {statusLabel}

            </span>

        </div>

    );

}

function arePlayerPropsEqual(previous, next) {

    const prevPlayer = previous.player;

    const nextPlayer = next.player;

    return prevPlayer.id === nextPlayer.id
        && prevPlayer.nickname === nextPlayer.nickname
        && prevPlayer.icon === nextPlayer.icon
        && prevPlayer.online === nextPlayer.online
        && prevPlayer.state === nextPlayer.state;

}

export default memo(PlayerCard, arePlayerPropsEqual);
