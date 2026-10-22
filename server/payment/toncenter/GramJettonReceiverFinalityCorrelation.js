/**
 * Read-only correlation of a SEPARATELY identified receiving Jetton Wallet
 * transaction with a finalized Toncenter SSE event.
 *
 * The source-wallet transaction hash is not the recipient transaction hash.
 * The receiving Jetton Wallet + hash must come from a separately validated
 * transaction trace; the v3 jetton transfer record does not prove that pair.
 *
 * Even source+recipient finalized events are INSUFFICIENT to credit GRAM:
 * TEP-74 internal_transfer message identity, successful receiver processing,
 * issuer-derived Jetton Wallet ownership and chain trace linkage are still
 * unverified. This module NEVER constructs VERIFIED_JETTON_TRANSFER evidence.
 */
import { tonAddressIdentityOrNull, tonAddressIdentitiesEqual } from "../incoming/TonAddressIdentity.js";
import { ToncenterFinalityEvidenceProvider } from "./ToncenterFinalityEvidenceProvider.js";

function validBlock(block) {
    return !!block && Number.isSafeInteger(block.workchain)
        && typeof block.shard === "string" && block.shard.trim() !== ""
        && Number.isSafeInteger(block.seqno) && block.seqno >= 0;
}
function equalBlock(a, b) {
    return validBlock(a) && validBlock(b) && a.workchain === b.workchain
        && a.shard === b.shard && a.seqno === b.seqno;
}

/**
 * An advisory receiver-transaction observation. Never a credit or a match to
 * a particular player transaction until the internal message is verified.
 */
export async function correlateGramReceiverFinality({
    recipientJettonWallet,
    recipientTransactionHash,
    roomWallet,
    observationSession,
    finalityProvider
} = {}) {
    if (!(finalityProvider instanceof ToncenterFinalityEvidenceProvider)) {
        throw new Error("A real Testnet finality provider is required");
    }
    const recipientIdentity = tonAddressIdentityOrNull(recipientJettonWallet);
    const ownerIdentity = tonAddressIdentityOrNull(roomWallet);
    if (!recipientIdentity || !ownerIdentity || recipientIdentity === ownerIdentity
        || typeof recipientTransactionHash !== "string"
        || !/^[a-f0-9]{64}$/.test(recipientTransactionHash)) {
        throw new Error("Invalid receiving Jetton Wallet correlation requirements");
    }
    if (!finalityProvider.isObservationValid(observationSession)) return null;
    const evidence = await finalityProvider.getSettlementEvidence({
        accountId: recipientJettonWallet,
        providerTransactionId: recipientTransactionHash,
        observationSession
    });
    if (!finalityProvider.isObservationValid(observationSession) || !evidence) return null;
    const { networkIdentity, transactionInclusion, finality } = evidence;
    if (networkIdentity?.network !== "testnet" || networkIdentity.globalId !== -3
        || transactionInclusion?.transactionId !== recipientTransactionHash
        || finality?.transactionId !== recipientTransactionHash
        || !tonAddressIdentitiesEqual(transactionInclusion?.accountId, recipientJettonWallet)
        || !tonAddressIdentitiesEqual(finality?.accountId, recipientJettonWallet)
        || finality.status !== "finalized"
        || finality.source !== "toncenter-streaming-v2"
        || !equalBlock(transactionInclusion.block, finality.block)
        || !Number.isSafeInteger(finality.masterchainSeqno)
        || finality.masterchainSeqno < 0) return null;

    return Object.freeze({
        recipientJettonWallet: recipientIdentity,
        recipientTransactionHash,
        recipientWalletTransactionFinalized: true,
        recipientTransferDecodedAndVerified: false,
        jettonWalletMasterOwnershipVerified: false,
        senderReceiverTraceLinked: false,
        gramTransferVerified: false,
        paymentCreditAuthorized: false
    });
}
