/**
 * Read-only, indexer-level TEP-74 inspection for an exact message-hash edge.
 *
 * Does not assert that the body hash equals the on-chain message hash: the
 * Toncenter indexer supplies both. A trusted chain proof and confirmation of
 * successful recipient execution remain mandatory before credit.
 */
import { inspectGramJettonMessageLink } from "./GramJettonTraceMessageLink.js";
import { decodeGramInternalTransferBody } from "./GramInternalTransferBody.js";
import { tonAddressIdentitiesEqual, tonAddressIdentityOrNull } from "../incoming/TonAddressIdentity.js";
import { isPaymentReference } from "../incoming/PaymentReferenceCodec.js";

export function inspectIndexedGramInternalTransfer({
    indexedTrace, candidate, recipientJettonWallet,
    expectedSender, expectedAmountAtomic, expectedPaymentReference
} = {}) {
    if (!tonAddressIdentityOrNull(expectedSender)
        || typeof expectedAmountAtomic !== "string"
        || !/^[1-9][0-9]*$/.test(expectedAmountAtomic)
        || !isPaymentReference(expectedPaymentReference)
        || expectedPaymentReference === "") {
        throw new Error("Invalid authoritative GRAM transfer intent");
    }
    const link = inspectGramJettonMessageLink({
        indexedTrace, candidate, recipientJettonWallet
    });
    if (!link) return null;

    const stack = [indexedTrace.trace];
    const visited = new Set();
    let body = null;
    while (stack.length) {
        const node = stack.pop();
        if (!node || visited.has(node)) return null;
        visited.add(node);
        if (node.tx_hash === link.receiverTransactionHash) {
            if (body !== null) return null;
            const incoming = node.transaction?.in_msg;
            if (incoming?.hash !== link.messageHash
                || !tonAddressIdentitiesEqual(incoming?.destination, recipientJettonWallet)) return null;
            body = incoming?.message_content?.body;
        }
        for (const child of (node.children ?? [])) stack.push(child);
    }
    if (typeof body !== "string") return null;
    let decoded;
    try { decoded = decodeGramInternalTransferBody(body); }
    catch { return null; }
    if (!tonAddressIdentitiesEqual(decoded.sender, expectedSender)
        || decoded.amountAtomic !== expectedAmountAtomic
        || decoded.paymentReference !== expectedPaymentReference) return null;
    return Object.freeze({
        messageHash: link.messageHash,
        senderTransactionHash: link.senderTransactionHash,
        receiverTransactionHash: link.receiverTransactionHash,
        sender: tonAddressIdentityOrNull(decoded.sender),
        amountAtomic: decoded.amountAtomic,
        paymentReferenceHintMatched: true,
        indexedInternalTransferDecoded: true,
        onChainMessageBodyAuthenticated: false,
        receiverExecutionVerified: false,
        jettonWalletMasterVerified: false,
        gramTransferVerified: false,
        paymentCreditAuthorized: false
    });
}
