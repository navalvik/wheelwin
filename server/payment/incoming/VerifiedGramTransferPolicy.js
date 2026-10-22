/**
 * Fail-closed asset boundary for GRAM payments.
 *
 * Toncenter's ordinary in_msg.value is native TON (gas currency), NOT GRAM.
 * A GRAM payment must be evidenced by a verified token-transfer event with
 * the configured token master and matching owner/destination identities.
 * This function does not query the network or assert token-event finality.
 */
import { tonAddressIdentityOrNull } from "./TonAddressIdentity.js";

function equalTonAccounts(left, right) {
    const a = tonAddressIdentityOrNull(left);
    const b = tonAddressIdentityOrNull(right);
    return a !== null && b !== null && a === b;
}

export function requireVerifiedGramTransfer(evidence, {
    expectedTokenMaster,
    expectedSender,
    expectedRecipient,
    expectedAmountAtomic,
    expectedPaymentReference
}) {
    if (!evidence || evidence.asset !== "GRAM"
        || evidence.kind !== "VERIFIED_JETTON_TRANSFER"
        || evidence.finalized !== true
        || evidence.aborted !== false) {
        throw new Error("GRAM payment requires finalized verified token-transfer evidence");
    }
    for (const [name, value] of Object.entries({
        expectedTokenMaster,
        expectedSender,
        expectedRecipient,
        expectedAmountAtomic,
        expectedPaymentReference
    })) {
        if (typeof value !== "string" || value.trim() === "") {
            throw new Error(`missing authoritative GRAM payment field: ${name}`);
        }
    }
    if (!/^[1-9][0-9]*$/.test(expectedAmountAtomic)) {
        throw new Error("GRAM amount must be a positive integer atomic-unit string");
    }
    // TON indexers may render the SAME account as raw, bounceable or
    // non-bounceable friendly addresses. Compare validated account identities,
    // never display strings or unvalidated placeholders.
    if (!equalTonAccounts(evidence.tokenMaster, expectedTokenMaster)
        || !equalTonAccounts(evidence.sender, expectedSender)
        || !equalTonAccounts(evidence.recipient, expectedRecipient)
        || evidence.amountAtomic !== expectedAmountAtomic
        || evidence.paymentReference !== expectedPaymentReference
        || typeof evidence.transactionId !== "string"
        || evidence.transactionId.trim() === "") {
        throw new Error("GRAM transfer does not match authoritative payment intent");
    }
    // A confirmed token event is not a reusable credit: the transaction identity
    // must be persisted atomically by the settlement ledger before crediting.
    return Object.freeze({
        transactionId: evidence.transactionId,
        asset: "GRAM",
        amountAtomic: expectedAmountAtomic
    });
}
