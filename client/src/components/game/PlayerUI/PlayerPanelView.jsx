import { memo, useSyncExternalStore } from "react";

import PlayerCard from "./PlayerCard";

function PlayerCardContainer({ playerId, engine }) {

    const player = useSyncExternalStore(
        (onStoreChange) => engine.subscribePlayerChanges(
            playerId,
            onStoreChange
        ),
        () => engine.getPlayer(playerId),
        () => engine.getPlayer(playerId)
    );

    if (!player) {

        return null;

    }

    return <PlayerCard player={player} />;

}

export default memo(function PlayerPanelView({ engine }) {

    const players = useSyncExternalStore(
        (onStoreChange) => engine.subscribe(onStoreChange),
        () => engine.getPlayers(),
        () => engine.getPlayers()
    );

    return (

        <div className="playerPanel">

            {players.map((player) => (

                <PlayerCardContainer
                    key={player.id}
                    playerId={player.id}
                    engine={engine}
                />

            ))}

        </div>

    );

});
