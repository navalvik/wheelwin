/**
 * Correlate an indexed GRAM transfer candidate with an independently observed
 * FINALIZED Jetton Wallet transaction from Toncenter Streaming API v2.
 *
 * The subscription MUST be acknowledged before the indexed v3 query starts.
 * Streaming v2 does not replay old transactions; a missing event is NOT proof
 * of non-payment. This module intentionally cannot produce the
 * VERIFIED_JETTON_TRANSFER evidence required by payment admission:
 * transaction finality alone does not authenticate the TEP-74 body, wallet
 * ownership, token master, successful receiver notification or amount.
 */
import { tonAddressIdentitiesEqual, tonAddressIdentityOrNull } from "../incoming/TonAddressIdentity.js";
import { ToncenterFinalityEvidenceProvider } from "./ToncenterFinalityEvidenceProvider.js";

const TESTNET_GLOBAL_ID = -3;

function validBlock(block) {
    return block && Number.isSafeInteger(block.workchain)
        && typeof block.shard === "string" && block.shard.length > 0
        && Number.isSafeInteger(block.seqno) && block.seqno >= 0;
}
function sameBlock(a, b) {
    return validBlock(a) && validBlock(b) && a.workchain === b.workchain
        && a.shard === b.shard && a.seqno === b.seqno;
}

export async function correlateGramCandidateFinality({
    candidate,
    observationSession,
    finalityProvider
} = {}) {
    if (!(finalityProvider instanceof ToncenterFinalityEvidenceProvider)) {
        throw new Error("A real Testnet Toncenter finality provider is required");
    }
    if (!candidate || candidate.finalized !== false
        || candidate.verifiedForSettlement !== false
        || candidate.referenceHintMatched !== true
        || candidate.paymentReference !== null
        || !/^[a-f0-9]{64}$/.test(candidate.transactionHash ?? "")
        || tonAddressIdentityOrNull(candidate.sourceJettonWallet) === null) {
        throw new Error("Only an unverified, reference-matched Jetton Wallet candidate is accepted");
    }
    if (finalityProvider.isObservationValid(observationSession) !== true) {
        return null;
    }
    const evidence = await finalityProvider.getSettlementEvidence({
        accountId: candidate.sourceJettonWallet,
        providerTransactionId: candidate.transactionHash,
        observationSession
    });
    if (finalityProvider.isObservationValid(observationSession) !== true || !evidence) {
        return null;
    }

    const inclusion = evidence.transactionInclusion;
    const finalized = evidence.finality;
    const network = evidence.networkIdentity;
    if (network?.network !== "testnet" || network.globalId !== TESTNET_GLOBAL_ID
        || finalized?.status !== "finalized"
        || finalized.source !== "toncenter-streaming-v2"
        || finalized.transactionId !== candidate.transactionHash
        || inclusion?.transactionId !== candidate.transactionHash
        || !tonAddressIdentitiesEqual(inclusion?.accountId, candidate.sourceJettonWallet)
        || !tonAddressIdentitiesEqual(finalized?.accountId, candidate.sourceJettonWallet)
        || !sameBlock(inclusion?.block, finalized?.block)
        || !Number.isSafeInteger(finalized.masterchainSeqno)
        || finalized.masterchainSeqno < 0) {
        return null;
    }

    // Advisory correlation, deliberately NOT a payment confirmation. Even
    // a finalized source-wallet transfer may fail at the recipient wallet.
    return Object.freeze({
        sourceJettonWallet: tonAddressIdentityOrNull(candidate.sourceJettonWallet),
        transactionHash: candidate.transactionHash,
        sourceWalletTransactionFinalized: true,
        receivingJettonNotificationVerified: false,
        gramTransferVerified: false,
        paymentCreditAuthorized: false
    });
}
