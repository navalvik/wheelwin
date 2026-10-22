/**
 * Pre-write GRAM admission into the existing PaymentIntentStore contract.
 *
 * This is ONLY a validation boundary, NOT a transaction verifier or a credit
 * operation. The caller must independently establish chain finality, token
 * wallet ownership, decoded forward-payload and Testnet chain identity before
 * constructing evidence. No client/indexer flag can grant that authority.
 *
 * Most importantly, this function does NOT mutate an intent: a read-only
 * deduplication check cannot prevent concurrent credits. The future writer
 * MUST atomically claim transactionId under the existing SQLite UNIQUE index
 * (and preserve consumed identities across deletion/recovery).
 */
import { requireVerifiedGramTransfer } from "./VerifiedGramTransferPolicy.js";
import { tonAddressIdentitiesEqual } from "./TonAddressIdentity.js";
import { isPaymentReference } from "./PaymentReferenceCodec.js";
import { PAYMENT_INTENT_STATE } from "../PaymentIntentStatus.js";

export function assessVerifiedGramIntentAdmission({
    intentStore,
    paymentReference,
    expectedTokenMaster,
    verifiedEvidence
} = {}) {
    if (!intentStore
        || typeof intentStore.require !== "function"
        || typeof intentStore.findByTransactionId !== "function") {
        throw new Error("Existing payment intent store with transaction lookup is required");
    }
    if (!isPaymentReference(paymentReference)) {
        throw new Error("Invalid authoritative GRAM payment reference");
    }
    const intent = intentStore.require(paymentReference);
    if (!intent
        || intent.paymentReference !== paymentReference
        || intent.network !== "testnet"
        || intent.asset !== "GRAM"
        || intent.state !== PAYMENT_INTENT_STATE.PENDING
        || !Number.isSafeInteger(intent.amountAtomic)
        || intent.amountAtomic <= 0
        || !tonAddressIdentitiesEqual(intent.expectedSender, verifiedEvidence?.sender)
        || !tonAddressIdentitiesEqual(intent.destinationWalletAddress, verifiedEvidence?.recipient)) {
        throw new Error("GRAM evidence cannot be admitted for this pending Testnet payment intent");
    }
    const checked = requireVerifiedGramTransfer(verifiedEvidence, {
        expectedTokenMaster,
        expectedSender: intent.expectedSender,
        expectedRecipient: intent.destinationWalletAddress,
        expectedAmountAtomic: String(intent.amountAtomic),
        expectedPaymentReference: paymentReference
    });
    const prior = intentStore.findByTransactionId(checked.transactionId);
    if (prior !== null && prior !== undefined) {
        throw new Error("GRAM transaction identity has already been assigned to a payment intent");
    }
    // A returned result is an advisory preflight only. It cannot be used as
    // ledger credit or gameplay-start authorization.
    return Object.freeze({
        paymentReference,
        transactionId: checked.transactionId,
        amountAtomic: checked.amountAtomic,
        asset: "GRAM",
        network: "testnet",
        writeAuthorized: false,
        settlementAuthorized: false
    });
}
