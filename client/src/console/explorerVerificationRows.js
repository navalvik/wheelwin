/**
 * R18.S125 — Pure row mapper for the display-only operator Explorer
 * verification block served on `/console/history/:sessionId`
 * (`operatorExplorerVerification`).
 *
 * DISPLAY-ONLY: produces plain rows for the History panel. Never fetches the
 * Explorer, never feeds authorization, and never mutates the input.
 */

function httpsUrlOrNull(value) {

    const text = String(value ?? "").trim();

    return text.startsWith("https://") ? text : null;

}

function textOrNull(value) {

    const text = String(value ?? "").trim();

    return text ? text : null;

}

/**
 * @param {object|null} operatorExplorerVerification
 * @returns {Array<{key: string, kind: string, label: string, hash: string,
 *   url: string|null, source: string|null, destination: string|null,
 *   amount: unknown}>}
 */
export function buildExplorerVerificationRows(operatorExplorerVerification) {

    const block = operatorExplorerVerification;

    if (!block || typeof block !== "object") {

        return [];

    }

    const transactions = Array.isArray(block.transactions)
        ? block.transactions
        : [];

    const rows = [];

    for (const transaction of transactions) {

        if (!transaction || typeof transaction !== "object") {

            continue;

        }

        const hash = textOrNull(transaction.transactionHash);

        if (!hash) {

            continue;

        }

        rows.push({
            key: `${textOrNull(transaction.kind) ?? "TRANSACTION"}:${hash}`,
            kind: textOrNull(transaction.kind) ?? "TRANSACTION",
            label: textOrNull(transaction.label) ?? "Transaction",
            hash,
            url: httpsUrlOrNull(transaction.explorerTransactionUrl),
            source: textOrNull(transaction.source),
            destination: textOrNull(transaction.destination),
            amount: transaction.amount ?? null
        });

    }

    return rows;

}
