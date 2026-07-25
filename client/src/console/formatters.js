/**
 * R6.0E — Formatting helpers for Developer Console panels.
 */

export const PAGE_LABELS = Object.freeze({
    1: "Welcome",
    2: "Lobby",
    3: "Player Setup",
    4: "Matrix",
    5: "Verify",
    6: "Payment",
    7: "Game",
    8: "Result"
});

export function formatPage(page) {

    if (page == null) {

        return "—";

    }

    return PAGE_LABELS[page] ?? `Page ${page}`;

}

export function formatUptime(ms) {

    if (!Number.isFinite(ms) || ms < 0) {

        return "—";

    }

    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {

        return `${hours}h ${minutes}m ${seconds}s`;

    }

    if (minutes > 0) {

        return `${minutes}m ${seconds}s`;

    }

    return `${seconds}s`;

}

export function formatBytes(bytes) {

    if (!Number.isFinite(bytes) || bytes < 0) {

        return "—";

    }

    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {

        value /= 1024;
        unit += 1;

    }

    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;

}

export function formatDurationMs(ms) {

    if (!Number.isFinite(ms)) {

        return "—";

    }

    if (ms < 1000) {

        return `${ms.toFixed(1)} ms`;

    }

    return formatUptime(ms);

}

export function formatTimestamp(at) {

    if (!Number.isFinite(at)) {

        return "—";

    }

    return new Date(at).toLocaleString();

}

export function formatClockTime(at) {

    if (!Number.isFinite(at)) {

        return "—";

    }

    return new Date(at).toLocaleTimeString();

}

export function shortId(id, size = 10) {

    if (!id || typeof id !== "string") {

        return "—";

    }

    return id.length <= size ? id : `${id.slice(0, size)}…`;

}
