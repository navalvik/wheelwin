/**
 * Phase 3B — TON address canonical identity (ISOLATED).
 *
 * Fully self-contained: pure functions over in-memory strings. No network,
 * node, endpoint, credential or real wallet is ever contacted, and no `.env`
 * / wallet-secret file is read or modified.
 *
 * Covered scenarios:
 *   1. A raw address matches its equivalent `EQ…` user-friendly address
 *   2. A raw address matches the equivalent `UQ…` representation
 *   3. Standard Base64 and Base64URL encodings of the same account match
 *   4. A different account hash never matches
 *   5. A different workchain never matches
 *   6. Invalid Base64, malformed raw addresses, invalid tags and bad
 *      checksums are rejected (never repaired, never approximated)
 *   7. Canonical identity format, metadata and helper behaviour
 *
 * Every friendly fixture below carries a correctly computed CRC16-XMODEM
 * checksum. Nothing in this file is a payment, a payment confirmation, or a
 * reference to any real wallet or transfer: the accounts are synthetic.
 *
 * Project convention: plain ESM + a manual `assert` harness; no test framework
 * and no external dependencies are required.
 */

import {
    TON_ADDRESS_FORM,
    TON_ADDRESS_TAG,
    TON_FRIENDLY_ENCODING,
    TonAddressIdentityError,
    deriveTonAddressIdentity,
    isCanonicalTonAddressIdentity,
    parseTonAddress,
    tonAddressIdentitiesEqual,
    tonAddressIdentityOrNull
} from "../payment/incoming/TonAddressIdentity.js";

// ---------------------------------------------------------------------------
// Minimal assertion harness (project convention)
// ---------------------------------------------------------------------------

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

let checksPassed = 0;

function check(condition, message) {

    assert(condition, message);

    checksPassed += 1;

}

function expectThrow(fn, expectedName, message) {

    let thrown = null;

    try {

        fn();

    } catch (error) {

        thrown = error;

    }

    assert(
        thrown !== null,
        `${message} (expected ${expectedName}, nothing thrown)`
    );

    assert(
        thrown?.name === expectedName,
        `${message} (expected ${expectedName}, got ${thrown?.name}: ${thrown?.message})`
    );

    return thrown;

}

// ---------------------------------------------------------------------------
// Synthetic account fixtures (test data only — not real payments)
//
// The hash constants repeat a 32-hex-character block to exactly 64
// hexadecimal characters; every friendly form was produced with the same
// CRC16/XMODEM + base64 encoding the utility validates.
// ---------------------------------------------------------------------------

const BLOCK = (hex) => hex.repeat(2);

const WALLET_HASH = BLOCK("9f1e2d3c4b5a69788796a5b4c3d2e1f0");
const SENDER_HASH = BLOCK("8e0d1b9c2a3f4e5d6c7b8a9f0e1d2c3b");
const OTHER_WALLET_HASH = BLOCK("11223344556677889900aabbccddeeff");

const RAW_WALLET = `0:${WALLET_HASH}`;
const RAW_SENDER = `0:${SENDER_HASH}`;
const RAW_OTHER_WALLET = `0:${OTHER_WALLET_HASH}`;

// Same account hash, different (negative) workchain.
const RAW_WALLET_NEGATIVE_WORKCHAIN = `-1:${WALLET_HASH}`;

// One byte differs: a different account.
const OTHER_HASH_ONE_BYTE_OFF = `${WALLET_HASH.slice(0, 63)}`
    + `${WALLET_HASH[63] === "0" ? "1" : "0"}`;

const RAW_OTHER_ACCOUNT = `0:${OTHER_HASH_ONE_BYTE_OFF}`;

const IDENTITY_WALLET = `0:${WALLET_HASH}`;
const IDENTITY_WALLET_NEGATIVE_WORKCHAIN = `-1:${WALLET_HASH}`;
const IDENTITY_OTHER_ACCOUNT = `0:${OTHER_HASH_ONE_BYTE_OFF}`;
const IDENTITY_SENDER = `0:${SENDER_HASH}`;

// Friendly forms of the wallet account (bounceable / non-bounceable,
// base64url / base64, test-only).
const EQ_WALLET = "EQCfHi08S1ppeIeWpbTD0uHwnx4tPEtaaXiHlqW0w9Lh8AKu";
const EQ_WALLET_STANDARD = "EQCfHi08S1ppeIeWpbTD0uHwnx4tPEtaaXiHlqW0w9Lh8AKu";
const UQ_WALLET = "UQCfHi08S1ppeIeWpbTD0uHwnx4tPEtaaXiHlqW0w9Lh8F9r";
const UQ_WALLET_STANDARD = "UQCfHi08S1ppeIeWpbTD0uHwnx4tPEtaaXiHlqW0w9Lh8F9r";
const KQ_WALLET = "kQCfHi08S1ppeIeWpbTD0uHwnx4tPEtaaXiHlqW0w9Lh8Lkk";

// Friendly forms of the sender account.
const EQ_SENDER = "EQCODRucKj9OXWx7ip8OHSw7jg0bnCo_Tl1se4qfDh0sO2Yb";
const EQ_SENDER_STANDARD = "EQCODRucKj9OXWx7ip8OHSw7jg0bnCo/Tl1se4qfDh0sO2Yb";
const UQ_SENDER = "UQCODRucKj9OXWx7ip8OHSw7jg0bnCo_Tl1se4qfDh0sOzve";
const UQ_SENDER_STANDARD = "UQCODRucKj9OXWx7ip8OHSw7jg0bnCo/Tl1se4qfDh0sOzve";

// Friendly forms of the other-wallet account.
const EQ_OTHER_WALLET = "EQARIjNEVWZ3iJkAqrvM3e7_ESIzRFVmd4iZAKq7zN3u_5oS";
const UQ_OTHER_WALLET = "UQARIjNEVWZ3iJkAqrvM3e7_ESIzRFVmd4iZAKq7zN3u_8fX";

// One byte off: same workchain, different account hash.
const EQ_OTHER_ACCOUNT = "EQCfHi08S1ppeIeWpbTD0uHwnx4tPEtaaXiHlqW0w9Lh8RKP";

// Same account hash, different workchain.
const EQ_WALLET_NEGATIVE_WORKCHAIN = "Ef-fHi08S1ppeIeWpbTD0uHwnx4tPEtaaXiHlqW0w9Lh8P3m";

// ---------------------------------------------------------------------------
// Group 1 — a raw address matches its equivalent EQ… friendly address
// ---------------------------------------------------------------------------

{

    const rawIdentity = deriveTonAddressIdentity(RAW_WALLET);

    const friendlyIdentity = deriveTonAddressIdentity(EQ_WALLET);

    check(
        rawIdentity === IDENTITY_WALLET,
        "a raw address must canonicalize to `<workchain>:<lowercase hash>`"
    );

    check(
        friendlyIdentity === rawIdentity,
        "a raw address must match its equivalent EQ… user-friendly address"
    );

    check(
        tonAddressIdentitiesEqual(RAW_WALLET, EQ_WALLET) === true,
        "raw ↔ EQ equality must hold"
    );

    check(
        tonAddressIdentitiesEqual(EQ_WALLET, RAW_WALLET) === true,
        "EQ ↔ raw equality must be symmetric"
    );

    check(
        tonAddressIdentitiesEqual(EQ_WALLET, EQ_WALLET_STANDARD) === true,
        "the base64 and base64url encodings of one account must be equal"
    );

    // The raw form itself may be spelled with uppercase hex and whitespace.
    check(
        deriveTonAddressIdentity(`  ${RAW_WALLET.toUpperCase()}  `)
            === rawIdentity,
        "uppercase raw hex and surrounding whitespace must canonicalize"
    );

    check(
        deriveTonAddressIdentity(`  ${EQ_WALLET}  `) === rawIdentity,
        "surrounding whitespace around a friendly address must be trimmed"
    );

    console.log("[1/7] raw addresses match EQ friendly addresses: PASS");

}

// ---------------------------------------------------------------------------
// Group 2 — UQ… (non-bounceable) representations of the same account
// ---------------------------------------------------------------------------

{

    const bounceable = deriveTonAddressIdentity(EQ_WALLET);

    const nonBounceable = deriveTonAddressIdentity(UQ_WALLET);

    check(
        bounceable === nonBounceable,
        "bounceable and non-bounceable encodings of one account must be equal"
    );

    check(
        tonAddressIdentitiesEqual(RAW_WALLET, UQ_WALLET) === true,
        "a raw address must match the UQ representation of the same account"
    );

    check(
        tonAddressIdentitiesEqual(EQ_WALLET, UQ_WALLET) === true,
        "EQ and UQ encodings of one account must match"
    );

    check(
        tonAddressIdentitiesEqual(
            UQ_WALLET_STANDARD,
            UQ_WALLET
        ) === true,
        "the UQ standard-base64 and base64url forms must match"
    );

    // Display flags are preserved as metadata but never change identity.
    const parsed = parseTonAddress(KQ_WALLET);

    check(
        parsed.bounceable === true
            && parsed.testOnly === true
            && parsed.tag === TON_ADDRESS_TAG.TEST_ONLY_BOUNCEABLE,
        "bounceable/test-only display flags must be preserved as metadata"
    );

    check(
        deriveTonAddressIdentity(KQ_WALLET) === bounceable,
        "a test-only flag must never change the account identity"
    );

    check(
        tonAddressIdentitiesEqual(RAW_SENDER, EQ_SENDER) === true
            && tonAddressIdentitiesEqual(RAW_SENDER, UQ_SENDER) === true,
        "raw sender addresses must match both friendly sender forms"
    );

    console.log("[2/7] UQ (non-bounceable) representations: PASS");

}

// ---------------------------------------------------------------------------
// Group 3 — standard Base64 and Base64URL encodings
// ---------------------------------------------------------------------------

{

    check(
        parseTonAddress(EQ_WALLET).form === TON_ADDRESS_FORM.FRIENDLY,
        "a friendly address must report the friendly form"
    );

    check(
        deriveTonAddressIdentity(EQ_SENDER_STANDARD)
            === deriveTonAddressIdentity(EQ_SENDER),
        "standard base64 and base64url EQ forms must share one identity"
    );

    check(
        deriveTonAddressIdentity(UQ_SENDER_STANDARD)
            === deriveTonAddressIdentity(UQ_SENDER),
        "standard base64 and base64url UQ forms must share one identity"
    );

    check(
        tonAddressIdentitiesEqual(
            EQ_WALLET_STANDARD,
            UQ_WALLET_STANDARD
        ) === true,
        "encoding and bounceable flag together never change identity"
    );

    check(
        parseTonAddress(EQ_SENDER).form === TON_ADDRESS_FORM.RAW
            || parseTonAddress(EQ_SENDER).form === TON_ADDRESS_FORM.FRIENDLY,
        "form metadata is reported through the declared vocabulary"
    );

    check(
        parseTonAddress(RAW_SENDER).form === TON_ADDRESS_FORM.RAW
            && parseTonAddress(RAW_SENDER).encoding === null
            && parseTonAddress(EQ_SENDER).encoding === TON_FRIENDLY_ENCODING.BASE64URL,
        "raw and friendly forms must be distinguishable in metadata"
    );

    console.log("[3/7] base64 and base64url encodings: PASS");

}

// ---------------------------------------------------------------------------
// Group 4 — a different account hash never matches
// ---------------------------------------------------------------------------

{

    check(
        deriveTonAddressIdentity(RAW_OTHER_ACCOUNT) === IDENTITY_OTHER_ACCOUNT,
        "a second account canonicalizes to its own identity"
    );

    check(
        tonAddressIdentitiesEqual(RAW_WALLET, RAW_OTHER_ACCOUNT) === false,
        "a different account hash (raw ↔ raw) must never match"
    );

    check(
        tonAddressIdentitiesEqual(EQ_WALLET, EQ_OTHER_ACCOUNT) === false,
        "a different account hash (friendly ↔ friendly) must never match"
    );

    check(
        tonAddressIdentitiesEqual(RAW_WALLET, EQ_OTHER_ACCOUNT) === false,
        "a different account hash (raw ↔ friendly) must never match"
    );

    check(
        tonAddressIdentitiesEqual(
            EQ_WALLET,
            deriveTonAddressIdentity(RAW_OTHER_WALLET)
        ) === false,
        "an entirely different wallet must never match the room wallet"
    );

    check(
        tonAddressIdentitiesEqual(RAW_WALLET, EQ_OTHER_WALLET) === false
            && tonAddressIdentitiesEqual(RAW_WALLET, UQ_OTHER_WALLET) === false,
        "a different friendly wallet must never match"
    );

    console.log("[4/7] different account hashes never match: PASS");

}

// ---------------------------------------------------------------------------
// Group 5 — a different workchain never matches
// ---------------------------------------------------------------------------

{

    check(
        deriveTonAddressIdentity(RAW_WALLET_NEGATIVE_WORKCHAIN)
            === IDENTITY_WALLET_NEGATIVE_WORKCHAIN,
        "a negative workchain must canonicalize with its signed value"
    );

    check(
        deriveTonAddressIdentity(EQ_WALLET_NEGATIVE_WORKCHAIN)
            === IDENTITY_WALLET_NEGATIVE_WORKCHAIN,
        "a friendly negative-workchain address must canonicalize correctly"
    );

    check(
        tonAddressIdentitiesEqual(RAW_WALLET, RAW_WALLET_NEGATIVE_WORKCHAIN) === false,
        "the same hash on a different workchain must never match"
    );

    check(
        tonAddressIdentitiesEqual(
            EQ_WALLET,
            EQ_WALLET_NEGATIVE_WORKCHAIN
        ) === false,
        "friendly addresses on different workchains must never match"
    );

    check(
        tonAddressIdentitiesEqual(
            RAW_WALLET_NEGATIVE_WORKCHAIN,
            EQ_WALLET
        ) === false,
        "a negative-workchain raw address never matches a base workchain"
    );

    console.log("[5/7] different workchains never match: PASS");

}

// ---------------------------------------------------------------------------
// Group 6 — malformed and unsupported addresses are rejected, never repaired
// ---------------------------------------------------------------------------

{

    // Invalid Base64 / malformed friendly addresses (length, alphabet,
    // padding, URL schemes) and invalid raw forms.
    const invalidValues = [

        // Wrong length.
        ["friendly too short", EQ_WALLET.slice(0, 47)],
        ["friendly too long", `${EQ_WALLET}x`],

        // Invalid alphabets / padding.
        ["invalid base64 characters", `${EQ_WALLET.slice(0, 40)}!!!`],
        ["padded friendly address", `${EQ_WALLET}=`],
        ["mixed base64 alphabets", `${EQ_SENDER.slice(0, 47)}_`],
        ["url scheme prefix", `ton://${EQ_WALLET}`],
        ["transfer url", `ton://transfer/${EQ_WALLET}`],

        // Raw form violations.
        ["raw hash too short", `0:${SENDER_HASH.slice(0, 63)}`],
        ["raw hash too long", `0:${SENDER_HASH}00`],
        ["raw hash not hexadecimal", `0:${SENDER_HASH.slice(0, 63)}z`],
        ["raw without workchain", SENDER_HASH],
        ["raw with plus-signed workchain", `+0:${SENDER_HASH}`],
        ["raw with leading zeros", `00:${SENDER_HASH}`],
        ["raw workchain out of int8 range", `128:${SENDER_HASH}`],
        ["raw workchain below int8 range", `-129:${SENDER_HASH}`],
        ["raw with empty hash", `0:`],

        // Tag violations.
        ["unsupported friendly tag", `FQ${EQ_WALLET.slice(2)}`],
        ["unsupported friendly tag byte", "XQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],

        // Checksum violations.
        ["friendly checksum mismatch", EQ_WALLET.slice(0, 47) + "A"],

        // Wrong types and empty values.
        ["empty string", ""],
        ["whitespace only", "   "],
        ["number value", 42],
        ["null value", null],
        ["undefined value", undefined],
        ["object value", {}]

    ];

    for (const [label, value] of invalidValues) {

        const rejected = expectThrow(
            () => deriveTonAddressIdentity(value),
            "TonAddressIdentityError",
            `malformed or unsupported address must be rejected: ${label}`
        );

        check(
            rejected.code === "TON_ADDRESS_IDENTITY_INVALID",
            `${label} must fail with TON_ADDRESS_IDENTITY_INVALID`
        );

        check(
            tonAddressIdentityOrNull(value) === null,
            `${label} must derive no identity`
        );

        check(
            tonAddressIdentitiesEqual(value, EQ_WALLET) === false,
            `${label} must never match another address`
        );

        check(
            tonAddressIdentitiesEqual(EQ_WALLET, value) === false,
            `${label} must never be matched from the other side`
        );

    }

    // A synthetic string is not "valid because it looks like an address":
    // EQ-prefixed text with an invalid payload is rejected, not accepted.
    expectThrow(
        () => deriveTonAddressIdentity("EQSyntheticRoomWallet001_________________________"),
        "TonAddressIdentityError",
        "a fabricated EQ-prefixed string must be rejected"
    );

    console.log("[6/7] malformed addresses rejected: PASS");

}

// ---------------------------------------------------------------------------
// Group 7 — canonical identity format and helper behaviour
// ---------------------------------------------------------------------------

{

    check(
        IDENTITY_WALLET === `0:${WALLET_HASH}`
            && /^-?\d+:[0-9a-f]{64}$/.test(IDENTITY_WALLET),
        "canonical identity is `<signed-workchain>:<lowercase-64-hex-hash>`"
    );

    check(
        deriveTonAddressIdentity(EQ_WALLET) === IDENTITY_WALLET
            && deriveTonAddressIdentity(RAW_WALLET) === IDENTITY_WALLET,
        "every representation of one account must produce one identity"
    );

    check(
        isCanonicalTonAddressIdentity(IDENTITY_WALLET) === true
            && isCanonicalTonAddressIdentity(IDENTITY_WALLET_NEGATIVE_WORKCHAIN) === true,
        "canonical identity strings must be recognizable"
    );

    // The raw representation is already the canonical identity spelling, so
    // a raw address is also recognized as a canonical identity.
    check(
        isCanonicalTonAddressIdentity(RAW_WALLET) === true
            && isCanonicalTonAddressIdentity(IDENTITY_SENDER) === true,
        "a canonical identity string must be recognized as such"
    );

    check(
        isCanonicalTonAddressIdentity(EQ_WALLET) === false
            && isCanonicalTonAddressIdentity("0:" + "0".repeat(63)) === false
            && isCanonicalTonAddressIdentity("nope") === false
            && isCanonicalTonAddressIdentity("") === false
            && isCanonicalTonAddressIdentity(null) === false,
        "non-identity strings must not be recognized as canonical identities"
    );

    // Parsed metadata exposes the validated components.
    const parsed = parseTonAddress(EQ_WALLET);

    check(
        parsed.workchain === 0
            && parsed.hashHex === WALLET_HASH
            && parsed.bounceable === true
            && parsed.testOnly === false
            && parsed.tag === TON_ADDRESS_TAG.BOUNCEABLE
            && parsed.identity === IDENTITY_WALLET,
        "parsed metadata must expose workchain, hash, tag and flags"
    );

    check(
        Object.isFrozen(parsed),
        "parsed metadata must be frozen"
    );

    check(
        parseTonAddress(UQ_WALLET).bounceable === false,
        "a UQ address must report the non-bounceable flag"
    );

    // Invalid values never produce a "best effort" identity.
    check(
        tonAddressIdentityOrNull("EQ-broken-address__")
            === null,
        "the lossless helper returns null for invalid input, never a guess"
    );

    console.log("[7/7] canonical identity + helpers: PASS");

}

console.log(
    `\nIsolated TON address identity tests passed | assertions=${checksPassed}`
        + ` | canonical=<signed-workchain>:<lowercase-256-bit-hash>`
        + ` | crc=crc16-xmodem`
        + ` | encodings=base64,base64url`
        + ` | tags=0x11,0x51,0x91,0xd1`
);

export { checksPassed };
