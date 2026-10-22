/**
 * Fail-closed structural correlation of the indexed TON message edge:
 * source Jetton Wallet transaction -> receiving Jetton Wallet transaction.
 *
 * This does NOT decode/validate TEP-74 internal_transfer, verify Jetton Master
 * ownership or independently confirm the receiving transaction. No credit
 * authority or finalized evidence is produced.
 */
import { tonAddressIdentityOrNull } from "../incoming/TonAddressIdentity.js";

const HASH = /^[a-fA-F0-9]{64}$/;
function canon(value) { return tonAddressIdentityOrNull(value); }
function hash(value) { return typeof value === "string" && HASH.test(value) ? value.toLowerCase() : null; }

/**
 * Require a direct parent-child trace edge whose message hash is present in
 * both the sending out_msgs and receiving in_msg. Never infer from same trace
 * ID alone. The target contract must be known independently.
 */
export function inspectGramJettonMessageLink({
    indexedTrace,
    candidate,
    recipientJettonWallet
} = {}) {
    const receiving = canon(recipientJettonWallet);
    if (!receiving || !candidate || !hash(candidate.transactionHash)
        || !canon(candidate.sourceJettonWallet)
        || receiving === canon(candidate.sourceJettonWallet)
        || indexedTrace?.trace_id !== candidate.traceId
        || indexedTrace?.is_incomplete !== false
        || indexedTrace?.trace_info?.pending_messages !== 0
        || !indexedTrace?.trace || typeof indexedTrace.trace !== "object") {
        return null;
    }

    const matches = [];
    const stack = [{ node: indexedTrace.trace, depth: 0 }];
    const seenNodes = new Set();
    let inspected = 0;
    while (stack.length) {
        const { node, depth } = stack.pop();
        if (!node || typeof node !== "object" || seenNodes.has(node)
            || depth > 64 || ++inspected > 512) return null;
        seenNodes.add(node);
        const parentTx = node.transaction;
        const children = node.children ?? [];
        if (!Array.isArray(children) || children.length > 512) return null;
        if (hash(node.tx_hash) === candidate.transactionHash
            && canon(parentTx?.account) === canon(candidate.sourceJettonWallet)
            && Array.isArray(parentTx?.out_msgs)) {
            for (const child of children) {
                const childTx = child?.transaction;
                const incoming = childTx?.in_msg;
                const messageHash = hash(incoming?.hash);
                if (!messageHash || !hash(child?.tx_hash)
                    || canon(childTx?.account) !== receiving
                    || canon(incoming?.source) !== canon(candidate.sourceJettonWallet)
                    || canon(incoming?.destination) !== receiving) continue;
                const sends = parentTx.out_msgs.filter(out =>
                    hash(out?.hash) === messageHash
                    && canon(out?.source) === canon(candidate.sourceJettonWallet)
                    && canon(out?.destination) === receiving);
                if (sends.length === 1) {
                    matches.push({
                        messageHash,
                        senderTransactionHash: candidate.transactionHash,
                        receiverTransactionHash: hash(child.tx_hash)
                    });
                }
            }
        }
        for (const child of children) stack.push({ node: child, depth: depth + 1 });
    }
    // Ambiguous edges and missing links must not be used as evidence.
    if (matches.length !== 1) return null;
    return Object.freeze({
        ...matches[0],
        indexedMessageEdgeObserved: true,
        messageBodyVerified: false,
        recipientWalletMasterVerified: false,
        receiverFinalityVerified: false,
        gramTransferVerified: false,
        paymentCreditAuthorized: false
    });
}
