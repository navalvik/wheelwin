/**
 * R7.66I — GameEscrow soak validation report (multi-lifecycle).
 */

/**
 * @returns {{
 *   network: string,
 *   mode: string,
 *   gamesCount: number,
 *   escrowAddresses: string[],
 *   settlementTxs: string[],
 *   payoutConfirmations: Array<{gameId: string, winnerPayoutTx: string|null, ownerPayoutTx: string|null}>,
 *   failures: Array<{gameId: string|null, reason: string}>,
 *   recovery: object|null,
 *   uniqueEscrows: boolean,
 *   duplicateSettlements: number,
 *   falseCompletions: number
 * }}
 */
export function createGameEscrowSoakReport(seed = {}) {

    return {
        network: seed.network ?? "testnet",
        mode: seed.mode ?? "game",
        gamesCount: Number(seed.gamesCount) || 0,
        escrowAddresses: Array.isArray(seed.escrowAddresses)
            ? [...seed.escrowAddresses]
            : [],
        settlementTxs: Array.isArray(seed.settlementTxs)
            ? [...seed.settlementTxs]
            : [],
        payoutConfirmations: Array.isArray(seed.payoutConfirmations)
            ? [...seed.payoutConfirmations]
            : [],
        failures: Array.isArray(seed.failures) ? [...seed.failures] : [],
        recovery: seed.recovery ?? null,
        uniqueEscrows: seed.uniqueEscrows !== false,
        duplicateSettlements: Number(seed.duplicateSettlements) || 0,
        falseCompletions: Number(seed.falseCompletions) || 0
    };

}

export function printGameEscrowSoakReport(report) {

    if (!report) {

        return;

    }

    console.log("======================================================");
    console.log("GameEscrow Soak validation");
    console.log("======================================================");
    console.log("network:", report.network);
    console.log("mode:", report.mode);
    console.log("games count:", report.gamesCount);
    console.log("escrow addresses:");

    for (const address of report.escrowAddresses) {

        console.log("  -", address);

    }

    console.log("settlement txs:");

    for (const tx of report.settlementTxs) {

        console.log("  -", tx);

    }

    console.log("payout confirmations:");

    for (const entry of report.payoutConfirmations) {

        console.log(
            "  -",
            entry.gameId,
            "winner=",
            entry.winnerPayoutTx,
            "owner=",
            entry.ownerPayoutTx
        );

    }

    console.log("unique escrows:", report.uniqueEscrows);
    console.log("duplicate settlements:", report.duplicateSettlements);
    console.log("false completions:", report.falseCompletions);
    console.log("failures:", report.failures.length);

    for (const failure of report.failures) {

        console.log("  -", failure.gameId ?? "(none)", failure.reason);

    }

    if (report.recovery) {

        console.log("recovery:", JSON.stringify(report.recovery));

    }

    console.log("======================================================");

}
