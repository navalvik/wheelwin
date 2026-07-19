import { memo, useCallback, useSyncExternalStore } from "react";

import PlayerCard from "./PlayerCard";

function PlayerCardContainer({ playerId, engine }) {

    const subscribe = useCallback(
        (onStoreChange) => engine.subscribePlayerChanges(
            playerId,
            onStoreChange
        ),
        [engine, playerId]
    );

    const getSnapshot = useCallback(
        () => engine.getPlayer(playerId),
        [engine, playerId]
    );

    const player = useSyncExternalStore(
        subscribe,
        getSnapshot,
        getSnapshot
    );

    if (!player) {

        return null;

    }

    return <PlayerCard player={player} />;

}

export default memo(function PlayerPanelView({ engine }) {

    const subscribe = useCallback(
        (onStoreChange) => engine.subscribe(onStoreChange),
        [engine]
    );

    const getSnapshot = useCallback(
        () => engine.getPlayers(),
        [engine]
    );

    const players = useSyncExternalStore(
        subscribe,
        getSnapshot,
        getSnapshot
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
