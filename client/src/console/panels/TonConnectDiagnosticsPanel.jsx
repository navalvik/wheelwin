import { useMemo, useState } from "react";

import {
    useConsoleFocus,
    useConsoleProjection
} from "../ConsoleStreamProvider";
import { shortId } from "../formatters";
import {
    downloadTonConnectDiagnostics,
    formatDiagnosticTime,
    shortenWallet
} from "../tonConnectDiagnosticExport";
import PanelShell from "./shared/PanelShell";
import Toolbar, { FilterSelect } from "./shared/Toolbar";
import EmptyState from "./shared/EmptyState";
import { KeyValueList } from "./shared/DataTable";

const HANDSHAKE_STAGES = Object.freeze([
    "CONNECT_BUTTON",
    "OPEN_MODAL",
    "WAITING_FOR_CONNECTEVENT",
    "SDK_CONNECTED",
    "REPORT_SENT",
    "SERVER_RECEIVED",
    "CONNECTED",
    "PAYMENT_READY"
]);

function mapServerStageToUi(stage) {

    switch (stage) {
        case "WAITING_FOR_CONNECTEVENT":
            return "WAITING_FOR_CONNECTEVENT";
        case "PAYMENT_READY":
            return "PAYMENT_READY";
        case "CONNECTED":
            return "CONNECTED";
        case "PARTIAL_CONNECTED":
            return "REPORT_SENT";
        case "ADDRESS_MISMATCH":
            return "SERVER_RECEIVED";
        case "WAITING":
            return "CONNECT_BUTTON";
        case "NO_SESSION":
        case "IDLE":
        default:
            return null;
    }

}

function filterEvents(events, filter, sinceAt) {

    return (events ?? []).filter((event) => {

        if (sinceAt != null && (event.at ?? 0) < sinceAt) {

            return false;

        }

        if (filter === "all") {

            return true;

        }

        const type = String(event.type ?? "").toUpperCase();

        if (filter === "tonconnect") {

            return type.includes("WALLET")
                || type.includes("CONNECT")
                || type.includes("REPORT")
                || type.includes("MISMATCH")
                || type.includes("DISCONNECT")
                || type === "PAYMENT_READY"
                || type === "CONNECTED";

        }

        if (filter === "payment") {

            return type.includes("PAYMENT");

        }

        if (filter === "socket") {

            return type.includes("SOCKET") || type.includes("DISCONNECT");

        }

        return true;

    });

}

export default function TonConnectDiagnosticsPanel() {

    const roomsIndex = useConsoleProjection("rooms");
    const roomDetail = useConsoleProjection("room");
    const { focus, setFocus } = useConsoleFocus();

    const [search, setSearch] = useState("");
    const [eventFilter, setEventFilter] = useState("all");
    const [timeframe, setTimeframe] = useState("all");

    const rooms = roomsIndex?.rooms ?? [];
    const selectedRoomId = focus.roomId;
    const tonConnect = roomDetail?.tonConnect ?? null;

    const sinceAt = useMemo(() => {

        if (timeframe === "all") {

            return null;

        }

        const minutes = Number(timeframe);

        if (!Number.isFinite(minutes) || minutes <= 0) {

            return null;

        }

        return Date.now() - (minutes * 60 * 1000);

    }, [timeframe]);

    const filteredRooms = useMemo(() => {

        const query = search.trim().toLowerCase();

        if (!query) {

            return rooms;

        }

        return rooms.filter((room) => [
            room.roomId,
            room.state,
            room.gameId
        ].some((value) => String(value ?? "").toLowerCase().includes(query)));

    }, [rooms, search]);

    const filteredEvents = useMemo(
        () => filterEvents(tonConnect?.events, eventFilter, sinceAt),
        [tonConnect?.events, eventFilter, sinceAt]
    );

    const activeStage = mapServerStageToUi(tonConnect?.handshakeStage);

    function onExport() {

        if (!tonConnect) {

            return;

        }

        const filteredPayload = {
            ...tonConnect,
            events: filteredEvents
        };

        downloadTonConnectDiagnostics({
            roomId: selectedRoomId,
            filter: eventFilter,
            timeframeMs: sinceAt == null ? null : Date.now() - sinceAt,
            sinceAt,
            payload: filteredPayload
        });

    }

    if (!roomsIndex) {

        return (

            <PanelShell title="TonConnect Diagnostics">

                <EmptyState title="Waiting for rooms index" />

            </PanelShell>

        );

    }

    if (!selectedRoomId) {

        return (

            <PanelShell
                title="TonConnect Diagnostics"
                subtitle={`${filteredRooms.length} of ${rooms.length} rooms · select one room`}
            >

                <Toolbar
                    search={search}
                    onSearchChange={setSearch}
                    searchPlaceholder="Search room id…"
                />

                {filteredRooms.length === 0 ? (

                    <EmptyState title="No rooms" />

                ) : (

                    <div className="devConsole__cardGrid">

                        {filteredRooms.map((room) => (

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

                                        Game {room.gameId
                                            ? shortId(room.gameId, 10)
                                            : "—"}

                                    </span>

                                </div>

                            </button>

                        ))}

                    </div>

                )}

            </PanelShell>

        );

    }

    if (!roomDetail?.room) {

        return (

            <PanelShell
                title="TonConnect Diagnostics"
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

                <EmptyState
                    title="Loading room detail"
                    detail="High-frequency CONSOLE_ROOM projection pending."
                />

            </PanelShell>

        );

    }

    return (

        <div className="devConsole__stack">

            <PanelShell
                title="TonConnect Diagnostics"
                subtitle={`Room ${shortId(selectedRoomId, 16)} · read-only`}
                actions={(
                    <>
                        <button
                            type="button"
                            className="devConsole__button"
                            onClick={onExport}
                            disabled={!tonConnect}
                        >

                            Download Log

                        </button>
                        <button
                            type="button"
                            className="devConsole__textButton"
                            onClick={() => setFocus({ roomId: null, gameId: null })}
                        >

                            Back to rooms

                        </button>
                    </>
                )}
            >

                <Toolbar>

                    <FilterSelect
                        label="Events"
                        value={eventFilter}
                        onChange={setEventFilter}
                        options={[
                            { value: "all", label: "All" },
                            { value: "tonconnect", label: "TonConnect" },
                            { value: "payment", label: "Payment" },
                            { value: "socket", label: "Socket" }
                        ]}
                    />

                    <FilterSelect
                        label="Timeframe"
                        value={timeframe}
                        onChange={setTimeframe}
                        options={[
                            { value: "all", label: "All time" },
                            { value: "5", label: "Last 5 min" },
                            { value: "15", label: "Last 15 min" },
                            { value: "60", label: "Last 60 min" }
                        ]}
                    />

                </Toolbar>

                {!tonConnect ? (

                    <EmptyState
                        title="No TonConnect session for this room"
                        detail="Wallet connection session appears after PAYMENT_STAGE_READY."
                    />

                ) : (

                    <div className="devConsole__detailStack">

                        <KeyValueList
                            entries={[
                                {
                                    label: "Handshake stage",
                                    value: tonConnect.handshakeStage ?? "—"
                                },
                                {
                                    label: "Current owner",
                                    value: tonConnect.handshakeOwner ?? "—"
                                },
                                {
                                    label: "Payment connection ready",
                                    value: tonConnect.paymentConnectionReady
                                        ? "YES"
                                        : "NO"
                                },
                                {
                                    label: "Payment session",
                                    value: tonConnect.paymentSessionStatus
                                        ?? (tonConnect.paymentSessionActive
                                            ? "active"
                                            : "—")
                                }
                            ]}
                        />

                        <h3 className="devConsole__sectionTitle">

                            Handshake lifecycle

                        </h3>

                        <ol className="devConsole__stageList">

                            {HANDSHAKE_STAGES.map((stage) => (

                                <li
                                    key={stage}
                                    className={
                                        stage === activeStage
                                            ? "devConsole__stageListItem"
                                                + " devConsole__stageListItem--active"
                                            : "devConsole__stageListItem"
                                    }
                                >

                                    {stage}

                                </li>

                            ))}

                        </ol>

                        <h3 className="devConsole__sectionTitle">

                            Runtime ownership

                        </h3>

                        <KeyValueList
                            entries={[
                                {
                                    label: "TonConnect SDK",
                                    value: tonConnect.ownership?.tonConnectSdk
                                        ? "active"
                                        : "idle"
                                },
                                {
                                    label: "Bridge",
                                    value: tonConnect.ownership?.bridge
                                        ? "waiting"
                                        : "idle"
                                },
                                {
                                    label: "Socket",
                                    value: tonConnect.ownership?.socket
                                        ? "bound"
                                        : "unbound"
                                },
                                {
                                    label: "RoomLobbyBridge",
                                    value: tonConnect.ownership?.roomLobbyBridge
                                        ? "session"
                                        : "none"
                                },
                                {
                                    label: "WalletConnectionSession",
                                    value: tonConnect.ownership
                                        ?.walletConnectionSession
                                        ? "present"
                                        : "none"
                                },
                                {
                                    label: "Payment Session",
                                    value: tonConnect.ownership?.paymentSession
                                        ? "present"
                                        : "none"
                                }
                            ]}
                        />

                        <h3 className="devConsole__sectionTitle">

                            Bridge diagnostics

                        </h3>

                        <KeyValueList
                            entries={[
                                {
                                    label: "Type",
                                    value: tonConnect.bridge?.type ?? "—"
                                },
                                {
                                    label: "Provider",
                                    value: tonConnect.bridge?.provider ?? "—"
                                },
                                {
                                    label: "Transport",
                                    value: tonConnect.bridge?.transport ?? "—"
                                },
                                {
                                    label: "Session state",
                                    value: tonConnect.bridge?.sessionState ?? "—"
                                },
                                {
                                    label: "Connected / Waiting / Disconnected",
                                    value: `${tonConnect.bridge?.connectedPlayers ?? 0}`
                                        + ` / ${tonConnect.bridge?.waitingPlayers ?? 0}`
                                        + ` / ${tonConnect.bridge?.disconnectedPlayers ?? 0}`
                                },
                                {
                                    label: "Last bridge activity",
                                    value: formatDiagnosticTime(
                                        tonConnect.bridge?.lastBridgeActivityAt
                                    )
                                },
                                {
                                    label: "Note",
                                    value: tonConnect.bridge?.note ?? "—"
                                }
                            ]}
                        />

                        <h3 className="devConsole__sectionTitle">

                            Players

                        </h3>

                        <div className="devConsole__tableWrap">

                            <table className="devConsole__table">

                                <thead>

                                    <tr>

                                        <th>Player</th>
                                        <th>Nickname</th>
                                        <th>Socket</th>
                                        <th>Status</th>
                                        <th>Wallet</th>
                                        <th>Provider / Name</th>
                                        <th>Chain / Network</th>
                                        <th>Public key</th>
                                        <th>Last event</th>
                                        <th>Status Δ</th>
                                        <th>REPORT</th>

                                    </tr>

                                </thead>

                                <tbody>

                                    {(tonConnect.players ?? []).map((player) => (

                                        <tr key={player.playerId}>

                                            <td>{shortId(player.playerId, 10)}</td>
                                            <td>{player.nickname ?? "—"}</td>
                                            <td>
                                                {player.socketId
                                                    ? shortId(player.socketId, 10)
                                                    : "—"}
                                            </td>
                                            <td>
                                                <span
                                                    className={
                                                        "devConsole__statusChip "
                                                        + `devConsole__statusChip--${
                                                            String(
                                                                player.displayStatus
                                                                ?? player.status
                                                                ?? "WAITING"
                                                            ).toLowerCase()
                                                        }`
                                                    }
                                                >

                                                    {player.displayStatus
                                                        ?? player.status
                                                        ?? "WAITING"}

                                                </span>
                                            </td>
                                            <td title={player.walletAddress ?? ""}>
                                                {shortenWallet(player.walletAddress)}
                                            </td>
                                            <td>
                                                {(player.walletProvider
                                                    ?? player.walletName)
                                                    ? `${player.walletProvider ?? "—"}`
                                                        + ` / ${player.walletName ?? "—"}`
                                                    : "— (client-only)"}
                                            </td>
                                            <td>
                                                {(player.walletChain
                                                    ?? player.walletNetwork)
                                                    ? `${player.walletChain ?? "—"}`
                                                        + ` / ${player.walletNetwork ?? "—"}`
                                                    : "— (client-only)"}
                                            </td>
                                            <td>
                                                {player.walletPublicKey
                                                    ? shortenWallet(
                                                        player.walletPublicKey,
                                                        4,
                                                        4
                                                    )
                                                    : "— (client-only)"}
                                            </td>
                                            <td>{player.lastTonConnectEvent ?? "—"}</td>
                                            <td>
                                                {formatDiagnosticTime(
                                                    player.lastStatusChangeAt
                                                )}
                                            </td>
                                            <td>
                                                {formatDiagnosticTime(
                                                    player.lastReportAt
                                                )}
                                            </td>

                                        </tr>

                                    ))}

                                </tbody>

                            </table>

                        </div>

                        <h3 className="devConsole__sectionTitle">

                            Server events (this room only)

                        </h3>

                        {filteredEvents.length === 0 ? (

                            <EmptyState title="No events for current filter" />

                        ) : (

                            <ul className="devConsole__eventTimeline">

                                {[...filteredEvents].reverse().map((event, index) => (

                                    <li
                                        key={`${event.at}-${event.type}-${index}`}
                                        className="devConsole__eventTimelineItem"
                                    >

                                        <span className="devConsole__eventTime">

                                            {formatDiagnosticTime(event.at)}

                                        </span>

                                        <span className="devConsole__eventType">

                                            {event.type}

                                        </span>

                                        <span className="devConsole__eventMeta">

                                            {event.playerId
                                                ? shortId(event.playerId, 10)
                                                : "room"}
                                            {event.detail
                                                ? ` · ${event.detail}`
                                                : ""}

                                        </span>

                                    </li>

                                ))}

                            </ul>

                        )}

                    </div>

                )}

            </PanelShell>

        </div>

    );

}
