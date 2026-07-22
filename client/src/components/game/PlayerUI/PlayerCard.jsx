import { memo } from "react";

import { getPlayerIconGlyph } from "../../../game/playerUI";

function PlayerCard({ player }) {

    return (

        <div className="playerCard" data-player-id={player.id}>

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

        </div>

    );

}

function arePlayerPropsEqual(previous, next) {

    const prevPlayer = previous.player;

    const nextPlayer = next.player;

    return prevPlayer.id === nextPlayer.id
        && prevPlayer.nickname === nextPlayer.nickname
        && prevPlayer.icon === nextPlayer.icon;

}

export default memo(PlayerCard, arePlayerPropsEqual);
