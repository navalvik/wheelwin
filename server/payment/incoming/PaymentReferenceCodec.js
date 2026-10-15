/**
 * Phase 3C — Native TON payment reference codec (isolated helper).
 *
 * ONE strict wire format for the ordinary TON transfer comment:
 *
 *     WW1:<paymentReference>
 *
 * This is a plain-text wallet comment. It needs no smart contract, no opcode
 * and no on-chain state: the comment carries the Phase 1 payment reference
 * verbatim behind a versioned envelope prefix.
 *
 * The codec has exactly two jobs:
 *
 *   1. FORMAT — wrap a valid Phase 1 payment reference into the wire comment
 *      (`formatPaymentReference`);
 *   2. EXTRACT — recover a payment reference from a provider comment, but
 *      ONLY when the comment starts with the exact `WW1:` prefix and the
 *      remainder passes strict validation (`extractPaymentReference`).
 *
 * Everything else is refused:
 *   - an absent, empty, blank, non-text or overlong comment;
 *   - any comment that does not begin with the exact prefix (a different
 *     prefix such as `WW2:`, a look-alike case such as `ww1:`, a padded
 *     comment such as ` WW1:…` or `WW1: …`, or a nested `WW1:WW1:…` value);
 *   - a reference containing whitespace, separators, non-ASCII characters or
 *     any other character outside the reference alphabet;
 *   - a reference longer than the documented maximum.
 *
 * A reference is NEVER guessed from an arbitrary comment, sender, amount,
 * timestamp, transaction hash or wallet address: extraction either recovers
 * the exact Phase 1 payment reference that was formatted into the comment, or
 * it returns `null`.
 *
 * No competing payment-identity system is introduced here. The Phase 1
 * `PaymentIntent.paymentReference` field remains the identity of a payment;
 * this codec only defines how that identity travels inside a TON transfer
 * comment. Every reference this codec accepts is also a valid Phase 1
 * reference (a non-empty string), so the two layers can never disagree about
 * identity — a reference the codec refuses is one Phase 1 would never have
 * created for a payment.
 *
 * Nothing here logs, echoes or otherwise exposes a comment. The diagnostic
 * helper `inspectPaymentReferenceComment` reports machine-readable reasons and
 * lengths only: never the comment text.
 */

import { PaymentError } from "../PaymentErrors.js";

/**
 * The exact envelope prefix of a native TON payment-reference comment.
 * Matching is case-sensitive and anchored at the first character.
 */
export const PAYMENT_REFERENCE_COMMENT_PREFIX = "WW1:";

/**
 * Reference alphabet: ASCII letters, ASCII digits, hyphen and underscore.
 *
 * Anything else is rejected — whitespace, `:`, `/`, `.`, non-ASCII letters,
 * zero-width and look-alike characters. A reference must be unambiguous when
 * it is read back out of a plain-text comment.
 */
export const PAYMENT_REFERENCE_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * A TON text comment is bounded, so a reference that cannot fit comfortably
 * inside one is overlong. This maximum is a fixed contract, not a tunable,
 * and sits far below the documented comment limit while leaving ample room
 * for any plausible reference generator.
 */
export const PAYMENT_REFERENCE_MAX_LENGTH = 64;

/**
 * Machine-readable reasons why a value is not a usable payment reference.
 * Reasons describe the defect only; they never contain the value.
 */
export const PAYMENT_REFERENCE_REJECTION_REASON = Object.freeze({
    // A bare reference (no envelope) is rejected because of these.
    REFERENCE_NOT_TEXT: "REFERENCE_NOT_TEXT",
    REFERENCE_EMPTY: "REFERENCE_EMPTY",
    REFERENCE_MALFORMED: "REFERENCE_MALFORMED",
    REFERENCE_OVERLONG: "REFERENCE_OVERLONG",
    REFERENCE_AMBIGUOUS: "REFERENCE_AMBIGUOUS",
    // A comment (with envelope) can additionally be rejected because of these.
    COMMENT_ABSENT: "COMMENT_ABSENT",
    COMMENT_NOT_TEXT: "COMMENT_NOT_TEXT",
    COMMENT_PREFIX_MISMATCH: "COMMENT_PREFIX_MISMATCH"
});

/**
 * A value that can never become a payment-reference comment.
 *
 * Details deliberately carry the defect and the value LENGTH only — never the
 * value itself, because a comment may carry arbitrary user text.
 */
export class PaymentReferenceFormatError extends PaymentError {

    constructor(reason, details) {

        super(
            "PAYMENT_REFERENCE_FORMAT_INVALID",
            `payment reference is not a valid ${PAYMENT_REFERENCE_COMMENT_PREFIX}`
                + ` reference: ${reason}`,
            { reason, ...details }
        );

    }

}

/**
 * Validate one BARE payment reference (no envelope prefix).
 *
 * The rules mirror the Phase 1 model — a payment reference must be a
 * non-empty string — and add the transport rules this wire format requires:
 * a bounded length, an unambiguous alphabet, and no envelope prefix inside
 * the reference itself.
 *
 * @param {unknown} value
 * @returns {{ valid: boolean, reason: string|null }}
 */
function inspectPaymentReference(value) {

    if (typeof value !== "string") {

        return Object.freeze({
            valid: false,
            reason: PAYMENT_REFERENCE_REJECTION_REASON.REFERENCE_NOT_TEXT
        });

    }

    if (value.trim() === "") {

        return Object.freeze({
            valid: false,
            reason: PAYMENT_REFERENCE_REJECTION_REASON.REFERENCE_EMPTY
        });

    }

    if (value.length > PAYMENT_REFERENCE_MAX_LENGTH) {

        return Object.freeze({
            valid: false,
            reason: PAYMENT_REFERENCE_REJECTION_REASON.REFERENCE_OVERLONG
        });

    }

    if (value.includes(PAYMENT_REFERENCE_COMMENT_PREFIX)) {

        // A reference that itself carries the envelope prefix could be read
        // back as two nested references. That ambiguity is never accepted.
        return Object.freeze({
            valid: false,
            reason: PAYMENT_REFERENCE_REJECTION_REASON.REFERENCE_AMBIGUOUS
        });

    }

    if (!PAYMENT_REFERENCE_PATTERN.test(value)) {

        return Object.freeze({
            valid: false,
            reason: PAYMENT_REFERENCE_REJECTION_REASON.REFERENCE_MALFORMED
        });

    }

    return Object.freeze({ valid: true, reason: null });

}

/**
 * True when the value is a reference this codec can carry in a comment.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPaymentReference(value) {

    return inspectPaymentReference(value).valid;

}

/**
 * Format one valid Phase 1 payment reference as a native TON comment.
 *
 * Deterministic: the same reference always produces the same comment, so a
 * duplicated reference produces a duplicated comment and is caught by the
 * Phase 1 unique-reference rule instead of silently becoming a second,
 * indistinguishable payment.
 *
 * @param {string} paymentReference the Phase 1 payment reference
 * @returns {string} `WW1:<paymentReference>`
 * @throws {PaymentReferenceFormatError} when the reference is not usable
 */
export function formatPaymentReference(paymentReference) {

    const inspection = inspectPaymentReference(paymentReference);

    if (!inspection.valid) {

        throw new PaymentReferenceFormatError(
            inspection.reason,
            {
                referenceLength: typeof paymentReference === "string"
                    ? paymentReference.length
                    : null
            }
        );

    }

    return `${PAYMENT_REFERENCE_COMMENT_PREFIX}${paymentReference}`;

}

/**
 * Classify one provider comment without exposing it.
 *
 * @param {unknown} comment
 * @returns {Readonly<{
 *   valid: boolean,
 *   paymentReference: string|null,
 *   reason: string|null,
 *   commentLength: number|null
 * }>}
 */
export function inspectPaymentReferenceComment(comment) {

    if (comment === undefined || comment === null) {

        return Object.freeze({
            valid: false,
            paymentReference: null,
            reason: PAYMENT_REFERENCE_REJECTION_REASON.COMMENT_ABSENT,
            commentLength: null
        });

    }

    if (typeof comment !== "string") {

        return Object.freeze({
            valid: false,
            paymentReference: null,
            reason: PAYMENT_REFERENCE_REJECTION_REASON.COMMENT_NOT_TEXT,
            commentLength: null
        });

    }

    if (!comment.startsWith(PAYMENT_REFERENCE_COMMENT_PREFIX)) {

        return Object.freeze({
            valid: false,
            paymentReference: null,
            reason: PAYMENT_REFERENCE_REJECTION_REASON.COMMENT_PREFIX_MISMATCH,
            commentLength: comment.length
        });

    }

    const value = comment.slice(PAYMENT_REFERENCE_COMMENT_PREFIX.length);

    const inspection = inspectPaymentReference(value);

    if (!inspection.valid) {

        return Object.freeze({
            valid: false,
            paymentReference: null,
            reason: inspection.reason,
            commentLength: comment.length
        });

    }

    return Object.freeze({
        valid: true,
        paymentReference: value,
        reason: null,
        commentLength: comment.length
    });

}

/**
 * Extract the Phase 1 payment reference from a TON transfer comment.
 *
 * The reference is returned ONLY when the comment is exactly
 * `WW1:<valid reference>`. Anything else — an absent comment, a different
 * prefix, a blank or malformed reference, an unsupported comment — yields
 * `null`. The function never throws and never guesses.
 *
 * @param {unknown} comment
 * @returns {string|null}
 */
export function extractPaymentReference(comment) {

    const inspection = inspectPaymentReferenceComment(comment);

    return inspection.valid ? inspection.paymentReference : null;

}

/**
 * True when the comment is exactly `WW1:<valid reference>`.
 *
 * @param {unknown} comment
 * @returns {boolean}
 */
export function isPaymentReferenceComment(comment) {

    return inspectPaymentReferenceComment(comment).valid;

}
