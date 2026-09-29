/**
 * R18.S125 — Operator Explorer verification projection for a session history
 * record (DISPLAY-ONLY).
 *
 * Consumed by the `/console/history/:sessionId` Developer Console route to
 * ATTACH (response-only, never persisted) an explicit operator verification
 * block that lists the transaction hashes ALREADY PRESENT in the immutable
 * session archive and pairs each one with an operator-facing TON Explorer
 * reference built by `server/payment/ton/networks/explorerReference.js`.
 *
 * Hard rules:
 * - Display-only. This module performs no network I/O and never reads
 *   Explorer data back into WheelWin.
 * - It NEVER participates in payout/refund authorization. The static flags
 *   `manualOnly`, `automatic: false`, `replacesTonCenterConfirmation: false`
 *   and `authorizesTransfers: false` are part of the contract so that no
 *   consumer can mistake Explorer data for an authorization mechanism.
 * - On-chain confirmation authority remains the configured TON Center RPC
 *   (`confirmPayoutOnChain` / toncenter endpoints).
 * - The immutable archive record is never mutated: the projection is attached
 *   to the HTTP response only.
 * - Defensive: malformed / partial records produce an empty transaction list
 *   instead of an error.
 */

import {
    buildOperatorExplorerTransactionUrl,
    resolveOperatorExplorerBaseUrl
} from "../../payment/ton/networks/explorerReference.js";

const MAX_TRANSACTIONS = 50;

const MANUAL_VERIFICATION_NOTE =
    "Explorer verification is a MANUAL operator step performed on the public "
    + "TON Explorer AFTER automated TON Center on-chain confirmation. It does "
    + "not replace TON Center verification, is never read back by WheelWin, "
    + "and is never used to authorize or gate transfers.";

const KIND_LABELS = Object.freeze({
    STAKE_PAYMENT: "Stake payment",
    DEPLOY: "Contract deploy",
    SETTLEMENT: "Settlement",
    REFUND: "Refund",
    REFUND_RECONCILIATION: "Refund (player-wallet reconciled)"
});

function asObject(value) {

    return value && typeof value === "object" ? value : null;

}

function asHash(value) {

    const text = String(value ?? "").trim();

    return /^[0-9a-fA-F]{64}$/.test(text) ? text.toLowerCase() : null;

}

function asText(value) {

    const text = String(value ?? "").trim();

    return text ? text : null;

}

function normalizeNetwork(networkId) {

    const key = String(networkId ?? "").trim().toLowerCase();

    return key === "testnet" || key === "mainnet" ? key : null;

}

function pushTransaction(transactions, seen, candidate) {

    const hash = candidate.transactionHash;

    if (!hash) {

        return;

    }

    const dedupeKey = `${candidate.kind}:${hash}`;

    if (seen.has(dedupeKey) || transactions.length >= MAX_TRANSACTIONS) {

        return;

    }

    seen.add(dedupeKey);

    transactions.push({
        kind: candidate.kind,
        label: KIND_LABELS[candidate.kind] ?? "Transaction",
        transactionHash: hash,
        explorerTransactionUrl: null,
        source: candidate.source ?? null,
        destination: candidate.destination ?? null,
        amount: candidate.amount ?? null,
        occurredAt: candidate.occurredAt ?? null
    });

}

function collectFromBlockchainLifecycle(blockchainLifecycle, seen, transactions) {

    const lifecycle = asObject(blockchainLifecycle);

    if (!lifecycle) {

        return;

    }

    // 1. Payment confirmation events (stake payments observed on-chain).
    const events = asObject(lifecycle.paymentConfirmation)?.events;

    if (Array.isArray(events)) {

        for (const event of events) {

            const entry = asObject(event);

            if (!entry) {

                continue;

            }

            pushTransaction(transactions, seen, {
                kind: "STAKE_PAYMENT",
                transactionHash: asHash(
                    entry.transactionHash ?? entry.txHash ?? entry.transactionId
                ),
                source: asText(entry.sender),
                destination: asText(entry.contractAddress ?? entry.escrowAddress),
                amount: entry.amount ?? entry.expectedGram ?? null,
                occurredAt: Number.isFinite(Number(entry.at))
                    ? Number(entry.at)
                    : null
            });

        }

    }

    // 2. Contract deploy (legacy GameEscrow path; absent on Room-Wallet-only).
    const deploy = asObject(lifecycle.deploy);

    if (deploy) {

        pushTransaction(transactions, seen, {
            kind: "DEPLOY",
            transactionHash: asHash(
                deploy.transactionHash ?? deploy.txHash ?? deploy.transactionId
            ),
            source: null,
            destination: asText(deploy.contractAddress),
            amount: null,
            occurredAt: null
        });

    }

    // 3. Settlement (winner/commission payout track).
    const settlement = asObject(lifecycle.settlement);

    if (settlement) {

        pushTransaction(transactions, seen, {
            kind: "SETTLEMENT",
            transactionHash: asHash(
                settlement.transactionHash
                    ?? settlement.settleTxHash
                    ?? settlement.txHash
            ),
            source: null,
            destination: asText(settlement.winnerWallet ?? settlement.commissionWallet),
            amount: settlement.winnerAmount ?? settlement.commissionAmount ?? null,
            occurredAt: null
        });

    }

}

function collectFromPaymentSection(payment, seen, transactions) {

    const paymentSection = asObject(payment);

    if (!paymentSection) {

        return;

    }

    // Defensive: the console room-detail projection omits participant tx
    // hashes today ("never include wallets / tx hashes"); if a future archive
    // ever carries them, they surface here as display-only rows. Refund
    // reconciliation metadata IS persisted on the payment session payload.
    const participants = paymentSection.participants;

    if (Array.isArray(participants)) {

        for (const participant of participants) {

            const entry = asObject(participant);

            if (!entry) {

                continue;

            }

            pushTransaction(transactions, seen, {
                kind: "STAKE_PAYMENT",
                transactionHash: asHash(
                    entry.txHash ?? entry.transactionHash ?? entry.transactionId
                ),
                source: asText(entry.wallet),
                destination: asText(entry.contractAddress),
                amount: entry.paidAmount ?? null,
                occurredAt: null
            });

            pushTransaction(transactions, seen, {
                kind: "REFUND",
                transactionHash: asHash(
                    entry.refundTxHash ?? entry.refundTransactionHash
                ),
                source: asText(paymentSection.roomWalletAddress),
                destination: asText(entry.wallet),
                amount: null,
                occurredAt: null
            });

        }

    }

    const reconciliations = asObject(paymentSection.recoveryMetadata)
        ?.refundReconciliations;

    if (Array.isArray(reconciliations)) {

        for (const reconciliation of reconciliations) {

            const entry = asObject(reconciliation);

            if (!entry) {

                continue;

            }

            pushTransaction(transactions, seen, {
                kind: "REFUND_RECONCILIATION",
                transactionHash: asHash(
                    entry.transactionHash ?? entry.txHash
                ),
                source: asText(paymentSection.roomWalletAddress),
                destination: asText(entry.wallet),
                amount: null,
                occurredAt: Number.isFinite(Number(entry.reconciledAt))
                    ? Number(entry.reconciledAt)
                    : null
            });

        }

    }

}

/**
 * Build the display-only operator Explorer verification block.
 *
 * @param {object|null} record Immutable session history archive record.
 * @param {{ applicationNetwork?: string|null }} [options]
 * @returns {object|null} verification block, or null when no record given.
 */
export function buildOperatorExplorerVerification(
    record,
    { applicationNetwork = null } = {}
) {

    const source = asObject(record);

    if (!source) {

        return null;

    }

    const network = normalizeNetwork(applicationNetwork);

    const explorerBaseUrl = network
        ? resolveOperatorExplorerBaseUrl(network)
        : null;

    const transactions = [];
    const seen = new Set();

    collectFromBlockchainLifecycle(
        source.blockchainLifecycle,
        seen,
        transactions
    );

    // `finalSnapshot.blockchainLifecycle` is a serialized copy of the same
    // lifecycle data — walked defensively; dedupe keeps the list clean.
    collectFromBlockchainLifecycle(
        asObject(source.finalSnapshot)?.blockchainLifecycle,
        seen,
        transactions
    );

    collectFromPaymentSection(source.payment, seen, transactions);
    collectFromPaymentSection(
        asObject(source.finalSnapshot)?.payment,
        seen,
        transactions
    );

    for (const transaction of transactions) {

        transaction.explorerTransactionUrl = buildOperatorExplorerTransactionUrl(
            network,
            transaction.transactionHash
        );

    }

    return Object.freeze({
        displayOnly: true,
        automatic: false,
        manualOnly: true,
        replacesTonCenterConfirmation: false,
        authorizesTransfers: false,
        network,
        explorerBaseUrl,
        verificationRequired: transactions.length > 0,
        note: MANUAL_VERIFICATION_NOTE,
        transactions: Object.freeze(transactions)
    });

}

