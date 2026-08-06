/**
 * R7.66H — GameEscrow end-to-end lifecycle diagnostics report.
 */

/**
 * @returns {{
 *   gameId: string|null,
 *   escrowAddress: string|null,
 *   deployTx: string|null,
 *   initTx: string|null,
 *   settleTx: string|null,
 *   winnerPayoutTx: string|null,
 *   ownerPayoutTx: string|null,
 *   finalStatus: string|null,
 *   network: string|null,
 *   mode: string|null,
 *   stages: string[],
 *   settlementCompleted: boolean
 * }}
 */
export function createGameEscrowE2EReport(seed = {}) {

    return {
        gameId: seed.gameId ?? null,
        escrowAddress: seed.escrowAddress ?? null,
        deployTx: seed.deployTx ?? null,
        initTx: seed.initTx ?? null,
        settleTx: seed.settleTx ?? null,
        winnerPayoutTx: seed.winnerPayoutTx ?? null,
        ownerPayoutTx: seed.ownerPayoutTx ?? null,
        finalStatus: seed.finalStatus ?? null,
        network: seed.network ?? "testnet",
        mode: seed.mode ?? "game",
        stages: Array.isArray(seed.stages) ? [...seed.stages] : [],
        settlementCompleted: seed.settlementCompleted === true
    };

}

export function pushGameEscrowE2EStage(report, stage) {

    if (!report || !stage) {

        return report;

    }

    if (!report.stages.includes(stage)) {

        report.stages.push(stage);

    }

    return report;

}

export function printGameEscrowE2EReport(report) {

    if (!report) {

        return;

    }

    console.log("======================================================");
    console.log("GameEscrow E2E lifecycle");
    console.log("======================================================");
    console.log("gameId:", report.gameId);
    console.log("escrowAddress:", report.escrowAddress);
    console.log("deployTx:", report.deployTx);
    console.log("initTx:", report.initTx);
    console.log("settleTx:", report.settleTx);
    console.log("winner payout tx:", report.winnerPayoutTx);
    console.log("owner payout tx:", report.ownerPayoutTx);
    console.log("final status:", report.finalStatus);
    console.log("network:", report.network);
    console.log("mode:", report.mode);
    console.log("stages:", report.stages.join(" → "));
    console.log("settlementCompleted:", report.settlementCompleted);
    console.log("======================================================");

}
