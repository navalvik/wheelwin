/**
 * Indexer-only examination of decoded TEP-74 forward payload comments.
 *
 * A reference hint is never settlement evidence: neither the indexer decode
 * nor the comment establishes that the jetton transfer was finalized.
 *
 * This function intentionally supports only the explicitly tagged text
 * comment shape. Unknown decoded shapes fail closed instead of guessing from
 * arbitrary JSON text, query_id or transaction metadata.
 */
import { extractPaymentReference, isPaymentReference } from "../incoming/PaymentReferenceCodec.js";

export function matchGramReferenceHint(transfer, expectedPaymentReference) {
    if (!isPaymentReference(expectedPaymentReference)) {
        throw new Error("Invalid authoritative GRAM payment reference");
    }
    const decoded = transfer?.decoded_forward_payload;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)
        || decoded.type !== "text_comment"
        || typeof decoded.comment !== "string") {
        return Object.freeze({ matched: false, reason: "NO_STRICT_TEXT_COMMENT", verified: false });
    }
    const extracted = extractPaymentReference(decoded.comment);
    if (extracted !== expectedPaymentReference) {
        return Object.freeze({ matched: false, reason: "REFERENCE_MISMATCH", verified: false });
    }
    return Object.freeze({ matched: true, reason: "INDEXER_HINT_ONLY", verified: false });
}
