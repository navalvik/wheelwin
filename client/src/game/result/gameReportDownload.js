/**
 * R6.4 — Deterministic TXT rendering of an authoritative Game Report.
 * Mirrors server formatGameReportAsText so downloads match the server record.
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

export function downloadTextFile(filename, contents, mimeType) {

    const blob = new Blob([contents], { type: mimeType });

    const url = URL.createObjectURL(blob);

    const anchor = document.createElement("a");

    anchor.href = url;

    anchor.download = filename;

    document.body.appendChild(anchor);

    anchor.click();

    anchor.remove();

    URL.revokeObjectURL(url);

}
