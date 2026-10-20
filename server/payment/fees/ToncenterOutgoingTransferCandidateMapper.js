/**
 * Read-only mapper for a candidate outgoing TON transfer from a room wallet.
 *
 * This module deliberately does NOT authorize a payout/refund. A matching
 * transaction row proves only that the provider returned a structurally
 * matching candidate. Wallet seqno binding and independent finality evidence
 * are separate mandatory gates and are not represented as successful here.
 */
import { ToncenterResponseError } from "../toncenter/ToncenterErrors.js";
import { tonAddressIdentitiesEqual, tonAddressIdentityOrNull } from "../incoming/TonAddressIdentity.js";

function nonEmpty(value) {
    return typeof value === "string" && value.trim() !== "";
}

function atomicString(value, field) {
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
        throw new ToncenterResponseError(`Outgoing transaction has invalid ${field}`);
    }
    const amount = BigInt(value);
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new ToncenterResponseError(`Outgoing transaction ${field} exceeds safe integer range`);
    }
    return Number(amount);
}

function successfulTransaction(transaction) {
    if (transaction?.emulated === true || transaction?.description?.aborted === true) return false;
    if (transaction?.description?.compute_ph?.success === false) return false;
    if (transaction?.description?.action?.success === false) return false;
    return true;
}

/**
 * Match one provider transaction row against a server-created operation.
 *
 * @param {object} transaction Toncenter v3 transaction row
 * @param {{sourceWalletAddress:string,destination:string,amountAtomic:number,transactionId:string}} expected
 * @returns {Readonly<object>|null} Candidate observation; never finality proof.
 */
export function mapOutgoingTransferCandidate(transaction, expected) {
    if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) {
        throw new ToncenterResponseError("Outgoing transaction row must be an object");
    }
    if (!expected || !nonEmpty(expected.sourceWalletAddress)
        || !nonEmpty(expected.destination) || !nonEmpty(expected.transactionId)
        || !Number.isSafeInteger(expected.amountAtomic) || expected.amountAtomic <= 0) {
        throw new ToncenterResponseError("Expected outgoing operation is malformed");
    }
    if (!nonEmpty(transaction.hash) || transaction.hash !== expected.transactionId) return null;
    if (!nonEmpty(transaction.account)
        || !tonAddressIdentitiesEqual(transaction.account, expected.sourceWalletAddress)) return null;
    if (!successfulTransaction(transaction)) return null;

    const sourceIdentity = tonAddressIdentityOrNull(expected.sourceWalletAddress);
    if (sourceIdentity === null) return null;
    if (!Array.isArray(transaction.out_msgs)) {
        throw new ToncenterResponseError("Outgoing transaction row is missing out_msgs");
    }

    const matches = transaction.out_msgs.filter((message) => {
        if (!message || typeof message !== "object"
            || !nonEmpty(message.destination)
            || !tonAddressIdentitiesEqual(message.destination, expected.destination)
            || message.value === undefined || message.value === null) return false;
        return atomicString(message.value, "outgoing message value") === expected.amountAtomic;
    });
    if (matches.length !== 1) return null;

    const totalFeesAtomic = atomicString(transaction.total_fees, "total_fees");
    const block = transaction.block_ref;
    if (!block || typeof block !== "object"
        || !Number.isSafeInteger(block.seqno)
        || !Number.isSafeInteger(block.workchain)
        || !nonEmpty(block.shard)) {
        throw new ToncenterResponseError("Outgoing transaction row is missing a valid block reference");
    }

    // Do not infer wallet seqno from transaction.lt or block_ref.seqno.
    return Object.freeze({
        candidate: true,
        authorization: "NOT_AUTHORIZED",
        transactionId: transaction.hash,
        sourceWalletAddress: expected.sourceWalletAddress,
        destination: expected.destination,
        amountAtomic: expected.amountAtomic,
        totalFeesAtomic,
        blockId: `${block.workchain}:${block.shard}:${block.seqno}`,
        transactionLogicalTime: nonEmpty(transaction.lt) ? transaction.lt : null,
        walletSeqno: null,
        finalized: false,
        finalityEvidenceRequired: true,
        walletSeqnoEvidenceRequired: true
    });
}
