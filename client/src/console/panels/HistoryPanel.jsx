import { useCallback, useEffect, useMemo, useState } from "react";

import { useDeveloperAuth } from "../DeveloperAuthProvider";
import {
    downloadSessionHistoryRecord,
    fetchSessionHistory,
    fetchSessionHistoryRecord
} from "../developerAuthApi";
import { formatDurationMs, formatUptime, shortId } from "../formatters";
import PanelShell from "./shared/PanelShell";
import { FilterSelect } from "./shared/Toolbar";
import EmptyState from "./shared/EmptyState";
import { KeyValueList } from "./shared/DataTable";

const LIFECYCLE_OPTIONS = [
    { value: "all", label: "All results" },
    { value: "GAME_COMPLETED", label: "GAME_COMPLETED" },
    { value: "SETUP_EXPIRED", label: "SETUP_EXPIRED" },
    { value: "VERIFY_ABORTED", label: "VERIFY_ABORTED" },
    { value: "VERIFY_TIMEOUT", label: "VERIFY_TIMEOUT" },
    { value: "PAYMENT_TIMEOUT", label: "PAYMENT_TIMEOUT" },
    { value: "PAYMENT_FAILED", label: "PAYMENT_FAILED" },
    { value: "TONCONNECT_TIMEOUT", label: "TONCONNECT_TIMEOUT" },
    { value: "TONCONNECT_FAILED", label: "TONCONNECT_FAILED" },
    { value: "ROOM_DESTROYED", label: "ROOM_DESTROYED" },
    { value: "RECOVERY_FAILED", label: "RECOVERY_FAILED" },
    { value: "SERVER_ABORT", label: "SERVER_ABORT" },
    { value: "CLIENT_ABORT", label: "CLIENT_ABORT" },
    { value: "ADMIN_ABORT", label: "ADMIN_ABORT" },
    { value: "UNKNOWN_FAILURE", label: "UNKNOWN_FAILURE" }
];

const SORT_OPTIONS = [
    { value: "newest", label: "Newest first" },
    { value: "oldest", label: "Oldest first" },
    { value: "duration", label: "Duration" },
    { value: "result", label: "Lifecycle Result" }
];

function formatFinishTime(at) {

    if (!at) {

        return "—";

    }

    try {

        const date = new Date(at);

        if (Number.isNaN(date.getTime())) {

            return "—";

        }

        const pad = (value) => String(value).padStart(2, "0");

        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
            + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;

    } catch {

        return String(at);

    }

}

function formatGameId(gameId) {

    if (gameId == null || gameId === "") {

        return "NO_GAME";

    }

    return String(gameId);

}

/**
 * Map lifecycle result → badge tone. Presentation only — no gameplay logic.
 * Named tones cover the R7.2 palette; existing archive values map sensibly.
 */
function lifecycleBadgeTone(result) {

    const value = String(result ?? "UNKNOWN").toUpperCase();

    if (value === "GAME_COMPLETED") {

        return "completed";

    }

    if (
        value === "GAME_CANCELLED"
        || value === "GAME_CANCELED"
        || value === "CLIENT_ABORT"
        || value === "ADMIN_ABORT"
        || value === "ROOM_DESTROYED"
    ) {

        return "cancelled";

    }

    if (
        value === "VERIFY_CANCELLED"
        || value === "VERIFY_CANCELED"
        || value === "VERIFY_ABORTED"
    ) {

        return "verifyCancelled";

    }

    if (
        value === "SETUP_EXPIRED"
        || value === "VERIFY_TIMEOUT"
        || value === "PAYMENT_TIMEOUT"
    ) {

        return "expired";

    }

    if (
        value === "PAYMENT_FAILED"
        || value === "WALLET_CONNECT_TIMEOUT"
        || value === "TONCONNECT_TIMEOUT"
        || value === "TONCONNECT_FAILED"
    ) {

        return "failed";

    }

    if (
        value === "SERVER_ERROR"
        || value === "SERVER_ABORT"
        || value === "RECOVERY_FAILED"
    ) {

        return "serverError";

    }

    return "unknown";

}

function isCompletedLifecycle(result) {

    return String(result ?? "") === "GAME_COMPLETED";

}

function formatClock(at) {

    if (!at) {

        return "—";

    }

    try {

        return new Date(at).toLocaleTimeString();

    } catch {

        return String(at);

    }

}

function HistoryEmptyArchive() {

    return (

        <div className="devConsole__empty devConsole__historyEmpty">

            <p className="devConsole__emptyTitle">

                No archived sessions.

            </p>

            <p className="devConsole__emptyDetail">

                A session archive is automatically created whenever
                a Room Lifecycle reaches a terminal state.

            </p>

            <p className="devConsole__historyEmptyExamplesLabel">

                Examples:

            </p>

            <ul className="devConsole__historyEmptyExamples">

                <li>GAME_COMPLETED</li>
                <li>PAYMENT_FAILED</li>
                <li>VERIFY_CANCELLED</li>
                <li>SETUP_EXPIRED</li>
                <li>WALLET_CONNECT_TIMEOUT</li>
                <li>SERVER_ERROR</li>

            </ul>

        </div>

    );

}

export default function HistoryPanel() {

    const { accessToken, authEnabled } = useDeveloperAuth();
    const token = authEnabled ? accessToken : null;

    const [searchRoom, setSearchRoom] = useState("");
    const [searchGame, setSearchGame] = useState("");
    const [nickname, setNickname] = useState("");
    const [wallet, setWallet] = useState("");
    const [lifecycleResult, setLifecycleResult] = useState("all");
    const [sort, setSort] = useState("newest");
    const [dateFrom, setDateFrom] = useState("");
    const [dateTo, setDateTo] = useState("");

    const [list, setList] = useState(null);
    const [archiveSummary, setArchiveSummary] = useState(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const [selectedId, setSelectedId] = useState(null);
    const [detail, setDetail] = useState(null);
    const [detailError, setDetailError] = useState("");

    const query = useMemo(() => {

        const fromAt = dateFrom
            ? Date.parse(`${dateFrom}T00:00:00`)
            : null;
        const toAt = dateTo
            ? Date.parse(`${dateTo}T23:59:59`)
            : null;

        return {
            roomId: searchRoom.trim() || null,
            gameId: searchGame.trim() || null,
            playerNickname: nickname.trim() || null,
            walletAddress: wallet.trim() || null,
            lifecycleResult,
            sort,
            fromAt: Number.isFinite(fromAt) ? fromAt : null,
            toAt: Number.isFinite(toAt) ? toAt : null,
            limit: 200,
            offset: 0
        };

    }, [
        searchRoom,
        searchGame,
        nickname,
        wallet,
        lifecycleResult,
        sort,
        dateFrom,
        dateTo
    ]);

    const hasActiveFilters = Boolean(
        searchRoom.trim()
        || searchGame.trim()
        || nickname.trim()
        || wallet.trim()
        || (lifecycleResult && lifecycleResult !== "all")
        || dateFrom
        || dateTo
    );

    const refreshArchiveSummary = useCallback(async () => {

        try {

            const next = await fetchSessionHistory(token, {
                lifecycleResult: "all",
                sort: "newest",
                limit: 200,
                offset: 0
            });
            const rows = next?.records ?? [];
            const completed = rows.filter(
                (row) => isCompletedLifecycle(row.lifecycleResult)
            ).length;
            const interrupted = rows.filter(
                (row) => !isCompletedLifecycle(row.lifecycleResult)
            ).length;

            setArchiveSummary({
                total: next?.total ?? rows.length,
                completed,
                interrupted
            });

        } catch {

            // List refresh surfaces the error; keep last known summary.
        }

    }, [token]);

    const refresh = useCallback(async () => {

        setLoading(true);
        setError("");

        try {

            const next = await fetchSessionHistory(token, query);

            setList(next);

        } catch (err) {

            setError(err.message || "Failed to load history");
            setList(null);

        } finally {

            setLoading(false);

        }

    }, [token, query]);

    useEffect(() => {

        refresh();

    }, [refresh]);

    useEffect(() => {

        refreshArchiveSummary();

    }, [refreshArchiveSummary]);

    useEffect(() => {

        if (!selectedId) {

            setDetail(null);
            setDetailError("");

            return;

        }

        let cancelled = false;

        setDetail(null);
        setDetailError("");

        fetchSessionHistoryRecord(token, selectedId)
            .then((record) => {

                if (!cancelled) {

                    setDetail(record);

                }

            })
            .catch((err) => {

                if (!cancelled) {

                    setDetailError(err.message || "Failed to load record");

                }

            });

        return () => {

            cancelled = true;

        };

    }, [selectedId, token]);

    const records = list?.records ?? [];

    const summary = archiveSummary ?? {
        total: list?.total ?? records.length,
        completed: records.filter(
            (row) => isCompletedLifecycle(row.lifecycleResult)
        ).length,
        interrupted: records.filter(
            (row) => !isCompletedLifecycle(row.lifecycleResult)
        ).length
    };

    async function downloadRecord(sessionId) {

        try {

            await downloadSessionHistoryRecord(token, sessionId);

        } catch (err) {

            setError(err.message || "Download failed");

        }

    }

    function onRowDownload(event, sessionId) {

        event.preventDefault();
        event.stopPropagation();
        downloadRecord(sessionId);

    }

    if (selectedId) {

        return (

            <div className="devConsole__stack">

                <PanelShell
                    title="History Record"
                    subtitle={shortId(selectedId, 20)}
                    actions={(
                        <>
                            <button
                                type="button"
                                className="devConsole__button"
                                onClick={() => downloadRecord(selectedId)}
                            >

                                Download Log

                            </button>
                            <button
                                type="button"
                                className="devConsole__textButton"
                                onClick={() => setSelectedId(null)}
                            >

                                Back to history

                            </button>
                        </>
                    )}
                >

                    {detailError && (

                        <p className="devConsole__loginError">{detailError}</p>

                    )}

                    {!detail && !detailError ? (

                        <EmptyState title="Loading archive…" />

                    ) : detail ? (

                        <div className="devConsole__detailStack">

                            <KeyValueList
                                entries={[
                                    { label: "Session ID", value: detail.sessionId },
                                    { label: "Room ID", value: detail.roomId },
                                    {
                                        label: "Game ID",
                                        value: detail.gameId ?? "NO_GAME"
                                    },
                                    {
                                        label: "Created",
                                        value: formatFinishTime(detail.createdAt)
                                    },
                                    {
                                        label: "Started",
                                        value: formatFinishTime(detail.startedAt)
                                    },
                                    {
                                        label: "Finished",
                                        value: formatFinishTime(detail.finishedAt)
                                    },
                                    {
                                        label: "Duration",
                                        value: formatDurationMs(detail.durationMs)
                                            ?? formatUptime(detail.durationMs)
                                    },
                                    {
                                        label: "Lifecycle Result",
                                        value: detail.lifecycleResult
                                    },
                                    {
                                        label: "Failure Owner",
                                        value: detail.failureOwner
                                    },
                                    {
                                        label: "Final Stage",
                                        value: detail.finalStage
                                    }
                                ]}
                            />

                            <h3 className="devConsole__sectionTitle">Players</h3>

                            <div className="devConsole__tableWrap">

                                <table className="devConsole__table">

                                    <thead>

                                        <tr>

                                            <th>Player ID</th>
                                            <th>Nickname</th>
                                            <th>Wallet</th>
                                            <th>Status</th>
                                            <th>Socket</th>

                                        </tr>

                                    </thead>

                                    <tbody>

                                        {(detail.players ?? []).map((player) => (

                                            <tr key={player.playerId}>

                                                <td>{shortId(player.playerId, 12)}</td>
                                                <td>{player.nickname ?? "—"}</td>
                                                <td>{player.walletAddress ?? "—"}</td>
                                                <td>{player.status ?? "—"}</td>
                                                <td>
                                                    {player.socketId
                                                        ? shortId(player.socketId, 10)
                                                        : "—"}
                                                </td>

                                            </tr>

                                        ))}

                                    </tbody>

                                </table>

                            </div>

                            <h3 className="devConsole__sectionTitle">Configuration</h3>

                            <pre className="devConsole__projectionJson">

                                {JSON.stringify(detail.configuration ?? {}, null, 2)}

                            </pre>

                            <h3 className="devConsole__sectionTitle">
                                Setup / Verify / Payment / TonConnect
                            </h3>

                            <pre className="devConsole__projectionJson">

                                {JSON.stringify({
                                    setupSession: detail.setupSession,
                                    verify: detail.verify,
                                    payment: detail.payment,
                                    tonConnect: detail.tonConnect,
                                    walletConnectionSession:
                                        detail.walletConnectionSession
                                }, null, 2)}

                            </pre>

                            <h3 className="devConsole__sectionTitle">Timeline</h3>

                            <ul className="devConsole__eventTimeline">

                                {(detail.timeline ?? []).map((entry, index) => (

                                    <li
                                        key={`${entry.at}-${index}`}
                                        className="devConsole__eventTimelineItem"
                                    >

                                        <span className="devConsole__eventTime">

                                            {formatClock(entry.at)}

                                        </span>

                                        <span className="devConsole__eventType">

                                            {entry.subsystem}

                                        </span>

                                        <span className="devConsole__eventMeta">

                                            {entry.message}

                                        </span>

                                    </li>

                                ))}

                            </ul>

                            <h3 className="devConsole__sectionTitle">Final Snapshot</h3>

                            <pre className="devConsole__projectionJson">

                                {JSON.stringify(detail.finalSnapshot ?? {}, null, 2)}

                            </pre>

                            <h3 className="devConsole__sectionTitle">Developer Log</h3>

                            <pre className="devConsole__projectionJson">

                                {JSON.stringify(detail.developerLog ?? [], null, 2)}

                            </pre>

                        </div>

                    ) : null}

                </PanelShell>

            </div>

        );

    }

    const showEmptyArchive = !loading && records.length === 0 && !hasActiveFilters;
    const showEmptyFilter = !loading && records.length === 0 && hasActiveFilters;

    return (

        <PanelShell
            title="History"
            subtitle="Session lifecycle archive"
            actions={(
                <button
                    type="button"
                    className="devConsole__textButton"
                    onClick={() => {

                        refresh();
                        refreshArchiveSummary();

                    }}
                >

                    Refresh

                </button>
            )}
        >

            <div className="devConsole__historySummary" aria-live="polite">

                <div className="devConsole__historyStat">

                    <span className="devConsole__historyStatLabel">

                        Archived Sessions

                    </span>

                    <span className="devConsole__historyStatValue">

                        {loading ? "…" : summary.total}

                    </span>

                </div>

                <div className="devConsole__historyStat">

                    <span className="devConsole__historyStatLabel">

                        Completed

                    </span>

                    <span className="devConsole__historyStatValue">

                        {loading ? "…" : summary.completed}

                    </span>

                </div>

                <div className="devConsole__historyStat">

                    <span className="devConsole__historyStatLabel">

                        Interrupted

                    </span>

                    <span className="devConsole__historyStatValue">

                        {loading ? "…" : summary.interrupted}

                    </span>

                </div>

            </div>

            <div className="devConsole__historyBrowser">

                <label className="devConsole__filter devConsole__historyRoomFilter">

                    <span>Room ID</span>

                    <input
                        type="search"
                        value={searchRoom}
                        onChange={(event) => setSearchRoom(event.target.value)}
                        placeholder="Filter by Room ID…"
                    />

                </label>

                <details className="devConsole__historyAdvanced">

                    <summary>

                        Advanced Filters

                    </summary>

                    <div className="devConsole__historyFilters">

                        <label className="devConsole__filter">

                            <span>Game ID</span>

                            <input
                                type="text"
                                value={searchGame}
                                onChange={(event) => setSearchGame(event.target.value)}
                                placeholder="Game ID"
                            />

                        </label>

                        <label className="devConsole__filter">

                            <span>Nickname</span>

                            <input
                                type="text"
                                value={nickname}
                                onChange={(event) => setNickname(event.target.value)}
                                placeholder="Player nickname"
                            />

                        </label>

                        <label className="devConsole__filter">

                            <span>Wallet</span>

                            <input
                                type="text"
                                value={wallet}
                                onChange={(event) => setWallet(event.target.value)}
                                placeholder="Wallet address"
                            />

                        </label>

                        <label className="devConsole__filter">

                            <span>Date From</span>

                            <input
                                type="date"
                                value={dateFrom}
                                onChange={(event) => setDateFrom(event.target.value)}
                            />

                        </label>

                        <label className="devConsole__filter">

                            <span>Date To</span>

                            <input
                                type="date"
                                value={dateTo}
                                onChange={(event) => setDateTo(event.target.value)}
                            />

                        </label>

                        <FilterSelect
                            label="Lifecycle Result"
                            value={lifecycleResult}
                            onChange={setLifecycleResult}
                            options={LIFECYCLE_OPTIONS}
                        />

                        <FilterSelect
                            label="Sort"
                            value={sort}
                            onChange={setSort}
                            options={SORT_OPTIONS}
                        />

                    </div>

                </details>

            </div>

            {error && (

                <p className="devConsole__loginError">{error}</p>

            )}

            {showEmptyArchive ? (

                <HistoryEmptyArchive />

            ) : showEmptyFilter ? (

                <EmptyState
                    title="No matching archived sessions"
                    detail="Try clearing Advanced Filters or adjusting Room ID."
                />

            ) : (

                <div className="devConsole__tableWrap">

                    <table className="devConsole__table devConsole__table--history">

                        <thead>

                            <tr>

                                <th>Finish Time</th>
                                <th>Room ID</th>
                                <th>Game ID</th>
                                <th>Lifecycle Result</th>
                                <th className="devConsole__tableAction">Download</th>

                            </tr>

                        </thead>

                        <tbody>

                            {loading && records.length === 0 ? (

                                <tr>

                                    <td colSpan={5} className="devConsole__historyLoadingCell">

                                        Loading archived sessions…

                                    </td>

                                </tr>

                            ) : records.map((row) => (

                                <tr
                                    key={row.sessionId}
                                    className="devConsole__historyRow"
                                    onClick={() => setSelectedId(row.sessionId)}
                                    onKeyDown={(event) => {

                                        if (event.key === "Enter" || event.key === " ") {

                                            event.preventDefault();
                                            setSelectedId(row.sessionId);

                                        }

                                    }}
                                    tabIndex={0}
                                    role="button"
                                    aria-label={
                                        `Open session details for room ${row.roomId}`
                                    }
                                >

                                    <td>

                                        {formatFinishTime(row.finishedAt)}

                                    </td>
                                    <td className="devConsole__mono" title={row.roomId}>

                                        {row.roomId}

                                    </td>
                                    <td className="devConsole__mono">

                                        {formatGameId(row.gameId)}

                                    </td>
                                    <td>

                                        <span
                                            className={
                                                "devConsole__lifecycleBadge "
                                                + `devConsole__lifecycleBadge--${
                                                    lifecycleBadgeTone(row.lifecycleResult)
                                                }`
                                            }
                                        >

                                            {row.lifecycleResult ?? "UNKNOWN"}

                                        </span>

                                    </td>
                                    <td className="devConsole__tableAction">

                                        <button
                                            type="button"
                                            className="devConsole__iconButton"
                                            title="Download diagnostic archive"
                                            aria-label={
                                                `Download archive for room ${row.roomId}`
                                            }
                                            onClick={(event) => onRowDownload(
                                                event,
                                                row.sessionId
                                            )}
                                        >

                                            <span aria-hidden="true">📥</span>

                                        </button>

                                    </td>

                                </tr>

                            ))}

                        </tbody>

                    </table>

                </div>

            )}

        </PanelShell>

    );

}
