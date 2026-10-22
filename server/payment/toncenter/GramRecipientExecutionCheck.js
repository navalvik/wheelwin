/**
 * Conservative structural check of an indexed receiving Jetton Wallet
 * transaction. Toncenter v3 is an index: these booleans are NOT authenticated
 * chain evidence and cannot establish GRAM settlement independently.
 *
 * Fail closed for missing/skipped computation, failed action, abort, bounce,
 * wrong input address/message, or non-ordinary transaction descriptions.
 */
import { tonAddressIdentitiesEqual } from "../incoming/TonAddressIdentity.js";

const HEX_HASH = /^[a-fA-F0-9]{64}$/;

export function inspectIndexedGramRecipientExecution({
    receiverTransaction,
    recipientJettonWallet,
    sourceJettonWallet,
    internalMessageHash
} = {}) {
    const tx = receiverTransaction;
    const message = tx?.in_msg;
    const description = tx?.description;
    if (!tx || !message || !description
        || !tonAddressIdentitiesEqual(tx.account, recipientJettonWallet)
        || !tonAddressIdentitiesEqual(message.source, sourceJettonWallet)
        || !tonAddressIdentitiesEqual(message.destination, recipientJettonWallet)
        || !HEX_HASH.test(internalMessageHash ?? "")
        || typeof message.hash !== "string"
        || message.hash.toLowerCase() !== internalMessageHash.toLowerCase()
        || message.bounced === true || message.bounce === true
        || description.type !== "ord"
        || description.aborted !== false
        || description.compute_ph?.skipped === true
        || description.compute_ph?.success !== true
        || description.action?.success !== true
        || description.action?.valid !== true
        || description.action?.no_funds === true) return null;

    return Object.freeze({
        indexedReceiverExecutionAppearsSuccessful: true,
        receiverExecutionIndependentlyVerified: false,
        jettonMasterVerified: false,
        gramCreditAuthorized: false
    });
}
