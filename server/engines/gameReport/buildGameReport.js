import { randomBytes } from "node:crypto";

import { GAME_STATES } from "../gameState/GameStates.js";

const RADIANS_TO_DEGREES = 180 / Math.PI;

function pad2(value) {

    return String(value).padStart(2, "0");

}

/**
 * Unique report id: report_YYYYMMDD_HHMMSS_<7 hex>
 */
export function createGameReportId(createdAt = Date.now()) {

    const date = new Date(createdAt);

    const stamp = [
        date.getUTCFullYear(),
        pad2(date.getUTCMonth() + 1),
        pad2(date.getUTCDate()),
        "_",
        pad2(date.getUTCHours()),
        pad2(date.getUTCMinutes()),
        pad2(date.getUTCSeconds())
    ].join("");

    const suffix = randomBytes(4).toString("hex").slice(0, 7);

    return `report_${stamp}_${suffix}`;

}

function resolveColorLabel(colorId, catalogColors) {

    if (colorId == null || colorId === "") {

        return null;

    }

    const entry = (catalogColors ?? []).find(
        (color) => color.id === colorId || color.label === colorId
    );

    return entry?.label ?? String(colorId);

}

function resolveGameTiming(gameStateHistory, fallbackFinishAt) {

    const history = Array.isArray(gameStateHistory) ? gameStateHistory : [];

    const startEntry = history.find((entry) => entry?.state === GAME_STATES.READY)
        ?? history[0]
        ?? null;

    const finishEntry = [...history]
        .reverse()
        .find((entry) => entry?.state === GAME_STATES.RESULT)
        ?? history[history.length - 1]
        ?? null;

    const gameStartTime = Number.isFinite(startEntry?.enteredAt)
        ? startEntry.enteredAt
        : null;

    const gameFinishTime = Number.isFinite(finishEntry?.enteredAt)
        ? finishEntry.enteredAt
        : (Number.isFinite(fallbackFinishAt) ? fallbackFinishAt : null);

    const gameDurationMs = Number.isFinite(gameStartTime)
        && Number.isFinite(gameFinishTime)
        && gameFinishTime >= gameStartTime
        ? gameFinishTime - gameStartTime
        : null;

    return {
        gameStartTime,
        gameFinishTime,
        gameDurationMs
    };

}

function deepFreeze(value) {

    if (!value || typeof value !== "object" || Object.isFrozen(value)) {

        return value;

    }

    for (const key of Object.keys(value)) {

        deepFreeze(value[key]);

    }

    return Object.freeze(value);

}

/**
 * Builds the permanent authoritative Game Report from a frozen audit report
 * plus optional player identity snapshots. No financial values are recomputed —
 * amounts are copied from PaymentEngine / configuration facts only.
 */
export function buildGameReport({
    auditReport,
    auditId = null,
    playerIdentities = {},
    sessionWallets = {},
    catalogColors = [],
    serverVersion = null,
    createdAt = Date.now()
}) {

    if (!auditReport?.gameId) {

        throw new Error("Cannot build Game Report without an audit report");

    }

    const configuration = auditReport.configuration ?? {};

    const payment = auditReport.payment ?? {};

    const winner = auditReport.winner ?? {};

    const winningPlayer = winner.winningPlayer ?? null;

    const winningSector = winner.winningSector ?? null;

    const configSector = Array.isArray(configuration.sectors)
        ? configuration.sectors.find(
            (sector) => sector.sectorId === winningSector?.sectorId
        )
        : null;

    const winningColorId = configSector?.colorId
        ?? winningSector?.colorId
        ?? winningPlayer?.color
        ?? null;

    const winnerId = winningPlayer?.playerId
        ?? winner.winnerPlayerId
        ?? payment.winnerId
        ?? null;

    const contributions = Array.isArray(payment.metadata?.playerContributions)
        ? payment.metadata.playerContributions
        : [];

    const contributionByPlayer = new Map(
        contributions.map((entry) => [entry.playerId, entry.contribution])
    );

    const timing = resolveGameTiming(
        auditReport.gameStateHistory,
        payment.processedAt ?? auditReport.createdAt ?? createdAt
    );

    const finalAngleRadians = winner.finalAngle
        ?? winner.wheelFinalAngle
        ?? null;

    const finalWheelAngleDegrees = Number.isFinite(finalAngleRadians)
        ? Number((finalAngleRadians * RADIANS_TO_DEGREES).toFixed(4))
        : null;

    const players = (configuration.players ?? []).map((player, index) => {

        const playerId = player.playerId;

        const identity = playerIdentities[playerId] ?? {};

        const amountPaid = contributionByPlayer.has(playerId)
            ? contributionByPlayer.get(playerId)
            : null;

        const isWinner = winnerId != null
            && String(playerId) === String(winnerId);

        const colorIds = Array.isArray(player.colors)
            ? player.colors
            : (player.color ? [player.color] : []);

        return {
            index: index + 1,
            nickname: player.nickname
                ?? identity.nickname
                ?? null,
            playerId,
            icon: player.icon ?? identity.icon ?? null,
            sectorCount: player.sectorCount ?? null,
            sectorColors: colorIds.map(
                (colorId) => resolveColorLabel(colorId, catalogColors)
            ),
            baseStake: configuration.stake ?? identity.baseStake ?? null,
            amountPaid,
            walletAddress: sessionWallets?.[playerId]
                ?? identity.wallet
                ?? null,
            result: isWinner ? "WINNER" : "LOSER",
            prizeReceived: isWinner
                ? (payment.winnerAmount ?? null)
                : 0
        };

    });

    const reportId = createGameReportId(createdAt);

    const report = {
        reportId,
        gameId: auditReport.gameId,
        roomId: configuration.metadata?.roomId ?? null,
        auditTraceId: auditId
            ?? auditReport.metadata?.traceSeed
            ?? configuration.traceSeed
            ?? null,
        gameStartTime: timing.gameStartTime,
        gameFinishTime: timing.gameFinishTime,
        gameDurationMs: timing.gameDurationMs,
        serverTimestamp: createdAt,
        finalWheelAngle: finalWheelAngleDegrees,
        winningSector: {
            sectorId: winningSector?.sectorId ?? null,
            index: winningSector?.index ?? null,
            color: winningSector?.color ?? configSector?.color ?? null,
            colorId: winningColorId,
            icon: winningSector?.icon ?? configSector?.icon ?? null
        },
        winningColor: resolveColorLabel(winningColorId, catalogColors),
        winningIcon: winningSector?.icon
            ?? configSector?.icon
            ?? winningPlayer?.icon
            ?? null,
        winningPlayer: {
            playerId: winnerId,
            nickname: winningPlayer?.nickname
                ?? players.find((entry) => entry.playerId === winnerId)?.nickname
                ?? null,
            color: winningPlayer?.color ?? null,
            icon: winningPlayer?.icon ?? null
        },
        winnerPayout: payment.winnerAmount ?? null,
        wheelWinCommission: payment.platformFee ?? null,
        totalPrizePool: payment.totalPrize ?? null,
        baseStake: configuration.stake ?? null,
        totalSectorCount: Array.isArray(configuration.sectors)
            ? configuration.sectors.length
            : null,
        gameVersion: configuration.configurationVersion
            ?? auditReport.metadata?.configurationVersion
            ?? null,
        serverVersion,
        currency: payment.metadata?.currency ?? "GRM",
        players,
        // Reserved for future TON / SHA-256 integration (not computed yet).
        blockchain: {
            reportHash: null,
            hashAlgorithm: "SHA-256",
            smartContractAddress: null,
            tonTransactionHash: null,
            blockchainConfirmationTimestamp: null,
            digitalSignature: null
        }
    };

    return deepFreeze(report);

}

/**
 * Deterministic human-readable rendering of an authoritative Game Report.
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
