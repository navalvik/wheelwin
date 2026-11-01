import { MAINNET_GLOBAL_ID } from "../config/MainnetRuntimeConfig.js";
import { mainnetAddressIdentity } from "./MainnetAddress.js";

function addressIdentityOrNull(address) {
    try { return mainnetAddressIdentity(address); } catch { return null; }
}

function addressesEqual(left, right) {
    const a = addressIdentityOrNull(left);
    return a !== null && a === addressIdentityOrNull(right);
}

function parseAmount(value) {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
    const amount = BigInt(value);
    return amount > 0n && amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}

function mapOutputs(row, sourceWalletAddress) {
    if (!row || typeof row.hash !== "string" || !row.hash.trim()
        || !addressesEqual(row.account, sourceWalletAddress)
        || row.description?.aborted !== false
        || row.description?.action?.success !== true
        || !Array.isArray(row.out_msgs)) return [];
    const outputs = [];
    for (const message of row.out_msgs) {
        if (!message || !addressesEqual(message.source, sourceWalletAddress)
            || message.bounced === true || addressIdentityOrNull(message.destination) === null) continue;
        const amountAtomic = parseAmount(message.value);
        if (amountAtomic === null) continue;
        outputs.push(Object.freeze({ transactionId: row.hash, sourceAddress: row.account,
            destinationAddress: message.destination, amountAtomic }));
    }
    return outputs;
}

/** Mainnet read-only counterpart of ToncenterTestnetOutgoingTransferProvider. */
export class MainnetToncenterOutgoingTransferObserver {
    constructor({ client, nowProvider = Date.now, lookbackMs = 7 * 24 * 60 * 60 * 1000,
        pageSize = 1000, maxPages = 5 } = {}) {
        if (typeof client?.getTransactions !== "function"
            || typeof client?.getMasterchainInfo !== "function"
            || typeof nowProvider !== "function"
            || !Number.isSafeInteger(lookbackMs) || lookbackMs <= 0
            || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000
            || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 50) {
            throw new TypeError("Mainnet outgoing history observer requires a bounded Mainnet read client");
        }
        this._client = client;
        this._now = nowProvider;
        this._window = lookbackMs;
        this._pageSize = pageSize;
        this._maxPages = maxPages;
    }

    async _history(sourceWalletAddress, { minCreatedAtMs = null } = {}) {
        if (addressIdentityOrNull(sourceWalletAddress) === null) {
            throw new Error("MAINNET_OUTGOING_SOURCE_ADDRESS_INVALID");
        }
        const nowMs = this._now();
        if (!Number.isSafeInteger(nowMs) || nowMs < this._window) {
            throw new Error("MAINNET_OUTGOING_HISTORY_TIME_INVALID");
        }
        if (minCreatedAtMs !== null && (!Number.isSafeInteger(minCreatedAtMs)
            || minCreatedAtMs < 0 || minCreatedAtMs > nowMs)) {
            throw new Error("MAINNET_OUTGOING_HISTORY_START_INVALID");
        }
        const minStartMs = minCreatedAtMs === null ? nowMs - this._window : minCreatedAtMs;
        const rows = [];
        const unique = new Set();
        for (let page = 0; page < this._maxPages; page++) {
            const response = await this._client.getTransactions({
                account: sourceWalletAddress,
                startUtime: Math.floor(minStartMs / 1000),
                endUtime: Math.floor(nowMs / 1000),
                limit: this._pageSize,
                offset: page * this._pageSize
            });
            const batch = response?.transactions;
            if (!Array.isArray(batch) || batch.length > this._pageSize) {
                throw new Error("MAINNET_OUTGOING_TRANSACTIONS_UNAVAILABLE");
            }
            for (const row of batch) {
                if (typeof row?.hash !== "string" || !row.hash) {
                    throw new Error("MAINNET_OUTGOING_HISTORY_MALFORMED");
                }
                if (unique.has(row.hash)) throw new Error("MAINNET_OUTGOING_HISTORY_PAGE_DRIFT");
                unique.add(row.hash);
                if (minCreatedAtMs === null || (Number.isSafeInteger(row.now)
                    && row.now >= Math.floor(minCreatedAtMs / 1000))) rows.push(row);
            }
            if (batch.length < this._pageSize) return rows;
        }
        throw new Error("MAINNET_OUTGOING_HISTORY_INCOMPLETE");
    }

    async observeRecipientCredit({ sourceWalletAddress, destinationIdentity, transactionId,
        amountAtomic, minCreatedAtMs = null } = {}) {
        if (typeof transactionId !== "string" || !transactionId.trim()
            || addressIdentityOrNull(sourceWalletAddress) === null
            || addressIdentityOrNull(destinationIdentity) === null
            || !Number.isSafeInteger(amountAtomic) || amountAtomic <= 0) return null;
        const [sourceRows, recipientRows] = await Promise.all([
            this._history(sourceWalletAddress, { minCreatedAtMs }),
            this._history(destinationIdentity, { minCreatedAtMs })
        ]);
        const sourceTx = sourceRows.filter(row => row.hash === transactionId
            && row.description?.aborted === false
            && row.description?.action?.success === true
            && addressesEqual(row.account, sourceWalletAddress)
            && Array.isArray(row.out_msgs) && row.out_msgs.length === 1);
        if (sourceTx.length !== 1) return null;
        const message = sourceTx[0].out_msgs[0];
        if (typeof message?.hash !== "string" || !message.hash.trim()
            || !addressesEqual(message.source, sourceWalletAddress)
            || !addressesEqual(message.destination, destinationIdentity)
            || parseAmount(message.value) !== amountAtomic || message.bounced === true) return null;
        const matches = recipientRows.filter(row => typeof row.hash === "string" && row.hash.trim() !== ""
            && addressesEqual(row.account, destinationIdentity)
            && row.description?.aborted === false
            && row.in_msg?.hash === message.hash
            && addressesEqual(row.in_msg?.source, sourceWalletAddress)
            && addressesEqual(row.in_msg?.destination, destinationIdentity)
            && parseAmount(row.in_msg?.value) === amountAtomic
            && row.in_msg?.bounced !== true);
        if (matches.length !== 1) return null;
        return Object.freeze({
            status: "RECIPIENT_CREDIT_OBSERVED_UNFINALIZED",
            sourceTransactionId: transactionId,
            recipientTransactionId: matches[0].hash,
            messageHash: message.hash,
            sourceWalletAddress,
            destinationAddress: destinationIdentity,
            amountAtomic,
            sourceIndex: Object.freeze({ mcBlockSeqno: sourceTx[0].mc_block_seqno ?? null,
                blockRef: sourceTx[0].block_ref ?? null, emulated: sourceTx[0].emulated ?? null,
                finality: sourceTx[0].finality ?? null }),
            recipientIndex: Object.freeze({ mcBlockSeqno: matches[0].mc_block_seqno ?? null,
                blockRef: matches[0].block_ref ?? null, emulated: matches[0].emulated ?? null,
                finality: matches[0].finality ?? null })
        });
    }

    async verifyIndexedRecipientCredit(query = {}) {
        const observed = await this.observeRecipientCredit(query);
        if (!observed) return null;
        const validBlock = (index) => Number.isSafeInteger(index?.mcBlockSeqno)
            && index.mcBlockSeqno > 0 && index.emulated !== true
            && (index.finality === 2 || index.finality === "finalized")
            && index.blockRef?.workchain === 0
            && Number.isSafeInteger(index.blockRef.seqno) && index.blockRef.seqno > 0
            && typeof index.blockRef.shard === "string" && index.blockRef.shard.length > 0;
        if (!validBlock(observed.sourceIndex) || !validBlock(observed.recipientIndex)) return null;
        const info = await this._client.getMasterchainInfo();
        const latest = info?.last;
        if (latest?.global_id !== MAINNET_GLOBAL_ID || !Number.isSafeInteger(latest.seqno)
            || latest.seqno <= observed.sourceIndex.mcBlockSeqno
            || latest.seqno <= observed.recipientIndex.mcBlockSeqno) return null;
        return Object.freeze({
            status: "MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED",
            sourceTransactionId: observed.sourceTransactionId,
            recipientTransactionId: observed.recipientTransactionId,
            messageHash: observed.messageHash,
            sourceWalletAddress: observed.sourceWalletAddress,
            destinationAddress: observed.destinationAddress,
            amountAtomic: observed.amountAtomic,
            sourceMcBlockSeqno: observed.sourceIndex.mcBlockSeqno,
            recipientMcBlockSeqno: observed.recipientIndex.mcBlockSeqno,
            sourceBlockRef: Object.freeze({ ...observed.sourceIndex.blockRef }),
            recipientBlockRef: Object.freeze({ ...observed.recipientIndex.blockRef }),
            latestIndexedMcBlockSeqno: latest.seqno,
            globalId: MAINNET_GLOBAL_ID,
            sourceFinality: "finalized",
            recipientFinality: "finalized"
        });
    }

    async getOutgoingTransfer({ sourceWalletAddress, transactionId, minCreatedAtMs = null } = {}) {
        if (typeof transactionId !== "string" || !transactionId.trim()) return null;
        const transactions = await this._history(sourceWalletAddress, { minCreatedAtMs });
        const rows = transactions.filter(row => row.hash === transactionId);
        if (rows.length !== 1) return null;
        const outputs = mapOutputs(rows[0], sourceWalletAddress);
        return outputs.length === 1 ? outputs[0] : null;
    }

    async findOutgoingTransfer({ sourceWalletAddress, destinationIdentity, amountAtomic,
        minCreatedAtMs = null } = {}) {
        if (addressIdentityOrNull(destinationIdentity) === null
            || !Number.isSafeInteger(amountAtomic) || amountAtomic <= 0) return null;
        const transactions = await this._history(sourceWalletAddress, { minCreatedAtMs });
        const matches = [];
        for (const row of transactions) {
            const outputs = mapOutputs(row, sourceWalletAddress);
            if (outputs.length !== 1) continue;
            const output = outputs[0];
            if (output.amountAtomic === amountAtomic
                && addressesEqual(output.destinationAddress, destinationIdentity)) matches.push(output);
        }
        if (matches.length !== 1) return matches.length > 1 ? Object.freeze({ ambiguous: true }) : null;
        return matches[0];
    }
}
