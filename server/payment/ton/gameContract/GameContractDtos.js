/**
 * T2.3 — Immutable Game Contract DTOs.
 */

export function createContractStateDTO({
    address,
    status,
    network,
    contractVersion = null,
    paidMask = 0,
    exists = true
}) {

    return Object.freeze({
        address,
        status,
        network,
        contractVersion,
        paidMask,
        exists
    });

}

export function createParticipantDTO({
    index,
    wallet,
    requiredAmount = null,
    paid = false,
    paymentReference = null
}) {

    return Object.freeze({
        index,
        wallet,
        requiredAmount,
        paid,
        paymentReference
    });

}

export function createSettlementDTO({
    address,
    status,
    winnerWallet = null,
    winnerAmount = null,
    organizerAmount = null,
    settlementTxHash = null
}) {

    return Object.freeze({
        address,
        status,
        winnerWallet,
        winnerAmount,
        organizerAmount,
        settlementTxHash
    });

}

export function createBalanceDTO({
    address,
    tonBalance = 0n,
    jettonBalance = 0n,
    currency = null
}) {

    return Object.freeze({
        address,
        tonBalance,
        jettonBalance,
        currency
    });

}

export function createArchiveDTO({
    address,
    archived,
    archivedAt = null,
    archiveReason = null
}) {

    return Object.freeze({
        address,
        archived: archived === true,
        archivedAt,
        archiveReason
    });

}

export function createWinnerDTO({
    address,
    winnerWallet = null,
    winnerPlayerIdHash = null
}) {

    return Object.freeze({
        address,
        winnerWallet,
        winnerPlayerIdHash
    });

}

export function createDeployResultDTO({
    ok,
    contractAddress = null,
    deploymentTxId = null,
    deployedAt = null,
    snapshotHash = null,
    reason = null
}) {

    return Object.freeze({
        ok: ok === true,
        contractAddress,
        deploymentTxId,
        deployedAt,
        snapshotHash,
        reason
    });

}

export function createOperationResultDTO({
    ok,
    txId = null,
    completedAt = null,
    reason = null
}) {

    return Object.freeze({
        ok: ok === true,
        txId,
        completedAt,
        reason
    });

}
