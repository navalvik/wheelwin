/**
 * Phase 3 — Toncenter v3 response mapper.
 *
 * Maps the documented `GET /api/v3/transactions` response into the Phase 2
 * provider record contract (`INCOMING_TRANSFER_PROVIDER_CONTRACT`) so the
 * existing Phase 2 normalizer can produce `IncomingTransfer` records.
 *
 * Mapping table (all fields from the official v3 OpenAPI spec):
 *
 *   v3 field                                    Phase 2 field
 *   ------------------------------------------- ----------------------------
 *   network (fixed: testnet)                    network
 *   queried wallet address                      accountId
 *   transaction.hash                            transactionId
 *   transaction.now (epoch seconds)             transactionTime (epoch ms)
 *   in_msg.source (address_book -> friendly)    sourceAddress
 *   in_msg.destination (address_book -> ...)    destinationAddress
 *   in_msg.value (nanoton digit string)         amountAtomic
 *   "TON" (native coin, 9 decimals)             asset
 *   in_msg.message_content.decoded.comment      comment
 *   ("text_comment" only)                       (never guessed)
 *   endpoint returns committed transactions     confirmed: true
 *   description.aborted / phase success         aborted
 *
 * Payment reference (Phase 3C): the native TON comment wire format is
 * `WW1:<paymentReference>` (see `PaymentReferenceCodec`). A decoded text
 * comment is accepted as a payment reference ONLY when it is exactly that
 * envelope around a valid Phase 1 payment reference. The Phase 2 provider
 * contract maps a record's `comment` to the normalized `paymentReference`,
 * so the mapper emits the extracted BARE reference — the envelope is stripped
 * here and the raw comment is never retained, logged or forwarded. Any other
 * decoded body (a comment without the prefix, a binary or encrypted comment,
 * a contract payload, an undecoded body) yields `comment: null`: the
 * transaction remains an observation with no payment identity at all.
 *
 * Address identity (Phase 3B): the response carries raw
 * `workchain:hash` addresses, while callers may query the provider with any
 * address form (the Phase 1 wallet catalog stores user-friendly addresses).
 * The destination check therefore compares VALIDATED canonical account
 * identities (`TonAddressIdentity`), never raw string equality. The
 * `address_book` is used only as supplementary display metadata: a
 * `user_friendly` entry is accepted solely when it is itself a valid TON
 * address whose identity matches the raw address it claims to describe.
 * Identity never comes from the address book, and a row is mapped only when
 * its destination identity equals the queried wallet identity.
 *
 * Records that are not completed incoming value transfers to the queried
 * wallet are SKIPPED, never normalized as payments:
 *   - transactions without an `in_msg`;
 *   - `emulated` transactions;
 *   - aborted transactions and failed compute/action phases;
 *   - zero-value or missing-value messages (not value transfers);
 *   - messages whose destination is not the queried wallet;
 *   - transactions outside the requested time window.
 *
 * Window completeness: the query is bounded by `limit` and one room check
 * performs at most one request. When the provider returned as many rows as
 * the limit, the window may be truncated and `resultWindowComplete` is
 * false — the caller must report a potentially incomplete observation
 * instead of claiming that a payment does not exist.
 */

import {
    TONCENTER_ASSET,
    TONCENTER_NETWORK,
    TONCENTER_TEXT_COMMENT_DECODED_TYPE
} from "./ToncenterConstants.js";

import { ToncenterResponseError } from "./ToncenterErrors.js";

import {
    tonAddressIdentitiesEqual,
    tonAddressIdentityOrNull
} from "../incoming/TonAddressIdentity.js";

import { extractPaymentReference } from "../incoming/PaymentReferenceCodec.js";

/** int32 UTC seconds range requested from the provider. */
const UTC_SECOND = 1000;

function isNonEmptyString(value) {

    return typeof value === "string" && value.trim() !== "";

}

/**
 * Resolve a raw response address through the response `address_book`
 * (raw address -> `user_friendly`). The book is supplementary display
 * metadata, NOT identity: a friendly entry is used only when it is itself a
 * valid TON address for the same account as the raw address. Otherwise the
 * raw address is returned unchanged — no address form is invented, repaired
 * or guessed, and no identity is ever taken from the book.
 *
 * @param {unknown} address
 * @param {Record<string, { user_friendly?: string }>} addressBook
 * @returns {string}
 */
export function resolveAddress(address, addressBook) {

    if (!isNonEmptyString(address)) {

        return "";

    }

    const row = addressBook && typeof addressBook === "object"
        ? addressBook[address]
        : undefined;

    if (row && isNonEmptyString(row.user_friendly)
        && tonAddressIdentitiesEqual(address, row.user_friendly)) {

        return row.user_friendly;

    }

    return address;

}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isDigitString(value) {

    return typeof value === "string" && /^[0-9]+$/.test(value);

}

/**
 * Extract the payment reference from a documented decoded message body.
 *
 * Accepted structure — and nothing else:
 *
 *     in_msg.message_content.decoded = {
 *         type: "text_comment",
 *         comment: "WW1:<paymentReference>"
 *     }
 *
 * The decoded object is NOT assumed to carry a `comment` property: a body
 * that decodes to another type (binary comment, contract payload, opcode),
 * a comment-less text body, or no decoded object at all yields `null`.
 * Encrypted, binary and contract payloads are never interpreted, and raw body
 * data is never read as a reference.
 *
 * The comment is accepted as a payment reference only when it is exactly the
 * `WW1:` envelope around a valid Phase 1 payment reference, and the BARE
 * reference is returned: the Phase 2 provider contract carries a record's
 * `comment` straight into the normalized `paymentReference`, and a Phase 1
 * intent is keyed by the bare reference. A comment that is not exactly that
 * envelope is not a payment reference — `null` is returned and the
 * transaction stays an observation with no payment identity.
 *
 * @param {object} message
 * @returns {string|null}
 */
function extractPaymentReferenceComment(message) {

    const decoded = message?.message_content?.decoded;

    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {

        return null;

    }

    // Only an explicitly recognized text-comment type is a payment reference.
    if (decoded.type !== TONCENTER_TEXT_COMMENT_DECODED_TYPE) {

        return null;

    }

    // The documented text field of that type. A `comment` property on any
    // other decoded type is never consulted.
    const comment = decoded.comment;

    if (typeof comment !== "string") {

        return null;

    }

    return extractPaymentReference(comment);

}

/**
 * True when the documented description marks the transaction as completed.
 * Emulated, aborted and failed-phase transactions are excluded.
 *
 * @param {object} transaction
 * @returns {boolean}
 */
function isCompletedTransaction(transaction) {

    if (transaction.emulated === true) {

        return false;

    }

    const description = transaction.description;

    if (description && typeof description === "object") {

        if (description.aborted === true) {

            return false;

        }

        const compute = description.compute_ph;

        if (compute && typeof compute === "object" && compute.success === false) {

            return false;

        }

        const action = description.action;

        if (action && typeof action === "object" && action.success === false) {

            return false;

        }

    }

    return true;

}

/**
 * @param {unknown} payload
 * @returns {void}
 */
function assertEnvelope(payload) {

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {

        throw new ToncenterResponseError(
            "Toncenter transactions payload must be an object",
            { receivedType: typeof payload }
        );

    }

    if (!Array.isArray(payload.transactions)) {

        throw new ToncenterResponseError(
            "Toncenter transactions payload is missing the transactions array",
            { receivedType: typeof payload.transactions }
        );

    }

}

/**
 * Map one documented provider response into Phase 2 provider records.
 *
 * @param {unknown} payload the parsed v3 response body
 * @param {{
 *   walletAddress: string,
 *   destinationWalletId?: string|null,
 *   floorMs: number,
 *   ceilingMs: number,
 *   limit: number
 * }} window the requested observation window
 * @returns {{
 *   records: Array<object>,
 *   rowsReturned: number,
 *   resultWindowComplete: boolean
 * }}
 */
export function mapToncenterTransactionsResponse(payload, {
    walletAddress,
    destinationWalletId = null,
    floorMs,
    ceilingMs,
    limit
}) {

    assertEnvelope(payload);

    const rows = payload.transactions;

    const addressBook = payload.address_book && typeof payload.address_book === "object"
        ? payload.address_book
        : {};

    const walletAddressTrimmed = String(walletAddress).trim();

    // The queried wallet is the ONLY destination this observation window may
    // ever claim. If the queried address is not itself a valid TON address,
    // no row can be verified as belonging to it: mapping fails closed instead
    // of attributing transfers by string luck.
    const walletIdentity = tonAddressIdentityOrNull(walletAddressTrimmed);

    if (walletIdentity === null) {

        throw new ToncenterResponseError(
            "Toncenter transactions cannot be mapped: the queried wallet"
                + " address is not a valid TON address",
            { account: walletAddressTrimmed }
        );

    }

    const records = [];

    for (const transaction of rows) {

        if (!transaction || typeof transaction !== "object") {

            throw new ToncenterResponseError(
                "Toncenter transactions array must contain objects"
            );

        }

        // Transaction identity: hash + account are mandatory.
        if (!isNonEmptyString(transaction.hash)) {

            throw new ToncenterResponseError(
                "Toncenter transaction is missing its hash",
                { account: walletAddressTrimmed }
            );

        }

        // Generation time: documented v3 field is `now` (epoch seconds).
        if (!Number.isSafeInteger(transaction.now) || transaction.now <= 0) {

            throw new ToncenterResponseError(
                "Toncenter transaction is missing a usable generation time",
                {
                    transactionHash: transaction.hash,
                    now: transaction.now
                }
            );

        }

        const transactionTimeMs = transaction.now * UTC_SECOND;

        // Bounded window: only in-window transactions are observations.
        if (transactionTimeMs < floorMs || transactionTimeMs > ceilingMs) {

            continue;

        }

        // Only completed incoming value transfers qualify.
        if (!isCompletedTransaction(transaction)) {

            continue;

        }

        const message = transaction.in_msg;

        if (!message || typeof message !== "object") {

            continue;

        }

        const source = resolveAddress(message.source, addressBook);

        const destination = resolveAddress(message.destination, addressBook);

        if (destination === "" || source === "") {

            continue;

        }

        // The documented `account` parameter accepts any address form (hex,
        // base64, base64url), while response addresses are raw and the
        // address_book maps raw -> user_friendly. A row returned for the
        // queried account is one whose message destination denotes the SAME
        // TON ACCOUNT as the queried wallet, compared through validated
        // canonical identities (`workchain:hash`) instead of string equality:
        // a raw `in_msg.destination` matches a user-friendly queried wallet,
        // and no row can be attributed to another wallet by accident. The
        // address book is never consulted for this decision.
        const destinationMatchesWallet = tonAddressIdentitiesEqual(
            walletAddressTrimmed,
            message.destination
        );

        // Corroboration: the row's own `account` field is the queried account
        // as the provider saw it. A row whose message destination denotes the
        // same account as that field is addressed to the queried wallet, no
        // matter which representation either side chose.
        const accountMatchesWallet = isNonEmptyString(transaction.account)
            && tonAddressIdentitiesEqual(
                transaction.account,
                message.destination
            );

        if (!destinationMatchesWallet && !accountMatchesWallet) {

            continue;

        }

        // Exact integer atomic units, no floating-point conversion.
        if (message.value === undefined || message.value === null) {

            continue;

        }

        if (!isDigitString(message.value)) {

            throw new ToncenterResponseError(
                "Toncenter message value must be a non-negative integer string",
                {
                    transactionHash: transaction.hash,
                    value: message.value
                }
            );

        }

        if (BigInt(message.value) <= 0n) {

            // Zero-value message: not a value transfer.
            continue;

        }

        // The payment reference travels inside the native TON comment. Only
        // the documented `text_comment` body holding exactly
        // `WW1:<paymentReference>` qualifies; every other body leaves this
        // record without any payment identity.
        const comment = extractPaymentReferenceComment(message);

        records.push(Object.freeze({
            network: TONCENTER_NETWORK,
            accountId: walletAddressTrimmed,
            transactionId: transaction.hash,
            transactionTime: transactionTimeMs,
            direction: "incoming",
            destinationWalletId: destinationWalletId ?? null,
            sourceAddress: source,
            destinationAddress: destination,
            amountAtomic: message.value,
            asset: TONCENTER_ASSET,
            comment,
            confirmed: true,
            aborted: false
        }));

    }

    return Object.freeze({
        records: Object.freeze([...records]),
        rowsReturned: rows.length,
        resultWindowComplete: rows.length < limit
    });

}
