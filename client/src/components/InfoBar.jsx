import { useGameSession } from "../context/GameSessionContext";
import { useGameClock } from "../context/GameClockContext";

import { isGameplayPage } from "../game/sessionRecovery/recoveryFlow";

import "../styles/infoBar.css";

export default function InfoBar() {

    const {
        session,
        currentPage,
        phaseTimerLabel,
        formatPhaseTime
    } = useGameSession();

    const { phaseLabel, remainingText } = useGameClock();

    const playersDisplay =
        `${session.connectedCount} / ${session.maxPlayers}`;

    // InfoBar is only a router between two independent time domains. Selection is
    // page-based: gameplay/result pages present the authoritative server
    // GameClock, every preparation page presents the lobby Setup Timer. The
    // choice never depends on timer values (currentPhase, clock.active,
    // remaining time) — those belong solely to their own domains.
    const useGameplayClock = isGameplayPage(currentPage);

    const timerLabel = useGameplayClock ? phaseLabel : phaseTimerLabel;

    const timerValue = useGameplayClock
        ? remainingText
        : formatPhaseTime(session.phaseTimeRemaining);

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

                    {timerLabel}

                </div>

                <div className="infoBarValue">

                    {timerValue}

                </div>

            </div>

        </div>

    );

}
