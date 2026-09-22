/**
 * Sealed historical Room-Wallet settlement evidence.
 *
 * Used only when durable settlement persistence is absent after process
 * recycle. Values are incident-archive facts, not operator input.
 * Amounts are never independently recalculated here.
 */

export const UHQU_GAME_ID = "game_3618b43e-f127-4f8f-93ca-84eaa90f1345";

export const SEALED_TERMINAL_SETTLEMENT_EVIDENCE = Object.freeze({
    ["game_85589aab-d8d5-4f81-b937-a564ab465da5"]: Object.freeze({
        gameId: "game_85589aab-d8d5-4f81-b937-a564ab465da5",
        roomId: "96YF",
        roomNumber: 1,
        roomWalletAddress: "EQDGQjwaP0OSExa9MfZih61De5TQuUITQPYiYZyfqAFzpvQB",
        winnerId: "player_8b085a15-dc33-48ac-90f6-abb4a37ff4b5",
        winnerWallet: "0QAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHbypD",
        ownerWallet: "0QBaklBYMdMsuq7a2eTYhMkz1OF7ZSHaO1mnFd1MZd3YjC5t",
        winnerAmount: 5.7,
        organizerAmount: 0.3,
        originalStatus: "SETTLEMENT_FAILED",
        originalFailureReason: "contract_missing",
        playerInboundHashes: Object.freeze([
            "jt00MpeV4QGlNlCpJKj0bvdNKtvduMfgLMXHFpdXNcw=",
            "mYvy4pZyZ7xVbG1jsSFBPKijrz7Xv7Xcd13c33s/vjs=",
            "FSE2nCiuZj6UW3RELCyA3plIfjO0l+f5tnh1EA5jdbo="
        ]),
        source: "sealed_incident_archive"
    }),
    [UHQU_GAME_ID]: Object.freeze({
        gameId: UHQU_GAME_ID,
        roomId: "UhqU",
        roomNumber: 1,
        roomWalletAddress: "EQDGQjwaP0OSExa9MfZih61De5TQuUITQPYiYZyfqAFzpvQB",
        winnerId: "Olga",
        winnerWallet: "EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le",
        ownerWallet: "0QBaklBYMdMsuq7a2eTYhMkz1OF7ZSHaO1mnFd1MZd3YjC5t",
        winnerAmount: 2.85,
        organizerAmount: 0.15,
        originalStatus: "SETTLEMENT_FAILED",
        originalFailureReason: "adapter_threw:prizeAmount or prizeAmountNano is required",
        lastInboundLt: "94961158000003",
        lastInboundUtime: 1788765455,
        playerInboundHashes: Object.freeze([
            "36d92ec7f863e253ef8120813090f541369f1e156de46a6c9aed89885ce72cc8",
            "b002504070d935fbda5ccbef3c84a7a7605a02970195bf507ef4c1fb3555300b",
            "909aede3efc4ab629e664767728164752569f023e2021efbe7e1ad0103a3c04a"
        ]),
        source: "sealed_incident_archive"
    })
});

export function getSealedTerminalSettlementEvidence(gameId) {
    const key = String(gameId ?? "").trim();
    return SEALED_TERMINAL_SETTLEMENT_EVIDENCE[key] ?? null;
}
