/**
 * Phase 3B — Provider-independent TON address identity.
 *
 * The same TON account is written in several equivalent ways across the
 * payment layer:
 *
 *   - raw form `workchain:64-hex-account-hash`, used by the Toncenter v3
 *     transaction response (`in_msg.source` / `in_msg.destination`);
 *   - user-friendly form, the 48-character base64/base64url string carried by
 *     the Phase 1 wallet catalog and payment intents (`EQ…`, `UQ…`, and the
 *     test-only `kQ…` / `0Q…` forms);
 *   - both base64 alphabets (`+/`) and base64url (`-_`) are valid encodings of
 *     the same 36-byte payload.
 *
 * This module converts any of those representations into ONE canonical
 * identity:
 *
 *     `<signed-workchain>:<lowercase-256-bit-account-hash>`
 *     e.g. `0:9f1e…6978` or `-1:2cf5…22e3`
 *
 * Identity is derived ONLY from the validated workchain byte and the 32-byte
 * account hash. Bounceable / non-bounceable / test-only display flags are
 * preserved as metadata (they change the string, not the account) and the
 * network is always matched separately and exactly — a test-only tag NEVER
 * implies a network.
 *
 * The utility is deliberately strict (fail closed):
 *
 *   - the encoding is validated before decoding (length, alphabet, no
 *     padding tricks, no URL schemes, no prefix replacement);
 *   - the address tag byte must be a supported TON tag;
 *   - the workchain byte must decode to a signed int8;
 *   - the account hash must be exactly 32 bytes (64 hex characters);
 *   - the CRC16-XMODEM checksum over the first 34 bytes must match;
 *   - nothing is ever repaired, guessed, approximated or lowercased into a
 *     match: a malformed address throws `TonAddressIdentityError`.
 *
 * No external dependency and no network access is used.
 */

import { PaymentValidationError } from "../PaymentErrors.js";

/**
 * Supported first-byte tags of a user-friendly TON address. `0x80` is the
 * test-only display flag; the remaining byte must be one of `0x11` / `0x51`.
 */
export const TON_ADDRESS_TAG = Object.freeze({
    BOUNCEABLE: 0x11,
    NON_BOUNCEABLE: 0x51,
    TEST_ONLY_BOUNCEABLE: 0x91,
    TEST_ONLY_NON_BOUNCEABLE: 0xd1
});

/** Representation a value was parsed from. */
export const TON_ADDRESS_FORM = Object.freeze({
    RAW: "raw",
    FRIENDLY: "friendly"
});

/** Friendly-address alphabet a value was parsed from. */
export const TON_FRIENDLY_ENCODING = Object.freeze({
    BASE64: "base64",
    BASE64URL: "base64url"
});

const TON_TEST_ONLY_FLAG = 0x80;

const TON_ACCOUNT_HASH_BYTES = 32;

/** tag (1) + workchain (1) + account hash (32) + crc16 (2). */
const TON_FRIENDLY_ADDRESS_BYTES = 36;

/** tag (1) + workchain (1) + account hash (32): the checksummed payload. */
const TON_ADDRESS_TEMPLATE_BYTES = 34;

/** A workchain travels as one signed byte, so it is bounded to int8. */
const MIN_TON_WORKCHAIN = -128;
const MAX_TON_WORKCHAIN = 127;

/**
 * Raw form: a signed decimal workchain (no leading zeros, no `+` sign) and
 * exactly 64 hexadecimal characters. Uppercase hex is accepted and
 * canonicalized to lowercase.
 */
const RAW_ADDRESS_PATTERN = /^(-?(?:0|[1-9][0-9]{0,2})):([0-9a-fA-F]{64})$/;

/** Standard base64 alphabet, 48 characters, no padding. */
const FRIENDLY_BASE64_PATTERN = /^[A-Za-z0-9+/]{48}$/;

/** Base64URL alphabet, 48 characters, no padding. */
const FRIENDLY_BASE64URL_PATTERN = /^[A-Za-z0-9\-_]{48}$/;

/** A canonical identity: signed workchain, colon, lowercase 64-hex hash. */
const CANONICAL_IDENTITY_PATTERN =
    /^-?(?:0|[1-9][0-9]{0,2}):[0-9a-f]{64}$/;

/**
 * An address that cannot be validated is rejected — never repaired and never
 * coerced into a match.
 */
export class TonAddressIdentityError extends PaymentValidationError {

    constructor(message, details) {

        super(message, details);

        this.code = "TON_ADDRESS_IDENTITY_INVALID";

    }

}

/**
 * CRC16/XMODEM (poly 0x1021, initial value 0x0000), returned big-endian.
 * This is the checksum TON user-friendly addresses carry in their last two
 * bytes.
 *
 * @param {Buffer} data
 * @returns {[number, number]} `[high, low]` checksum bytes
 */
function crc16Xmodem(data) {

    const poly = 0x1021;

    let register = 0;

    const message = Buffer.alloc(data.length + 2);

    message.set(data);

    for (const byte of message) {

        for (let mask = 0x80; mask > 0; mask >>= 1) {

            register <<= 1;

            if (byte & mask) {

                register += 1;

            }

            if (register > 0xffff) {

                register &= 0xffff;
                register ^= poly;

            }

        }

    }

    return [Math.floor(register / 256), register % 256];

}

/**
 * Parse the raw `workchain:hash` representation.
 *
 * @param {string} value trimmed raw-address candidate
 * @returns {Readonly<{
 *   identity: string,
 *   workchain: number,
 *   hashHex: string,
 *   form: "raw",
 *   encoding: null,
 *   tag: null,
 *   bounceable: null,
 *   testOnly: null
 * }>}
 */
function parseRawAddress(value) {

    const match = RAW_ADDRESS_PATTERN.exec(value);

    if (!match) {

        throw new TonAddressIdentityError(
            "TON raw address must be `<workchain>:<64 hexadecimal characters>`",
            { form: "malformed-raw" }
        );

    }

    const workchain = Number(match[1]);

    if (workchain < MIN_TON_WORKCHAIN || workchain > MAX_TON_WORKCHAIN) {

        throw new TonAddressIdentityError(
            `TON raw address workchain is out of the signed int8 range: `
                + `${workchain}`,
            { workchain }
        );

    }

    const hashHex = match[2].toLowerCase();

    return Object.freeze({
        identity: `${workchain}:${hashHex}`,
        workchain,
        hashHex,
        form: TON_ADDRESS_FORM.RAW,
        encoding: null,
        tag: null,
        bounceable: null,
        testOnly: null
    });

}

/**
 * Classify the friendly-address alphabet. A string containing neither `+/`
 * nor `-_` belongs to both alphabets and is reported as standard base64.
 *
 * @param {string} value
 * @returns {"base64"|"base64url"}
 */
function friendlyEncoding(value) {

    return /[-_]/.test(value)
        ? TON_FRIENDLY_ENCODING.BASE64URL
        : TON_FRIENDLY_ENCODING.BASE64;

}

/**
 * Parse the user-friendly representation: 48 base64/base64url characters
 * encoding 36 bytes (tag, workchain, 32-byte hash, CRC16), all validated
 * before any identity is derived.
 *
 * @param {string} value trimmed friendly-address candidate
 * @returns {Readonly<{
 *   identity: string,
 *   workchain: number,
 *   hashHex: string,
 *   form: "friendly",
 *   encoding: "base64"|"base64url",
 *   tag: number,
 *   bounceable: boolean,
 *   testOnly: boolean
 * }>}
 */
function parseFriendlyAddress(value) {

    const isBase64 = FRIENDLY_BASE64_PATTERN.test(value);

    const isBase64Url = FRIENDLY_BASE64URL_PATTERN.test(value);

    if (!isBase64 && !isBase64Url) {

        throw new TonAddressIdentityError(
            "TON user-friendly address must be exactly 48 characters in the"
                + " standard base64 or base64url alphabet",
            { form: "malformed-friendly" }
        );

    }

    const bytes = Buffer.from(value, "base64");

    if (bytes.length !== TON_FRIENDLY_ADDRESS_BYTES) {

        throw new TonAddressIdentityError(
            "TON user-friendly address must decode to exactly"
                + ` ${TON_FRIENDLY_ADDRESS_BYTES} bytes`,
            { decodedBytes: bytes.length }
        );

    }

    // Tag byte: no unknown display flags tolerate.
    const tagByte = bytes[0];

    const testOnly = (tagByte & TON_TEST_ONLY_FLAG) !== 0;

    const tag = testOnly ? tagByte ^ TON_TEST_ONLY_FLAG : tagByte;

    if (tag !== TON_ADDRESS_TAG.BOUNCEABLE
        && tag !== TON_ADDRESS_TAG.NON_BOUNCEABLE) {

        throw new TonAddressIdentityError(
            `unsupported TON address tag: 0x${tagByte.toString(16)}`,
            { tag: tagByte }
        );

    }

    // CRC16/XMODEM over the first 34 bytes must match the trailing two bytes.
    const [expectedHigh, expectedLow] = crc16Xmodem(
        bytes.subarray(0, TON_ADDRESS_TEMPLATE_BYTES)
    );

    if (bytes[TON_ADDRESS_TEMPLATE_BYTES] !== expectedHigh
        || bytes[TON_ADDRESS_TEMPLATE_BYTES + 1] !== expectedLow) {

        throw new TonAddressIdentityError(
            "TON user-friendly address checksum mismatch (CRC16/XMODEM)",
            { form: "bad-checksum" }
        );

    }

    // Workchain byte: signed int8 (0xff is -1, 0x80 is -128, …).
    const workchainByte = bytes[1];

    const workchain = workchainByte > MAX_TON_WORKCHAIN
        ? workchainByte - 256
        : workchainByte;

    const hashHex = bytes
        .subarray(2, TON_ADDRESS_TEMPLATE_BYTES)
        .toString("hex");

    if (hashHex.length !== TON_ACCOUNT_HASH_BYTES * 2) {

        throw new TonAddressIdentityError(
            "TON user-friendly address must carry a"
                + ` ${TON_ACCOUNT_HASH_BYTES}-byte account hash`,
            { hashBytes: hashHex.length / 2 }
        );

    }

    return Object.freeze({
        identity: `${workchain}:${hashHex}`,
        workchain,
        hashHex,
        form: TON_ADDRESS_FORM.FRIENDLY,
        encoding: friendlyEncoding(value),
        tag: tagByte,
        bounceable: tag === TON_ADDRESS_TAG.BOUNCEABLE,
        testOnly
    });

}

/**
 * Parse any supported TON address representation into validated identity
 * metadata. Throws `TonAddressIdentityError` for anything else — a malformed
 * raw address, a bad base64 payload, an unsupported tag, a wrong length or a
 * failed checksum are all rejections, never repairs.
 *
 * @param {unknown} value a raw or user-friendly TON address
 * @returns {Readonly<{
 *   identity: string,
 *   workchain: number,
 *   hashHex: string,
 *   form: "raw"|"friendly",
 *   encoding: null|"base64"|"base64url",
 *   tag: number|null,
 *   bounceable: boolean|null,
 *   testOnly: boolean|null
 * }>}
 */
export function parseTonAddress(value) {

    if (typeof value !== "string") {

        throw new TonAddressIdentityError(
            "TON address must be a string",
            { receivedType: typeof value }
        );

    }

    const trimmed = value.trim();

    if (trimmed === "") {

        throw new TonAddressIdentityError(
            "TON address must be a non-empty string"
        );

    }

    if (RAW_ADDRESS_PATTERN.test(trimmed)) {

        return parseRawAddress(trimmed);

    }

    if (FRIENDLY_BASE64_PATTERN.test(trimmed)
        || FRIENDLY_BASE64URL_PATTERN.test(trimmed)) {

        return parseFriendlyAddress(trimmed);

    }

    throw new TonAddressIdentityError(
        "value is neither a TON raw address (workchain:64-hex-hash) nor a"
            + " 48-character user-friendly address",
        { form: "unrecognized" }
    );

}

/**
 * Canonical account identity of one TON address:
 * `<signed-workchain>:<lowercase-256-bit-account-hash>`.
 *
 * @param {unknown} value a raw or user-friendly TON address
 * @returns {string} canonical identity, e.g. `-1:2cf5…22e3`
 */
export function deriveTonAddressIdentity(value) {

    return parseTonAddress(value).identity;

}

/**
 * Canonical identity, or `null` when the value is not a valid TON address.
 * Never throws: callers that must fail closed (rather than crash) on a
 * malformed address use this.
 *
 * @param {unknown} value a raw or user-friendly TON address
 * @returns {string|null}
 */
export function tonAddressIdentityOrNull(value) {

    try {

        return deriveTonAddressIdentity(value);

    } catch {

        return null;

    }

}

/**
 * Equality by canonical account identity. Both sides must be valid TON
 * addresses; a malformed side can never match anything.
 *
 * @param {unknown} left a raw or user-friendly TON address
 * @param {unknown} right a raw or user-friendly TON address
 * @returns {boolean}
 */
export function tonAddressIdentitiesEqual(left, right) {

    const leftIdentity = tonAddressIdentityOrNull(left);

    if (leftIdentity === null) {

        return false;

    }

    const rightIdentity = tonAddressIdentityOrNull(right);

    return rightIdentity !== null && leftIdentity === rightIdentity;

}

/**
 * Structural check that a value already IS a canonical identity string (and
 * not some other address form that merely looks similar).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCanonicalTonAddressIdentity(value) {

    if (typeof value !== "string"
        || !CANONICAL_IDENTITY_PATTERN.test(value)) {

        return false;

    }

    const workchain = Number(value.slice(0, value.indexOf(":")));

    return workchain >= MIN_TON_WORKCHAIN && workchain <= MAX_TON_WORKCHAIN;

}
