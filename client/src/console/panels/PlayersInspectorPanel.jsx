import { useMemo, useState } from "react";

import { useConsoleProjection } from "../ConsoleStreamProvider";
import { formatPage, shortId } from "../formatters";
import PanelShell from "./shared/PanelShell";
import Toolbar, { FilterSelect } from "./shared/Toolbar";
import { DataTable } from "./shared/DataTable";
import EmptyState from "./shared/EmptyState";

function resolvePaymentState(player, payments) {

    const session = (payments?.sessions ?? []).find(
        (entry) => entry.roomId === player.roomId
    );

    if (!session) {

        return "—";

    }

    return session.status ?? "—";

}

function resolveRecoveryState(player, recovery) {

    const waiting = (recovery?.waiting ?? []).find(
        (entry) => entry.playerId === player.playerId
            || entry.gameId === player.gameId
    );

    if (waiting) {

        return waiting.status ?? "waiting";

    }

    if (player.connectionState === "RECONNECTING") {

        return "reconnecting";

    }

    if ((recovery?.active ?? []).some(
        (entry) => entry.gameId === player.gameId
    )) {

        return "recovering";

    }

    return "—";

}

export default function PlayersInspectorPanel() {

    const playersIndex = useConsoleProjection("players");
    const payments = useConsoleProjection("payments");
    const recovery = useConsoleProjection("recovery");
    const room = useConsoleProjection("room");

    const [search, setSearch] = useState("");
    const [onlineFilter, setOnlineFilter] = useState("all");

    const players = playersIndex?.players ?? [];

    const filtered = useMemo(() => {

        const query = search.trim().toLowerCase();

        return players.filter((player) => {

            if (onlineFilter === "online" && !player.online) {

                return false;

            }

            if (onlineFilter === "offline" && player.online) {

                return false;

            }

            if (!query) {

                return true;

            }

            return [
                player.nickname,
                player.playerId,
                player.roomId,
                player.gameId
            ].some((value) => String(value ?? "").toLowerCase().includes(query));

        });

    }, [players, search, onlineFilter]);

    const roomPlayerExtras = useMemo(() => {

        const map = new Map();

        for (const player of room?.players ?? []) {

            map.set(player.playerId, player);

        }

        return map;

    }, [room]);

    if (!playersIndex) {

        return (

            <PanelShell title="Player Inspector">

                <EmptyState title="Waiting for players projection" />

            </PanelShell>

        );

    }

    return (

        <PanelShell
            title="Player Inspector"
            subtitle={`${filtered.length} of ${players.length} players`}
        >

            <Toolbar
                search={search}
                onSearchChange={setSearch}
                searchPlaceholder="Search nickname, id, room…"
            >

                <FilterSelect
                    label="Presence"
                    value={onlineFilter}
                    onChange={setOnlineFilter}
                    options={[
                        { value: "all", label: "All" },
                        { value: "online", label: "Online" },
                        { value: "offline", label: "Offline" }
                    ]}
                />

            </Toolbar>

            <DataTable
                empty="No players match."
                columns={[
                    {
                        key: "nickname",
                        label: "Nickname",
                        render: (player) => player.nickname ?? "—"
                    },
                    {
                        key: "playerId",
                        label: "Player ID",
                        render: (player) => shortId(player.playerId, 12)
                    },
                    {
                        key: "roomId",
                        label: "Room",
                        render: (player) => shortId(player.roomId, 10)
                    },
                    {
                        key: "gameId",
                        label: "Game",
                        render: (player) => shortId(player.gameId, 10)
                    },
                    {
                        key: "online",
                        label: "Online",
                        render: (player) => (player.online ? "yes" : "no")
                    },
                    {
                        key: "reconnects",
                        label: "Reconnects",
                        render: (player) => (
                            player.connectionState === "RECONNECTING"
                                ? "in progress"
                                : player.connectionState ?? "—"
                        )
                    },
                    {
                        key: "walletConnected",
                        label: "Wallet",
                        render: (player) => (
                            player.walletConnected ? "connected" : "no"
                        )
                    },
                    {
                        key: "currentPage",
                        label: "Page",
                        render: (player) => formatPage(player.currentPage)
                    },
                    {
                        key: "state",
                        label: "State",
                        render: (player) => (
                            roomPlayerExtras.get(player.playerId)?.playerState
                            ?? player.connectionState
                            ?? "—"
                        )
                    },
                    {
                        key: "color",
                        label: "Color",
                        render: () => "—"
                    },
                    {
                        key: "icon",
                        label: "Icon",
                        render: () => "—"
                    },
                    {
                        key: "payment",
                        label: "Payment",
                        render: (player) => resolvePaymentState(player, payments)
                    },
                    {
                        key: "recovery",
                        label: "Recovery",
                        render: (player) => resolveRecoveryState(
                            player,
                            recovery
                        )
                    }
                ]}
                rows={filtered.map((player) => ({
                    id: player.playerId,
                    data: player
                }))}
            />

            <p className="devConsole__footnote">

                Wallet addresses are never shown. Color/icon require a later
                projection enrichment when available from identity snapshots
                without private fields.

            </p>

        </PanelShell>

    );

}
