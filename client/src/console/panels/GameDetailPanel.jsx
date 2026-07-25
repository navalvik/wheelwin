import { useMemo, useState } from "react";

import {
    useConsoleFocus,
    useConsoleProjection
} from "../ConsoleStreamProvider";
import { formatPage, shortId } from "../formatters";
import PanelShell from "./shared/PanelShell";
import Toolbar from "./shared/Toolbar";
import { KeyValueList } from "./shared/DataTable";
import EmptyState from "./shared/EmptyState";

export default function GameDetailPanel() {

    const roomsIndex = useConsoleProjection("rooms");
    const game = useConsoleProjection("game");
    const room = useConsoleProjection("room");
    const { focus, setFocus } = useConsoleFocus();
    const [search, setSearch] = useState("");

    const games = useMemo(() => {

        const list = (roomsIndex?.rooms ?? [])
            .filter((entry) => entry.gameId)
            .map((entry) => ({
                gameId: entry.gameId,
                roomId: entry.roomId,
                roomState: entry.state,
                setupState: entry.setupState
            }));

        const query = search.trim().toLowerCase();

        if (!query) {

            return list;

        }

        return list.filter((entry) => [
            entry.gameId,
            entry.roomId,
            entry.roomState
        ].some((value) => String(value ?? "").toLowerCase().includes(query)));

    }, [roomsIndex, search]);

    const selected = focus.gameId;

    return (

        <PanelShell
            title="Game Detail"
            subtitle={
                selected
                    ? `Focused ${shortId(selected, 16)}`
                    : `${games.length} active games`
            }
            actions={selected ? (
                <button
                    type="button"
                    className="devConsole__textButton"
                    onClick={() => setFocus({
                        roomId: null,
                        gameId: null
                    })}
                >

                    Clear focus

                </button>
            ) : null}
        >

            <Toolbar
                search={search}
                onSearchChange={setSearch}
                searchPlaceholder="Search game or room id…"
            />

            <div className="devConsole__split">

                <div className="devConsole__splitList">

                    {games.length === 0 ? (

                        <EmptyState title="No active games" />

                    ) : (

                        games.map((entry) => (

                            <button
                                key={entry.gameId}
                                type="button"
                                className={
                                    entry.gameId === selected
                                        ? "devConsole__listItem devConsole__listItem--active"
                                        : "devConsole__listItem"
                                }
                                onClick={() => setFocus({
                                    roomId: entry.roomId,
                                    gameId: entry.gameId
                                })}
                            >

                                <strong>

                                    {shortId(entry.gameId, 12)}

                                </strong>

                                <span>

                                    Room {shortId(entry.roomId, 10)}

                                </span>

                            </button>

                        ))

                    )}

                </div>

                <div className="devConsole__splitDetail">

                    {!selected || !game?.game ? (

                        <EmptyState
                            title="Select a game"
                            detail="High-frequency CONSOLE_GAME updates apply to the focused game only."
                        />

                    ) : (

                        <KeyValueList
                            entries={[
                                {
                                    label: "Game ID",
                                    value: game.game.gameId
                                },
                                {
                                    label: "Room",
                                    value: game.game.roomId
                                },
                                {
                                    label: "Status",
                                    value: game.game.status
                                },
                                {
                                    label: "Game state",
                                    value: game.currentGameState
                                },
                                {
                                    label: "Current page",
                                    value: formatPage(game.currentPage)
                                },
                                {
                                    label: "Winner",
                                    value: game.winner?.winnerPlayerId
                                        ?? "—"
                                },
                                {
                                    label: "Winning sector",
                                    value: game.winner?.winningSector
                                },
                                {
                                    label: "Simulation",
                                    value: game.simulation?.status
                                },
                                {
                                    label: "In loop",
                                    value: game.simulation?.activeInLoop
                                        ? "yes"
                                        : "no"
                                },
                                {
                                    label: "Clock / phase",
                                    value: room?.timers?.gameClock?.phase
                                        ?? "—"
                                },
                                {
                                    label: "Clock remaining",
                                    value: room?.timers?.gameClock?.remainingMs
                                        != null
                                        ? `${room.timers.gameClock.remainingMs} ms`
                                        : "—"
                                },
                                {
                                    label: "Physics",
                                    value: [
                                        game.simulation?.selfTestActive
                                            && "SELF_TEST",
                                        game.simulation?.speedActive
                                            && "SPEED",
                                        game.simulation?.brakeActive
                                            && "BRAKE"
                                    ].filter(Boolean).join(" · ") || "idle"
                                },
                                {
                                    label: "Payment",
                                    value: game.paymentSessionStatus
                                },
                                {
                                    label: "Settlement",
                                    value: game.settlementStatus
                                }
                            ]}
                        />

                    )}

                </div>

            </div>

        </PanelShell>

    );

}
