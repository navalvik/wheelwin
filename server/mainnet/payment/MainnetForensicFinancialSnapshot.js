import { MAINNET_GLOBAL_ID } from "../config/MainnetRuntimeConfig.js";

/** Select the existing shared archive pipeline's network-bound source/key. */
export function resolveFinancialArchiveRuntimeBinding({
    paymentMode,
    archiveConfig,
    testnetRuntime = null,
    mainnetRuntime = null
} = {}) {
    if ((paymentMode !== "testnet" && paymentMode !== "mainnet")
        || !archiveConfig || typeof archiveConfig !== "object") {
        throw new Error("FORENSIC_ARCHIVE_NETWORK_BINDING_INVALID");
    }
    if (paymentMode === "mainnet") {
        return Object.freeze({
            config: Object.freeze({ ...archiveConfig, prefix: "mainnet" }),
            financialSnapshotProvider: roomId => mainnetRuntime?.financialSnapshot(roomId)
        });
    }
    return Object.freeze({
        config: archiveConfig,
        financialSnapshotProvider: roomId => testnetRuntime?.financialSnapshot(roomId)
    });
}

/**
 * Adapt the isolated Mainnet ledgers to the financialSnapshot(roomId)
 * contract consumed by the shared forensic collector and finality gate.
 * This is a read-only projection; it never changes either ledger.
 */
export function createMainnetForensicFinancialSnapshot({ roomId, incomingLedger, financialLedger } = {}) {
    if (typeof roomId !== "string" || !roomId
        || incomingLedger?.network !== "mainnet" || incomingLedger?.globalId !== MAINNET_GLOBAL_ID
        || financialLedger?.network !== "mainnet" || financialLedger?.globalId !== MAINNET_GLOBAL_ID
        || typeof incomingLedger.listRoomIntents !== "function"
        || typeof incomingLedger.listReceipts !== "function"
        || typeof incomingLedger.listObservations !== "function"
        || typeof financialLedger.getOutcome !== "function"
        || typeof financialLedger.listRefunds !== "function"
        || typeof financialLedger.listPayouts !== "function"
        || typeof financialLedger.countOpenObligations !== "function") {
        throw new Error("MAINNET_FORENSIC_SNAPSHOT_SOURCE_INVALID");
    }

    const intents = incomingLedger.listRoomIntents(roomId).map(intent => ({
        ...intent,
        amountAtomic: toSafeAtomic(intent.amountAtomic),
        transactionId: intent.confirmedTransactionId ?? null
    }));
    const receipts = incomingLedger.listReceipts(roomId).map(receipt => ({
        ...receipt,
        amountAtomic: toSafeAtomic(receipt.amountAtomic),
        paymentIntentId: receipt.paymentReference ?? null,
        senderAddress: receipt.sourceAddress ?? null,
        destinationWalletAddress: receipt.destinationAddress ?? null
    }));
    const paymentObservations = incomingLedger.listObservations(roomId).map(observation => ({
        ...observation,
        ...(observation.amountAtomic !== undefined
            ? { amountAtomic: toSafeAtomic(observation.amountAtomic) } : {})
    }));
    const outcome = financialLedger.getOutcome(roomId);
    const refunds = financialLedger.listRefunds(roomId);
    const payouts = financialLedger.listPayouts().filter(payout => payout.roomId === roomId);
    const ledger = [];

    for (const intent of intents) {
        if (intent.state === "SETTLED") {
            ledger.push({ kind: "INCOMING_PRINCIPAL", roomId, amountAtomic: Number(intent.amountAtomic),
                metadata: { paymentReference: intent.paymentReference,
                    transactionId: intent.confirmedTransactionId } });
        }
    }
    for (const payout of payouts) {
        const transfers = [
            { recipientRole: "WINNER", recipientId: payout.winner.recipientId,
                address: payout.winner.address, grossAtomic: payout.winner.amountAtomic,
                reservedFeeAtomic: 0, netAtomic: payout.winner.amountAtomic, feeQuote: null },
            { recipientRole: "OWNER", recipientId: payout.owner.recipientId,
                address: payout.owner.address, grossAtomic: payout.owner.amountAtomic,
                reservedFeeAtomic: 0, netAtomic: payout.owner.amountAtomic, feeQuote: null }
        ];
        ledger.push({ kind: "PAYOUT_PLAN", roomId, amountAtomic: payout.principalAtomic,
            asset: "TON", network: "mainnet", metadata: { payoutId: payout.payoutId,
                plan: { payoutId: payout.payoutId, roomId, asset: "TON", network: "mainnet",
                    principalAtomic: payout.principalAtomic, allocation: payout.allocation,
                    gasReserveAtomic: payout.allocation.reserveAtomic,
                    safetyMarginAtomic: payout.allocation.reserveAtomic, transfers } } });
        for (const [role, leg] of [["WINNER", payout.winner], ["OWNER", payout.owner]]) {
            if (leg.state === "CONFIRMED") {
                ledger.push({ kind: "PAYOUT_SETTLEMENT", roomId, amountAtomic: leg.amountAtomic,
                    asset: "TON", network: "mainnet", metadata: {
                    payoutId: payout.payoutId, recipientId: leg.recipientId, role,
                    transactionId: leg.transactionId
                } });
            }
        }
    }

    const unresolvedReceipts = receipts.filter(receipt => receipt.status !== "CONFIRMED");
    const closedRoom = outcome?.kind === "REFUND" ? {
        roomId,
        roomNumber: outcome.roomNumber,
        closureReason: outcome.closureReason,
        closedAtMs: outcome.closedAtMs
    } : null;
    const payoutOutcome = outcome?.kind === "PAYOUT" ? {
        roomId, kind: "PAYOUT", createdAtMs: outcome.createdAtMs
    } : null;
    const refundOutcome = closedRoom ? {
        roomId, kind: "REFUND", reason: closedRoom.closureReason,
        createdAtMs: closedRoom.closedAtMs
    } : null;

    return {
        schemaVersion: 1,
        network: "mainnet",
        globalId: MAINNET_GLOBAL_ID,
        roomId,
        closedRoom,
        outcome: payoutOutcome ?? refundOutcome,
        intents,
        ledger,
        receipts,
        unresolvedReceipts,
        refunds,
        paymentObservations,
        paymentDecisions: [],
        outstandingObligations: financialLedger.countOpenObligations(roomId)
    };
}

function toSafeAtomic(value) {
    let amount;
    try { amount = BigInt(value); } catch { throw new Error("MAINNET_FORENSIC_AMOUNT_INVALID"); }
    if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("MAINNET_FORENSIC_AMOUNT_UNSAFE");
    }
    return Number(amount);
}
