/**
 * R17.8V.2P.Q — Deep scan of Reimbursement Wallet transactions only.
 * No Owner / Deploy wallet history. No signing.
 */

import { reimbursementAddressesEqual } from "./ReimbursementWalletConfig.js";
import { tonStringToNanoton } from "./nanoton.js";
import {
    extractReimbursementTransferFromTransaction,
    transactionHashOf
} from "./extractReimbursementTransferFromTransaction.js";

/**
 * @param {object} tx
 * @returns {string|null}
 */
function transactionLt(tx) {

    const lt = tx?.transaction_id?.lt ?? tx?.lt ?? null;

    return lt == null ? null : String(lt);

}

export class ReimbursementTransactionScanner {

    /**
     * @param {{
     *   transport?: { getTransactions: Function }|null,
     *   logger?: object|null,
     *   pageSize?: number,
     *   maxPages?: number
     * }} [options]
     */
    constructor({
        transport = null,
        logger = null,
        pageSize = 40,
        maxPages = 25
    } = {}) {

        this._transport = transport;
        this._logger = logger;
        this._pageSize = Math.max(1, Number(pageSize) || 40);
        this._maxPages = Math.max(1, Number(maxPages) || 25);

    }

    /**
     * Paginated historical fetch from reimbursement wallet only.
     *
     * @param {string} walletAddress
     * @param {{ maxPages?: number, pageSize?: number }} [options]
     * @returns {Promise<object[]>}
     */
    async scanTransactions(walletAddress, options = {}) {

        const wallet = String(walletAddress ?? "").trim();

        if (!wallet || !this._transport?.getTransactions) {

            return [];

        }

        const maxPages = Number.isFinite(Number(options.maxPages))
            ? Math.max(1, Number(options.maxPages))
            : this._maxPages;
        const pageSize = Number.isFinite(Number(options.pageSize))
            ? Math.max(1, Number(options.pageSize))
            : this._pageSize;

        const collected = [];
        const seen = new Set();
        let lt = null;
        let hash = null;

        for (let page = 0; page < maxPages; page += 1) {

            const query = {
                limit: pageSize,
                archival: true
            };

            if (lt != null && hash != null) {

                query.lt = lt;
                query.hash = hash;

            }

            const batch = await this._transport.getTransactions(wallet, query);
            const list = Array.isArray(batch) ? batch : [];

            if (list.length === 0) {

                break;

            }

            let added = 0;

            for (const tx of list) {

                const txHash = transactionHashOf(tx);

                if (!txHash || seen.has(txHash)) {

                    continue;

                }

                seen.add(txHash);
                collected.push(tx);
                added += 1;

            }

            const last = list[list.length - 1];
            const nextLt = transactionLt(last);
            const nextHash = transactionHashOf(last);

            if (!nextLt || !nextHash || list.length < pageSize) {

                break;

            }

            // Avoid infinite loop on transports that ignore lt/hash.
            if (lt === nextLt && hash === nextHash) {

                break;

            }

            lt = nextLt;
            hash = nextHash;

            if (added === 0) {

                break;

            }

        }

        this._logger?.debug?.(
            `ReimbursementTransactionScanner scanned=${collected.length} | wallet=${wallet}`
        );

        return collected;

    }

    /**
     * @param {string} walletAddress
     * @param {string} txHash
     * @param {object} [options]
     * @returns {Promise<object|null>}
     */
    async findByTxHash(walletAddress, txHash, options = {}) {

        const expected = String(txHash ?? "").trim();

        if (!expected) {

            return null;

        }

        const txs = await this.scanTransactions(walletAddress, options);

        return txs.find((tx) => transactionHashOf(tx) === expected) ?? null;

    }

    /**
     * Recover a missing broadcast hash by matching outgoing transfer economics.
     *
     * @param {{
     *   walletAddress: string,
     *   deployWallet: string,
     *   amountTon: string,
     *   processedAt?: number|null,
     *   windowMs?: number
     * }} input
     * @param {object} [options]
     * @returns {Promise<{ ok: true, tx: object, txHash: string }
     *   | { ok: false, reason: string }>}
     */
    async findOutgoingTransfer(input, options = {}) {

        const walletAddress = String(input?.walletAddress ?? "").trim();
        const deployWallet = String(input?.deployWallet ?? "").trim();
        const amountTon = String(input?.amountTon ?? "").trim();
        const amountNano = tonStringToNanoton(amountTon);

        if (!walletAddress || !deployWallet || amountNano == null) {

            return { ok: false, reason: "invalid_recovery_query" };

        }

        const processedAt = Number(input?.processedAt);
        const windowMs = Number.isFinite(Number(input?.windowMs))
            ? Math.max(60_000, Number(input.windowMs))
            : 30 * 60_000;

        const txs = await this.scanTransactions(walletAddress, options);

        for (const tx of txs) {

            const txHash = transactionHashOf(tx);

            if (!txHash) {

                continue;

            }

            if (Number.isFinite(processedAt)) {

                const utime = Number(tx.utime ?? tx.now ?? 0) * 1000;

                if (
                    Number.isFinite(utime)
                    && utime > 0
                    && (
                        utime < processedAt - windowMs
                        || utime > processedAt + windowMs
                    )
                ) {

                    continue;

                }

            }

            const extracted = extractReimbursementTransferFromTransaction(tx, {
                txHash,
                deployWallet,
                amountTon,
                reimbursementWallet: walletAddress
            });

            if (!extracted.ok) {

                continue;

            }

            // Extra destination guard (string / address equality).
            if (
                !reimbursementAddressesEqual(
                    extracted.matchedDestination,
                    deployWallet
                )
            ) {

                continue;

            }

            return {
                ok: true,
                tx,
                txHash
            };

        }

        return { ok: false, reason: "outgoing_transfer_not_found" };

    }

}
