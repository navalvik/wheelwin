import { memo } from "react";

import { getPlayerIconGlyph } from "../../game/playerUI";

import { listAuthoritativePlayers } from "../../game/session/authoritativePlayerView";

import { useAuthoritativeSession } from "../../context/AuthoritativeSessionContext";
import { usePreGameReady } from "../../context/PreGameReadyContext";

function PreGameReadyPlayerCard({ player, confirmed }) {

    const color = player.color && player.color !== "—"
        ? player.color
        : "#cccccc";

    return (

        <div
            className="playerCard playerCard--preGameReady"
            data-player-id={player.playerId}
            data-ready={confirmed ? "true" : "false"}
        >

            <span
                className="playerCard__colorSwatch"
                style={{ backgroundColor: color }}
                aria-hidden="true"
            />

            <span
                className="playerCard__icon"
                data-player={player.playerId}
                aria-hidden="true"
            >

                {getPlayerIconGlyph(player.icon)}

            </span>

            <span className="playerCard__nickname">

                {player.nickname ?? player.playerId}

            </span>

            <span
                className={`playerCard__readiness ${
                    confirmed
                        ? "playerCard__readiness--ready"
                        : "playerCard__readiness--waiting"
                }`}
            >

                {confirmed ? "✓ READY" : "WAITING"}

            </span>

        </div>

    );

}

export default memo(function PreGameReadyPlayerPanel() {

    const authoritative = useAuthoritativeSession();

    const { isPlayerReady } = usePreGameReady();

    const players = listAuthoritativePlayers(authoritative.players);

    return (

        <div className="playerPanel playerPanel--preGameReady">

            {players.map((player) => (

                <PreGameReadyPlayerCard
                    key={player.playerId}
                    player={player}
                    confirmed={isPlayerReady(player.playerId)}
                />

            ))}

        </div>

    );

});
