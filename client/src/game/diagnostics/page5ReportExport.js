/**
 * A downloadable report from the CURRENT player's Telegram WebView.
 * No financial details, wallet addresses, Telegram identifiers or credentials.
 */
export function safeReportFilenamePart(value, fallback) {
    const cleaned = String(value ?? "")
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 48);
    return cleaned || fallback;
}

export function formatPage5DeviceReportFile(report) {
    if (!report || report.schema !== "wheelwin.page5-device-diagnostics.v1") {
        return null;
    }
    return {
        filename: "WheelWin_Page5_"
            + safeReportFilenamePart(report.roomId, "ROOM")
            + "_"
            + safeReportFilenamePart(report.nickname || report.playerId, "PLAYER")
            + ".json",
        text: JSON.stringify(report, null, 2) + "\n",
        mimeType: "application/json"
    };
}

export function downloadPage5DeviceReport(report) {
    const output = formatPage5DeviceReportFile(report);
    if (!output || typeof document === "undefined"
        || typeof URL === "undefined"
        || typeof URL.createObjectURL !== "function"
        || typeof Blob === "undefined") {
        return false;
    }
    const blob = new Blob([output.text], { type: output.mimeType });
    const url = URL.createObjectURL(blob);
    try {
        const link = document.createElement("a");
        link.href = url;
        link.download = output.filename;
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        link.remove();
        return true;
    } finally {
        // Defer revocation until the WebView has had time to handle download.
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
}

export async function sharePage5DeviceReport(report, shareNavigator = navigator) {
    const output = formatPage5DeviceReportFile(report);
    if (!output || typeof File === "undefined" ||
        typeof shareNavigator?.share !== "function") return false;
    const file = new File([output.text], output.filename, {
        type: output.mimeType
    });
    if (typeof shareNavigator.canShare === "function"
        && !shareNavigator.canShare({ files: [file] })) return false;
    await shareNavigator.share({ files: [file], title: "WheelWin Page5 diagnostics" });
    return true;
}

export async function copyPage5DeviceReport(report, browserNavigator = navigator) {
    const output = formatPage5DeviceReportFile(report);
    if (!output) return false;
    if (typeof browserNavigator?.clipboard?.writeText === "function") {
        await browserNavigator.clipboard.writeText(output.text);
        return true;
    }
    if (typeof document === "undefined" ||
        typeof document.execCommand !== "function") return false;
    const input = document.createElement("textarea");
    input.value = output.text;
    input.readOnly = true;
    input.style.position = "fixed";
    input.style.left = "-9999px";
    document.body.appendChild(input);
    input.select();
    try {
        return document.execCommand("copy") === true;
    } finally {
        input.remove();
    }
}
