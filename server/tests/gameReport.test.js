import {
    buildGameReport,
    formatGameReportAsText
} from "../engines/gameReport/buildGameReport.js";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

const auditReport = {
    gameId: "game_test_r64",
    createdAt: Date.UTC(2026, 6, 22, 13, 24, 51),
    gameStateHistory: [
        { state: "READY", enteredAt: 1000 },
        { state: "RESULT", enteredAt: 5000 }
    ],
    configuration: {
        stake: 10,
        configurationVersion: "1.0",
        traceSeed: "trace_abc",
        metadata: { roomId: "room_1" },
        players: [
            {
                playerId: "p1",
                nickname: "Bob",
                sectorCount: 2,
                colors: ["ORANGE", "VIOLET"],
                icon: "frog",
                color: "ORANGE"
            },
            {
                playerId: "p2",
                nickname: "Lena",
                sectorCount: 2,
                colors: ["GREEN", "BLUE"],
                icon: "spade",
                color: "GREEN"
            },
            {
                playerId: "p3",
                nickname: "Ol4a",
                sectorCount: 1,
                colors: ["RED"],
                icon: "queen",
                color: "RED"
            }
        ],
        sectors: [
            {
                sectorId: "sector_0",
                color: "#e67e00",
                colorId: "ORANGE",
                icon: "frog"
            }
        ]
    },
    winner: {
        winningPlayer: {
            playerId: "p1",
            color: "ORANGE",
            icon: "frog",
            nickname: "Bob"
        },
        winningSector: {
            sectorId: "sector_0",
            index: 0,
            color: "#e67e00",
            icon: "frog"
        },
        finalAngle: Math.PI / 2,
        winnerPlayerId: "p1"
    },
    payment: {
        winnerId: "p1",
        totalPrize: 75,
        platformFee: 3.75,
        winnerAmount: 71.25,
        processedAt: 5000,
        metadata: {
            currency: "TON",
            playerContributions: [
                { playerId: "p1", contribution: 25 },
                { playerId: "p2", contribution: 25 },
                { playerId: "p3", contribution: 25 }
            ]
        }
    },
    metadata: {
        traceSeed: "trace_abc",
        configurationVersion: "1.0"
    }
};

const report = buildGameReport({
    auditReport,
    auditId: "audit_trace_abc_1",
    playerIdentities: {
        p1: { nickname: "Bob", wallet: "EQ_TEST_WALLET", baseStake: 10 },
        p2: { nickname: "Lena", wallet: null, baseStake: 10 },
        p3: { nickname: "Ol4a", wallet: null, baseStake: 10 }
    },
    catalogColors: [
        { id: "ORANGE", hex: "#e67e00", label: "Orange" },
        { id: "VIOLET", hex: "#8e44ad", label: "Violet" },
        { id: "GREEN", hex: "#00aa44", label: "Green" },
        { id: "BLUE", hex: "#1c73d0", label: "Blue" },
        { id: "RED", hex: "#d62828", label: "Red" }
    ],
    serverVersion: "1.0.0",
    createdAt: Date.UTC(2026, 6, 22, 13, 24, 51)
});

assert(report.reportId.startsWith("report_20260722_132451_"), "report id format");
assert(report.gameId === "game_test_r64", "game id");
assert(report.roomId === "room_1", "room id");
assert(report.auditTraceId === "audit_trace_abc_1", "audit id");
assert(report.winnerPayout === 71.25, "winner payout");
assert(report.wheelWinCommission === 3.75, "commission");
assert(report.totalPrizePool === 75, "prize pool");
assert(report.baseStake === 10, "base stake");
assert(report.totalSectorCount === 1, "sector count from config sectors array");
assert(report.players.length === 3, "three players");
assert(report.players[0].nickname === "Bob", "winner nickname");
assert(report.players[0].result === "WINNER", "winner result");
assert(report.players[0].prizeReceived === 71.25, "winner prize");
assert(report.players[0].amountPaid === 25, "winner paid");
assert(report.players[0].sectorColors[0] === "Orange", "color label");
assert(report.players[1].result === "LOSER", "loser result");
assert(report.players[1].prizeReceived === 0, "loser prize");
assert(report.blockchain.hashAlgorithm === "SHA-256", "hash reserved");
assert(report.blockchain.reportHash === null, "hash not computed yet");
assert(Object.isFrozen(report), "report frozen");

const text = formatGameReportAsText(report);

assert(text.includes("WHEELWIN GAME REPORT"), "text header");
assert(text.includes("Bob"), "text includes nickname");
assert(text.includes("71.25 GRM"), "text includes payout");

console.log("gameReport.test.js: all assertions passed");
console.log(`  reportId=${report.reportId}`);
