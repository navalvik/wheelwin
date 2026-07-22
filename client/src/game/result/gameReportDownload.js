/**
 * R6.4 — Deterministic TXT rendering of an authoritative Game Report.
 * Kept for server parity / tests; Page6 downloads use the native HTTP endpoint.
 */
export function formatGameReportAsText(report) {

    if (!report) {

        return "";

    }

    const lines = [];

    const push = (line = "") => {

        lines.push(line);

    };

    const field = (label, value) => {

        push(`${label}:`);
        push(value == null || value === "" ? "—" : String(value));
        push();

    };

    push("================================================");
    push("WHEELWIN GAME REPORT");
    push("================================================");
    push();

    field("Report ID", report.reportId);
    field("Game ID", report.gameId);
    field("Room ID", report.roomId);
    field("Audit Trace ID", report.auditTraceId);
    field("Game Start Time", formatIso(report.gameStartTime));
    field("Game Finish Time", formatIso(report.gameFinishTime));
    field(
        "Game Duration",
        Number.isFinite(report.gameDurationMs)
            ? `${report.gameDurationMs} ms`
            : null
    );
    field("Server Timestamp", formatIso(report.serverTimestamp));
    field(
        "Final Wheel Angle",
        Number.isFinite(report.finalWheelAngle)
            ? `${report.finalWheelAngle}°`
            : null
    );
    field("Winning Sector", report.winningSector?.sectorId);
    field("Winning Color", report.winningColor);
    field("Winning Icon", report.winningIcon);
    field(
        "Winning Player",
        report.winningPlayer?.nickname
            ?? report.winningPlayer?.playerId
    );
    field(
        "Winner Payout",
        formatMoney(report.winnerPayout, report.currency)
    );
    field(
        "WheelWin Commission",
        formatMoney(report.wheelWinCommission, report.currency)
    );
    field(
        "Total Prize Pool",
        formatMoney(report.totalPrizePool, report.currency)
    );
    field("Base Stake", report.baseStake);
    field("Total Sector Count", report.totalSectorCount);
    field("Game Version", report.gameVersion);
    field("Server Version", report.serverVersion);

    push("------------------------------------------------");
    push("PLAYERS");
    push("------------------------------------------------");
    push();

    for (const player of report.players ?? []) {

        push(`PLAYER ${player.index}`);
        push();
        field("Nickname", player.nickname);
        field("Player ID", player.playerId);
        field("Icon", player.icon);
        field("Sector Count", player.sectorCount);
        field(
            "Sector Colors",
            Array.isArray(player.sectorColors)
                ? player.sectorColors.join(", ")
                : null
        );
        field("Base Stake", player.baseStake);
        field("Paid", formatMoney(player.amountPaid, report.currency));
        field("Wallet", player.walletAddress);
        field("Result", player.result);
        field("Prize", formatMoney(player.prizeReceived, report.currency));
        push("------------------------------------------------");
        push();

    }

    push("BLOCKCHAIN (reserved)");
    push();
    field("Report Hash", report.blockchain?.reportHash);
    field("Hash Algorithm", report.blockchain?.hashAlgorithm);
    field("Smart Contract Address", report.blockchain?.smartContractAddress);
    field("TON Transaction Hash", report.blockchain?.tonTransactionHash);
    field(
        "Blockchain Confirmation Timestamp",
        report.blockchain?.blockchainConfirmationTimestamp
    );
    field("Digital Signature", report.blockchain?.digitalSignature);

    push("================================================");
    push("END OF REPORT");
    push("================================================");

    return lines.join("\n");

}

function formatIso(timestamp) {

    if (!Number.isFinite(timestamp)) {

        return null;

    }

    return new Date(timestamp).toISOString();

}

function formatMoney(amount, currency) {

    if (amount === null || amount === undefined) {

        return null;

    }

    const unit = currency === "TON" ? "GRM" : (currency ?? "GRM");

    return `${amount} ${unit}`;

}

const SERVER_URL = import.meta.env.VITE_SOCKET_URL || "http://localhost:3001";

/**
 * R6.5B — Native browser download of an already-generated Game Report.
 * No Blob / ObjectURL — the browser downloads the file from the server.
 */
export function buildGameReportDownloadUrl(report, format = "json") {

    if (!report) {

        return null;

    }

    const id = report.reportId ?? report.gameId;

    if (!id) {

        return null;

    }

    const normalized = format === "txt" ? "txt" : "json";

    return `${SERVER_URL}/api/game-report/${encodeURIComponent(id)}/download`
        + `?format=${normalized}`;

}

export function downloadGameReportNative(report, format = "json") {

    const url = buildGameReportDownloadUrl(report, format);

    if (!url) {

        console.error("[GameReport] Download aborted: missing report id");

        return null;

    }

    console.debug("[GameReport] Native download", {
        url,
        format,
        reportId: report.reportId ?? null,
        gameId: report.gameId ?? null
    });

    // Hidden iframe keeps Page6 mounted while the browser performs a native
    // attachment download from the server (no Blob / ObjectURL).
    const frame = document.createElement("iframe");

    frame.style.display = "none";

    frame.setAttribute("aria-hidden", "true");

    frame.src = url;

    document.body.appendChild(frame);

    window.setTimeout(() => {

        if (frame.parentNode) {

            frame.parentNode.removeChild(frame);

        }

    }, 60_000);

    return url;

}
