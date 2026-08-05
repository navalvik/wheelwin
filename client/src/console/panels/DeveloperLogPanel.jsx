import { useMemo, useState } from "react";

import {
    useConsoleFocus,
    useConsoleProjection
} from "../ConsoleStreamProvider";
import { formatClockTime } from "../formatters";
import PanelShell from "./shared/PanelShell";
import Toolbar, { FilterSelect } from "./shared/Toolbar";
import { DataTable } from "./shared/DataTable";
import EmptyState from "./shared/EmptyState";

const MAX_VISIBLE = 500;

function matchesCategory(entry, category) {

    if (category === "all") {

        return true;

    }

    const haystack = [
        entry.message,
        entry.source,
        entry.level,
        entry.category,
        entry.roomId,
        entry.gameId,
        entry.playerId
    ]
        .map((value) => String(value ?? "").toLowerCase())
        .join(" ");

    if (category === "room") {

        return haystack.includes("room");

    }

    if (category === "game") {

        return haystack.includes("game");

    }

    if (category === "player") {

        return haystack.includes("player");

    }

    if (category === "tonconnect") {

        return haystack.includes("wallet")
            || haystack.includes("tonconnect")
            || haystack.includes("ton connect")
            || haystack.includes("r6.3")
            || haystack.includes("connect");

    }

    if (category === "payment") {

        return haystack.includes("payment")
            || haystack.includes("settlement")
            || haystack.includes("contract");

    }

    if (category === "socket") {

        return haystack.includes("socket")
            || haystack.includes("disconnect")
            || haystack.includes("reconnect");

    }

    if (category === "decision") {

        return haystack.includes("decision trace")
            || haystack.includes("decision_trace")
            || haystack.includes("decision");

    }

    return true;

}

export default function DeveloperLogPanel() {

    const logs = useConsoleProjection("logs") ?? [];
    const roomDetail = useConsoleProjection("room");
    const { focus } = useConsoleFocus();

    const [search, setSearch] = useState("");
    const [severity, setSeverity] = useState("all");
    const [category, setCategory] = useState("all");
    const [scopeRoom, setScopeRoom] = useState(false);

    const focusedRoomId = focus.roomId ?? roomDetail?.room?.roomId ?? null;

    const filtered = useMemo(() => {

        const query = search.trim().toLowerCase();

        return [...logs]
            .reverse()
            .filter((entry) => {

                const level = String(entry.level ?? "info").toLowerCase();

                if (severity !== "all" && level !== severity) {

                    return false;

                }

                if (!matchesCategory(entry, category)) {

                    return false;

                }

                if (scopeRoom && focusedRoomId) {

                    const roomHaystack = [
                        entry.message,
                        entry.source,
                        entry.roomId
                    ]
                        .map((value) => String(value ?? ""))
                        .join(" ");

                    if (!roomHaystack.includes(String(focusedRoomId))) {

                        return false;

                    }

                }

                if (!query) {

                    return true;

                }

                return [
                    entry.message,
                    entry.source,
                    entry.level,
                    entry.roomId,
                    entry.gameId,
                    entry.playerId
                ].some((value) => String(value ?? "").toLowerCase().includes(query));

            })
            .slice(0, MAX_VISIBLE);

    }, [logs, search, severity, category, scopeRoom, focusedRoomId]);

    return (

        <PanelShell
            title="Developer Log"
            subtitle={`Showing ${filtered.length} · buffer ${logs.length}/${MAX_VISIBLE}`}
        >

            <Toolbar
                search={search}
                onSearchChange={setSearch}
                searchPlaceholder="Search message, source, room, game, player…"
            >

                <FilterSelect
                    label="Severity"
                    value={severity}
                    onChange={setSeverity}
                    options={[
                        { value: "all", label: "All" },
                        { value: "info", label: "Info" },
                        { value: "warn", label: "Warn" },
                        { value: "error", label: "Error" }
                    ]}
                />

                <FilterSelect
                    label="Category"
                    value={category}
                    onChange={setCategory}
                    options={[
                        { value: "all", label: "All" },
                        { value: "decision", label: "Decision" },
                        { value: "room", label: "Room" },
                        { value: "game", label: "Game" },
                        { value: "player", label: "Player" },
                        { value: "tonconnect", label: "TonConnect" },
                        { value: "payment", label: "Payment" },
                        { value: "socket", label: "Socket" }
                    ]}
                />

            </Toolbar>

            <label className="devConsole__filterToggle">

                <input
                    type="checkbox"
                    checked={scopeRoom}
                    disabled={!focusedRoomId}
                    onChange={(event) => setScopeRoom(event.target.checked)}
                />

                <span>

                    Limit to focused room
                    {focusedRoomId
                        ? ` (${String(focusedRoomId).slice(0, 12)}…)`
                        : " (select a room first)"}

                </span>

            </label>

            {filtered.length === 0 ? (

                <EmptyState title="No log entries" />

            ) : (

                <DataTable
                    columns={[
                        {
                            key: "at",
                            label: "Time",
                            render: (entry) => formatClockTime(entry.at)
                        },
                        {
                            key: "level",
                            label: "Severity",
                            render: (entry) => (
                                <span
                                    className={
                                        `devConsole__logLevel devConsole__logLevel--${
                                            String(entry.level ?? "info").toLowerCase()
                                        }`
                                    }
                                >

                                    {String(entry.level ?? "info").toUpperCase()}

                                </span>
                            )
                        },
                        {
                            key: "source",
                            label: "Source",
                            render: (entry) => entry.source ?? "console"
                        },
                        {
                            key: "message",
                            label: "Message",
                            render: (entry) => entry.message ?? "—"
                        }
                    ]}
                    rows={filtered.map((entry, index) => ({
                        id: `${entry.at}-${index}`,
                        data: {
                            ...entry,
                            source: entry.source ?? "DeveloperConsoleGateway"
                        }
                    }))}
                />

            )}

        </PanelShell>

    );

}
