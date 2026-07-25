import { formatPage, formatDurationMs, shortId } from "../formatters";
import { KeyValueList } from "./shared/DataTable";
import EmptyState from "./shared/EmptyState";

/**
 * R6.0E — Read-only room detail (embedded in Rooms Explorer).
 */
export default function RoomDetailPanel({ room, game = null }) {

    if (!room?.room) {

        return (

            <EmptyState
                title="Loading room detail"
                detail="High-frequency CONSOLE_ROOM projection pending."
            />

        );

    }

    const { room: roomMeta, players, setupSession, paymentSession,
        contract, timers, linkedGame, currentPage, currentState,
        gameStart } = room;

    return (

        <div className="devConsole__detailStack">

            <KeyValueList
                entries={[
                    { label: "Room ID", value: roomMeta.roomId },
                    { label: "State", value: roomMeta.status },
                    { label: "Players", value: roomMeta.playerCount },
                    { label: "Current page", value: formatPage(currentPage) },
                    { label: "Current state", value: currentState ?? "—" },
                    {
                        label: "Setup remaining",
                        value: formatDurationMs(timers?.setupRemainingMs)
                    },
                    {
                        label: "Game clock",
                        value: timers?.gameClock
                            ? `${timers.gameClock.phase ?? "—"} · `
                                + `${formatDurationMs(timers.gameClock.remainingMs)} left`
                            : "—"
                    },
                    {
                        label: "Result session",
                        value: timers?.resultSessionActive ? "Active" : "—"
                    }
                ]}
            />

            <h3 className="devConsole__sectionTitle">

                Players

            </h3>

            <div className="devConsole__miniCards">

                {(players ?? []).map((player) => (

                    <div key={player.playerId} className="devConsole__miniCard">

                        <strong>

                            {player.nickname ?? shortId(player.playerId)}

                        </strong>

                        <span>

                            {player.online ? "Online" : "Offline"}

                        </span>

                        <span>

                            {player.playerState ?? "—"}

                        </span>

                        <span>

                            Wallet {player.walletConnected ? "yes" : "no"}

                        </span>

                    </div>

                ))}

            </div>

            <h3 className="devConsole__sectionTitle">

                Setup Session

            </h3>

            <KeyValueList
                entries={[
                    {
                        label: "Session",
                        value: setupSession?.setupSessionId
                            ? shortId(setupSession.setupSessionId, 12)
                            : "—"
                    },
                    { label: "State", value: setupSession?.state },
                    {
                        label: "Verification",
                        value: setupSession?.verificationState
                    },
                    {
                        label: "Payment prep",
                        value: setupSession?.paymentPrepState
                    },
                    {
                        label: "Room full",
                        value: setupSession?.roomFull ? "yes" : "no"
                    }
                ]}
            />

            <h3 className="devConsole__sectionTitle">

                Linked Game

            </h3>

            <KeyValueList
                entries={[
                    {
                        label: "Game ID",
                        value: linkedGame?.gameId ?? game?.game?.gameId
                    },
                    {
                        label: "Status",
                        value: linkedGame?.status ?? game?.game?.status
                    },
                    {
                        label: "Start phase",
                        value: gameStart?.phase
                    },
                    {
                        label: "Simulation",
                        value: game?.simulation?.status
                    }
                ]}
            />

            <h3 className="devConsole__sectionTitle">

                Payment summary

            </h3>

            <KeyValueList
                entries={[
                    { label: "Status", value: paymentSession?.status },
                    {
                        label: "Participants",
                        value: paymentSession?.participantCount
                    },
                    {
                        label: "Confirmed seats",
                        value: paymentSession?.participants?.filter(
                            (participant) => participant.status
                                === "PAYMENT_CONFIRMED"
                        ).length
                    }
                ]}
            />

            <h3 className="devConsole__sectionTitle">

                Settlement summary

            </h3>

            <KeyValueList
                entries={[
                    { label: "Contract", value: contract?.status },
                    {
                        label: "Settlement",
                        value: game?.settlementStatus
                    }
                ]}
            />

            <h3 className="devConsole__sectionTitle">

                Recovery summary

            </h3>

            <KeyValueList
                entries={[
                    {
                        label: "Result session",
                        value: timers?.resultSessionActive
                            ? "Active linger"
                            : "None"
                    },
                    {
                        label: "Game page",
                        value: formatPage(currentPage)
                    }
                ]}
            />

        </div>

    );

}
