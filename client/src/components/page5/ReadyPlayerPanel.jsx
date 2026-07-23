import { memo } from "react";

import {
    resolvePlayerColorFromWheel,
    resolvePlayerIconFromWheel
} from "../../components/game/WheelEngine/wheelUtils";

import { listAuthoritativePlayers } from "../../game/session/authoritativePlayerView";

import { useAuthoritativeSession } from "../../context/AuthoritativeSessionContext";
import { useWheelConfig } from "../../context/WheelConfigContext";

function countSectorsForPlayer(sectors, playerId) {

    if (!Array.isArray(sectors) || !playerId) {

        return 0;

    }

    return sectors.filter((sector) => sector.ownerId === playerId).length;

}

function ReadyPlayerCard({ player, sectorCount, iconGlyph, color }) {

    return (

        <div
            className="playerCard playerCard--ready"
            data-player-id={player.playerId}
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

                {iconGlyph ?? "?"}

            </span>

            <span className="playerCard__nickname">

                {player.nickname ?? "—"}

            </span>

            <span className="playerCard__readySectors">

                {sectorCount}

                {" "}

                {sectorCount === 1 ? "sector" : "sectors"}

            </span>

        </div>

    );

}

export default memo(function ReadyPlayerPanel() {

    const authoritative = useAuthoritativeSession();

    const { wheelConfiguration } = useWheelConfig();

    const sectors = wheelConfiguration?.sectors ?? [];

    const players = listAuthoritativePlayers(authoritative.players);

    return (

        <div className="playerPanel playerPanel--ready">

            {players.map((player) => (

                <ReadyPlayerCard
                    key={player.playerId}
                    player={player}
                    sectorCount={countSectorsForPlayer(
                        sectors,
                        player.playerId
                    )}
                    iconGlyph={resolvePlayerIconFromWheel(
                        sectors,
                        player.playerId
                    )}
                    color={
                        resolvePlayerColorFromWheel(
                            sectors,
                            player.playerId
                        ) ?? "#cccccc"
                    }
                />

            ))}

        </div>

    );

});
