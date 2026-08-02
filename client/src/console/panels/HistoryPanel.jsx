import { useCallback, useEffect, useMemo, useState } from "react";

import { useDeveloperAuth } from "../DeveloperAuthProvider";
import {
    downloadSessionHistoryRecord,
    fetchSessionHistory,
    fetchSessionHistoryRecord
} from "../developerAuthApi";
import { formatDurationMs, formatUptime, shortId } from "../formatters";
import PanelShell from "./shared/PanelShell";
import Toolbar, { FilterSelect } from "./shared/Toolbar";
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

function lifecycleBadgeTone(result) {

    const value = String(result ?? "");

    if (value === "GAME_COMPLETED") {

        return "ok";

    }

    if (value.includes("TIMEOUT") || value.includes("EXPIRED")) {

        return "warn";

    }

    if (
        value.includes("FAILED")
        || value.includes("ABORT")
        || value.includes("CANCELLED")
        || value.includes("CANCELED")
    ) {

        return "error";

    }

    if (value === "ROOM_DESTROYED" || value === "UNKNOWN_FAILURE") {

        return "muted";

    }

    return "info";

}

function isCompletedLifecycle(result) {

    return String(result ?? "") === "GAME_COMPLETED";

}

function DownloadIcon() {

    return (

        <svg
            className="devConsole__downloadIcon"
            viewBox="0 0 16 16"
            width="14"
            height="14"
            aria-hidden="true"
            focusable="false"
        >

            <path
                fill="currentColor"
                d="M8 1a.75.75 0 0 1 .75.75v6.69l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 0 1 1.06-1.06l2.22 2.22V1.75A.75.75 0 0 1 8 1Zm-5 10.25a.75.75 0 0 0 0 1.5h10a.75.75 0 0 0 0-1.5H3Z"
            />

        </svg>

    );

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

    const summary = useMemo(() => {

        const completed = records.filter(
            (row) => isCompletedLifecycle(row.lifecycleResult)
        ).length;

        return {
            total: list?.total ?? records.length,
            completed,
            terminated: Math.max(0, records.length - completed)
        };

    }, [list, records]);

    async function onDownload(sessionId) {

        try {

            await downloadSessionHistoryRecord(token, sessionId);

        } catch (err) {

            setError(err.message || "Download failed");

        }

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
                                onClick={() => onDownload(selectedId)}
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

    return (

        <PanelShell
            title="History"
            subtitle="Session lifecycle journal"
            actions={(
                <button
                    type="button"
                    className="devConsole__textButton"
                    onClick={refresh}
                >

                    Refresh

                </button>
            )}
        >

            <div className="devConsole__historySummary" aria-live="polite">

                <strong>

                    {loading
                        ? "Loading…"
                        : `${summary.total} archived session lifecycles`}

                </strong>

                {!loading && (

                    <span>

                        {summary.completed} completed
                        {" · "}
                        {summary.terminated} terminated

                    </span>

                )}

            </div>

            <Toolbar
                search={searchRoom}
                onSearchChange={setSearchRoom}
                searchPlaceholder="Filter Room ID…"
            >

                <FilterSelect
                    label="Result"
                    value={lifecycleResult}
                    onChange={setLifecycleResult}
                    options={LIFECYCLE_OPTIONS}
                />

                <FilterSelect
                    label="Sort"
                    value={sort}
                    onChange={setSort}
                    options={[
                        { value: "newest", label: "Newest first" },
                        { value: "oldest", label: "Oldest first" },
                        { value: "duration", label: "Duration" },
                        { value: "result", label: "Lifecycle Result" }
                    ]}
                />

            </Toolbar>

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

                    <span>From</span>

                    <input
                        type="date"
                        value={dateFrom}
                        onChange={(event) => setDateFrom(event.target.value)}
                    />

                </label>

                <label className="devConsole__filter">

                    <span>To</span>

                    <input
                        type="date"
                        value={dateTo}
                        onChange={(event) => setDateTo(event.target.value)}
                    />

                </label>

            </div>

            {error && (

                <p className="devConsole__loginError">{error}</p>

            )}

            {records.length === 0 ? (

                <EmptyState
                    title="No archived sessions"
                    detail="History is written once when a Session Lifecycle reaches a terminal state."
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

                            {records.map((row) => (

                                <tr key={row.sessionId}>

                                    <td>

                                        <button
                                            type="button"
                                            className="devConsole__textButton"
                                            onClick={() => setSelectedId(row.sessionId)}
                                        >

                                            {formatFinishTime(row.finishedAt)}

                                        </button>

                                    </td>
                                    <td className="devConsole__mono">

                                        <button
                                            type="button"
                                            className="devConsole__textButton"
                                            onClick={() => setSelectedId(row.sessionId)}
                                            title={row.roomId}
                                        >

                                            {row.roomId}

                                        </button>

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

                                            {row.lifecycleResult ?? "UNKNOWN_FAILURE"}

                                        </span>

                                    </td>
                                    <td className="devConsole__tableAction">

                                        <button
                                            type="button"
                                            className="devConsole__iconButton"
                                            title="Download diagnostic archive"
                                            aria-label={`Download archive for room ${row.roomId}`}
                                            onClick={() => onDownload(row.sessionId)}
                                        >

                                            <DownloadIcon />

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
