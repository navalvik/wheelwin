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

    return (

        <div className="playerPanel">

            <PlayerCardContainer playerId={1} engine={engine} />

            <PlayerCardContainer playerId={2} engine={engine} />

            <PlayerCardContainer playerId={3} engine={engine} />

        </div>

    );

});
