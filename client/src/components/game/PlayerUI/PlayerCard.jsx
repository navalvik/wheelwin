import { memo } from "react";

import { getPlayerIconGlyph } from "../../../game/playerUI";

import { PLAYER_UI_STATES } from "../../../game/playerUI/PlayerState";

function PlayerCard({ player }) {

    const isOffline = !player.online
        || player.state === PLAYER_UI_STATES.OFFLINE;

    const statusLabel = isOffline
        ? PLAYER_UI_STATES.OFFLINE
        : player.buttonLocked
            ? "LOCKED"
            : player.state;

    const statusClassName = [
        "playerCard__status",
        `playerCard__status--${String(statusLabel).toLowerCase()}`,
        isOffline ? "playerCard__status--offlineBlink" : "",
        player.buttonLocked ? "playerCard__status--locked" : ""
    ].filter(Boolean).join(" ");

    const remainingPresses = Number.isFinite(player.remainingPresses)
        ? player.remainingPresses
        : null;

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

            {remainingPresses !== null && (

                <span className="playerCard__cycles">

                    {remainingPresses}

                    {" "}

                    left

                </span>

            )}

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
        && prevPlayer.state === nextPlayer.state
        && prevPlayer.remainingPresses === nextPlayer.remainingPresses
        && prevPlayer.buttonLocked === nextPlayer.buttonLocked
        && prevPlayer.completedCycles === nextPlayer.completedCycles;

}

export default memo(PlayerCard, arePlayerPropsEqual);
