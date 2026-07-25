import { useMemo, useState } from "react";

import {
    useConsoleFocus,
    useConsoleProjection
} from "../ConsoleStreamProvider";
import { formatPage, formatDurationMs, shortId } from "../formatters";
import PanelShell from "./shared/PanelShell";
import Toolbar, { FilterSelect } from "./shared/Toolbar";
import EmptyState from "./shared/EmptyState";
import RoomDetailPanel from "./RoomDetailPanel";

function sortRooms(rooms, sortBy) {

    const copy = [...rooms];

    copy.sort((left, right) => {

        if (sortBy === "players") {

            return (right.playerCount ?? 0) - (left.playerCount ?? 0);

        }

        if (sortBy === "state") {

            return String(left.state).localeCompare(String(right.state));

        }

        if (sortBy === "created") {

            return (right.createdAt ?? 0) - (left.createdAt ?? 0);

        }

        return String(left.roomId).localeCompare(String(right.roomId));

    });

    return copy;

}

export default function RoomsExplorerPanel() {

    const roomsIndex = useConsoleProjection("rooms");
    const roomDetail = useConsoleProjection("room");
    const gameDetail = useConsoleProjection("game");
    const { focus, setFocus } = useConsoleFocus();

    const [search, setSearch] = useState("");
    const [stateFilter, setStateFilter] = useState("all");
    const [sortBy, setSortBy] = useState("created");

    const rooms = roomsIndex?.rooms ?? [];

    const stateOptions = useMemo(() => {

        const states = [...new Set(rooms.map((room) => room.state).filter(Boolean))];

        return [
            { value: "all", label: "All states" },
            ...states.map((state) => ({ value: state, label: state }))
        ];

    }, [rooms]);

    const filtered = useMemo(() => {

        const query = search.trim().toLowerCase();

        const next = rooms.filter((room) => {

            if (stateFilter !== "all" && room.state !== stateFilter) {

                return false;

            }

            if (!query) {

                return true;

            }

            return [
                room.roomId,
                room.state,
                room.setupState,
                room.gameId
            ].some((value) => String(value ?? "").toLowerCase().includes(query));

        });

        return sortRooms(next, sortBy);

    }, [rooms, search, stateFilter, sortBy]);

    const selectedRoomId = focus.roomId;

    if (!roomsIndex) {

        return (

            <PanelShell title="Rooms Explorer">

                <EmptyState title="Waiting for rooms index" />

            </PanelShell>

        );

    }

    if (selectedRoomId) {

        return (

            <div className="devConsole__stack">

                <PanelShell
                    title="Rooms Explorer"
                    subtitle={`Focused ${shortId(selectedRoomId, 16)}`}
                    actions={(
                        <button
                            type="button"
                            className="devConsole__textButton"
                            onClick={() => setFocus({ roomId: null, gameId: null })}
                        >

                            Back to rooms

                        </button>
                    )}
                >

                    <RoomDetailPanel
                        room={roomDetail}
                        game={gameDetail}
                    />

                </PanelShell>

            </div>

        );

    }

    return (

        <PanelShell
            title="Rooms Explorer"
            subtitle={`${filtered.length} of ${rooms.length} rooms`}
        >

            <Toolbar
                search={search}
                onSearchChange={setSearch}
                searchPlaceholder="Search room id, state, game…"
            >

                <FilterSelect
                    label="Filter"
                    value={stateFilter}
                    onChange={setStateFilter}
                    options={stateOptions}
                />

                <FilterSelect
                    label="Sort"
                    value={sortBy}
                    onChange={setSortBy}
                    options={[
                        { value: "created", label: "Newest" },
                        { value: "roomId", label: "Room ID" },
                        { value: "state", label: "State" },
                        { value: "players", label: "Players" }
                    ]}
                />

            </Toolbar>

            {filtered.length === 0 ? (

                <EmptyState
                    title="No rooms match"
                    detail="Adjust search or filters."
                />

            ) : (

                <div className="devConsole__cardGrid">

                    {filtered.map((room) => {

                        const isFocusedDetail = roomDetail?.room?.roomId
                            === room.roomId;

                        return (

                            <button
                                key={room.roomId}
                                type="button"
                                className="devConsole__roomCard"
                                onClick={() => setFocus({
                                    roomId: room.roomId,
                                    gameId: room.gameId ?? null
                                })}
                            >

                                <div className="devConsole__roomCardTop">

                                    <strong>

                                        {shortId(room.roomId, 14)}

                                    </strong>

                                    <span className="devConsole__pill">

                                        {room.state ?? "—"}

                                    </span>

                                </div>

                                <div className="devConsole__roomCardMeta">

                                    <span>

                                        Players {room.playerCount ?? 0}

                                    </span>

                                    <span>

                                        Setup {room.setupState ?? "—"}

                                    </span>

                                    <span>

                                        Game {room.gameId
                                            ? shortId(room.gameId, 10)
                                            : "—"}

                                    </span>

                                    {isFocusedDetail && (

                                        <>

                                            <span>

                                                Page {formatPage(
                                                    roomDetail.currentPage
                                                )}

                                            </span>

                                            <span>

                                                Timer {formatDurationMs(
                                                    roomDetail.timers
                                                        ?.setupRemainingMs
                                                )}

                                            </span>

                                            <span>

                                                Sim {
                                                    gameDetail?.simulation
                                                        ?.status ?? "—"
                                                }

                                            </span>

                                            <span>

                                                Settlement {
                                                    gameDetail
                                                        ?.settlementStatus
                                                    ?? roomDetail.contract
                                                        ?.status
                                                    ?? "—"
                                                }

                                            </span>

                                        </>

                                    )}

                                </div>

                            </button>

                        );

                    })}

                </div>

            )}

        </PanelShell>

    );

}
