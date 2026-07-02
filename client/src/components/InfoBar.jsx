import { useGameSession } from "../context/GameSessionContext";

import "../styles/infoBar.css";

export default function InfoBar() {

    const { session, phaseTimerLabel, formatPhaseTime } = useGameSession();

    const playersDisplay =
        `${session.connectedCount} / ${session.maxPlayers}`;

    return (

        <div className="infoBar">

            <div className="infoBarSection">

                <div className="infoBarTitle">

                    ROOM ID

                </div>

                <div className="infoBarValue">

                    {session.roomId}

                </div>

            </div>

            <div className="infoBarSection">

                <div className="infoBarTitle">

                    PLAYERS

                </div>

                <div className="infoBarValue">

                    {playersDisplay}

                </div>

            </div>

            <div className="infoBarSection">

                <div className="infoBarTitle">

                    {phaseTimerLabel}

                </div>

                <div className="infoBarValue">

                    {formatPhaseTime(session.phaseTimeRemaining)}

                </div>

            </div>

        </div>

    );

}
