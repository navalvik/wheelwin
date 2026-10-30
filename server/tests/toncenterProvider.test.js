/**
 * Phase 3C — Toncenter Testnet read-only provider (ISOLATED).
 *
 * All provider interaction is mocked in-process: every client in this file is
 * constructed with an injected `fetchImpl` mock, so the live provider is
 * never contacted and no real API key is read (the tests inject a clearly
 * synthetic key fixture through `apiKeyProvider` and only assert that the
 * same fixture value is sent — nothing real is exposed).
 *
 * Covered scenarios (per Phase 3 scope):
 *   1. Correct Testnet endpoint and X-API-Key header wiring (key not exposed)
 *   2. Configurable request rate and rejection of invalid limits
 *   3. Several concurrent rooms queued without a fixed 1-RPS bottleneck
 *   4. One request per explicit room check; one shared request for
 *      simultaneous checks of the same room
 *   5. No background requests and no automatic retries
 *   6. HTTP 401, 403, 429, 5xx, timeout and malformed responses
 *   7. Transaction normalization using the documented v3 response format
 *   8. Observation never marks an intent paid or confirmed
 *   9. Canonical address identity through the mapper (raw ↔ friendly)
 *  10. Native TON payment reference extraction (Phase 3C): only an explicit
 *      `text_comment` body carrying exactly `WW1:<paymentReference>` yields a
 *      payment reference; identity and replay protection stay unchanged
 *
 * Project convention: plain ESM + a manual `assert` harness; no test framework
 * and no external dependencies are required.
 */

import {
    TONCENTER_DEFAULT_MAX_REQUESTS_PER_SECOND,
    TONCENTER_DOCUMENTED_FREE_PLAN_RPS,
    TONCENTER_MAX_TRANSACTION_LIMIT,
    TONCENTER_TEXT_COMMENT_DECODED_TYPE,
    ToncenterIncomingProvider,
    ToncenterRateLimiter,
    ToncenterTransactionsClient,
    RoomPaymentObservationService,
    assertToncenterRateConfiguration,
    mapToncenterTransactionsResponse
} from "../payment/toncenter/index.js";

import * as paymentReferenceCodec from "../payment/incoming/PaymentReferenceCodec.js";

import {
    PAYMENT_REFERENCE_COMMENT_PREFIX,
    PAYMENT_REFERENCE_MAX_LENGTH,
    PAYMENT_REFERENCE_REJECTION_REASON,
    PaymentReferenceFormatError,
    extractPaymentReference,
    formatPaymentReference,
    inspectPaymentReferenceComment,
    isPaymentReference,
    isPaymentReferenceComment,
    PAYMENT_CONFIRMATION_DISPOSITION,
    IncomingTransfer,
    IncomingTransferAdapter,
    IncomingTransferProviderClient,
    INCOMING_TRANSFER_ADAPTER_FORBIDDEN_OPERATIONS,
    ObservationConflictError,
    assertNoOperations,
    assertReadOnlyProviderClient,
    deriveIncomingTransactionId,
    isPaymentConfirmationDisposition,
    matchIncomingTransferToIntent,
    normalizeIncomingTransferRecord
} from "../payment/incoming/index.js";

import { PaymentIntent, PaymentReferenceCollisionError } from "../payment/index.js";

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

async function expectThrowAsync(fn, expectedName, message) {

    let thrown = null;

    try {

        await fn();

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
// Synthetic fixtures (test data only — not real payments or wallet material)
// ---------------------------------------------------------------------------

/** Synthetic key fixture. Not a real credential; never read from the environment. */
const SYNTHETIC_API_KEY = "SYNTHETIC-TONCENTER-TEST-KEY-NOT-REAL";

/**
 * Synthetic TON account fixtures with correctly computed CRC16/XMODEM
 * checksums (synthetic test data only). Raw addresses are the `workchain:hash`
 * form a live v3 response reports; friendly addresses are the equivalent
 * user-friendly encodings used by the Phase 1 wallet catalog.
 */
const RAW_SENDER = "0:8e0d1b9c2a3f4e5d8e0d1b9c2a3f4e5d8e0d1b9c2a3f4e5d8e0d1b9c2a3f4e5d";
const RAW_WALLET = "0:9f1e2d3c4b5a69789f1e2d3c4b5a69789f1e2d3c4b5a69789f1e2d3c4b5a6978";
const RAW_OTHER_WALLET = "0:1122334455667788112233445566778811223344556677881122334455667788";

/** A different wallet account and a different sender account. */
const RAW_WRONG_WALLET = "0:0a1b2c3d4e5f60710a1b2c3d4e5f60710a1b2c3d4e5f60710a1b2c3d4e5f6071";
const RAW_WRONG_SENDER = "0:0f1e2d3c4b5a69780f1e2d3c4b5a69780f1e2d3c4b5a69780f1e2d3c4b5a6978";

const FRIENDLY_SENDER = "EQCODRucKj9OXY4NG5wqP05djg0bnCo_Tl2ODRucKj9OXb_f";
const FRIENDLY_WALLET = "EQCfHi08S1ppeJ8eLTxLWml4nx4tPEtaaXifHi08S1ppeGIL";
const FRIENDLY_OTHER_WALLET = "EQARIjNEVWZ3iBEiM0RVZneIESIzRFVmd4gRIjNEVWZ3iNVe";
/** Non-bounceable and standard-base64 forms of the same room wallet. */
const FRIENDLY_WALLET_UQ = "UQCfHi08S1ppeJ8eLTxLWml4nx4tPEtaaXifHi08S1ppeD_O";
const FRIENDLY_SENDER_STANDARD = "EQCODRucKj9OXY4NG5wqP05djg0bnCo/Tl2ODRucKj9OXb/f";

const FIXTURE_TX_HASH = "5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5";
const OTHER_TX_HASH = "6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6";

/** v3 `now` is epoch SECONDS; Phase 2 transactionTime is epoch MILLISECONDS. */
const FIXTURE_NOW_SECONDS = 1_700_000_123;
const FIXTURE_NOW_MS = FIXTURE_NOW_SECONDS * 1000;

/**
 * The Phase 1 payment reference of the synthetic fixture. It is the identity
 * of the synthetic payment and the key of its payment intent.
 */
const FIXTURE_PAYMENT_REFERENCE = "WW-PAY-ROOM1-0001";

/**
 * Phase 3C native TON comment wire format: `WW1:<paymentReference>`. This is
 * the ONLY comment form that carries a payment reference.
 */
const FIXTURE_PAYMENT_COMMENT = `${PAYMENT_REFERENCE_COMMENT_PREFIX}${FIXTURE_PAYMENT_REFERENCE}`;

const FIXTURE_AMOUNT_ATOMIC = "2000000000";

const FIXTURE_FLOOR_MS = 1_700_000_000_000;
const FIXTURE_CEILING_MS = 1_700_000_500_000;

/** One transaction in the documented v3 response shape. */
function toncenterTransaction(overrides = {}) {

    return {
        account: RAW_WALLET,
        hash: FIXTURE_TX_HASH,
        lt: "40576730000001",
        now: FIXTURE_NOW_SECONDS,
        orig_status: "active",
        end_status: "active",
        total_fees: "1234",
        prev_trans_hash: "0".repeat(64),
        prev_trans_lt: "40576730000000",
        description: {
            type: "trans_ord",
            aborted: false,
            destroyed: false,
            credit_first: true,
            storage_ph: { status_change: "unchanged" },
            compute_ph: { success: true, exit_code: 0, gas_used: "0" },
            action: { success: true, valid: true, no_funds: false }
        },
        in_msg: {
            hash: "a".repeat(64),
            source: RAW_SENDER,
            destination: RAW_WALLET,
            value: FIXTURE_AMOUNT_ATOMIC,
            fwd_fee: "1",
            ihr_fee: "0",
            created_lt: "40576730000001",
            created_at: String(FIXTURE_NOW_SECONDS),
            opcode: 0,
            bounce: true,
            bounced: false,
            message_content: {
                hash: "b".repeat(64),
                body: "te6cckEBAQEAAgAAAEysuc0=",
                decoded: {
                    type: TONCENTER_TEXT_COMMENT_DECODED_TYPE,
                    comment: FIXTURE_PAYMENT_COMMENT
                }
            }
        },
        out_msgs: [],
        ...overrides
    };

}

/** Documented response envelope with its address book (raw -> user_friendly). */
function toncenterResponse(transactions, addressBook = {}) {

    return {
        transactions,
        address_book: {
            [RAW_SENDER]: { domain: null, user_friendly: FRIENDLY_SENDER },
            [RAW_WALLET]: { domain: null, user_friendly: FRIENDLY_WALLET },
            [RAW_OTHER_WALLET]: { domain: null, user_friendly: FRIENDLY_OTHER_WALLET },
            ...addressBook
        }
    };

}

/** Mutable Phase 1 payment intent matching the synthetic fixture transfer. */
function buildIntent(overrides = {}) {

    return new PaymentIntent({
        paymentReference: FIXTURE_PAYMENT_REFERENCE,
        roomId: "room-synthetic-001",
        playerId: "player-synthetic-001",
        network: "testnet",
        destinationWalletId: "room-wallet-001",
        destinationWalletAddress: FRIENDLY_WALLET,
        expectedSender: FRIENDLY_SENDER,
        amountAtomic: Number(FIXTURE_AMOUNT_ATOMIC),
        asset: "TON",
        createdAt: FIXTURE_FLOOR_MS,
        expiresAt: 1_700_000_100_000,
        roomDeadlineMs: 1_700_000_480_000,
        ...overrides
    });

}

/**
 * In-process fetch mock. Records every call; never performs real I/O.
 */
function mockFetch(options = {}) {

    const calls = [];

    const fetchImpl = async (url, init) => {

        calls.push({ url: String(url), init });

        if (options.networkError) {

            throw options.networkError;

        }

        if (options.abortOnSignal) {

            return await new Promise((_resolve, reject) => {

                init?.signal?.addEventListener("abort", () => {

                    const error = new Error("The operation was aborted due to timeout");

                    error.name = "TimeoutError";

                    reject(error);

                });

            });

        }

        if (options.jsonError) {

            return {
                status: options.status ?? 200,
                json: async () => {

                    throw options.jsonError;

                }
            };

        }

        return {
            status: options.status ?? 200,
            json: async () => (
                Object.prototype.hasOwnProperty.call(options, "payload")
                    ? options.payload
                    : toncenterResponse([])
            )
        };

    };

    return { fetchImpl, calls };

}

/** Deterministic virtual clock so rate behaviour never waits on real time. */
function createVirtualClock() {

    let current = 0;

    const scheduled = [];

    return {
        now: () => current,
        currentTime: () => current,
        delay: (ms) => new Promise((resolve) => {

            scheduled.push({ at: current + ms, resolve });

        }),
        get pendingCount() {

            return scheduled.length;

        },
        advanceToNext: async () => {

            if (scheduled.length === 0) {

                return false;

            }

            scheduled.sort((a, b) => a.at - b.at);

            const next = scheduled.shift();

            current = Math.max(current, next.at);

            next.resolve();

            await new Promise((resolve) => setImmediate(resolve));

            return true;

        }
    };

}

/** Runs async work while the virtual clock keeps advancing. */
async function runWithVirtualClock(clock, fn) {

    let running = true;

    const driver = (async () => {

        while (running) {

            await new Promise((resolve) => setImmediate(resolve));

            if (clock.pendingCount > 0) {

                await clock.advanceToNext();

            }

        }

    })();

    try {

        return await fn();

    } finally {

        running = false;

        await driver;

    }

}

/** Full harness over the in-process fetch mock. */
function buildHarness(overrides = {}) {

    const clock = createVirtualClock();

    const fetchMock = mockFetch(overrides.fetch ?? {});

    const client = new ToncenterTransactionsClient({
        apiKeyProvider: () => overrides.apiKey ?? SYNTHETIC_API_KEY,
        fetchImpl: fetchMock.fetchImpl,
        timeoutMs: overrides.timeoutMs ?? 15_000
    });

    const provider = new ToncenterIncomingProvider({ client });

    const service = new RoomPaymentObservationService({
        provider,
        rateLimiter: overrides.rateLimiter ?? new ToncenterRateLimiter({
            requestsPerSecond: overrides.requestsPerSecond,
            now: clock.now,
            delay: clock.delay
        }),
        limit: overrides.limit,
        nowProvider: () => FIXTURE_NOW_MS + 60_000
    });

    return { service, provider, client, fetchMock, clock };

}

/** One explicit room-payment check against the synthetic fixture. */
function checkRoom(service, overrides = {}) {

    return service.checkRoomPayments({
        roomId: "room-synthetic-001",
        walletAddress: FRIENDLY_WALLET,
        paymentIntents: [buildIntent()],
        floorMs: FIXTURE_FLOOR_MS,
        ceilingMs: FIXTURE_CEILING_MS,
        ...overrides
    });

}

// ---------------------------------------------------------------------------
// Group 1 — endpoint and X-API-Key header wiring
// ---------------------------------------------------------------------------

{

    const harness = buildHarness({

        fetch: { payload: toncenterResponse([toncenterTransaction()]) }

    });

    const payload = await harness.client.getTransactions({
        account: FRIENDLY_WALLET,
        startUtime: 1_699_999_999,
        endUtime: 1_700_000_501,
        limit: 50
    });

    check(harness.fetchMock.calls.length === 1, "exactly one HTTP request per query");

    const call = harness.fetchMock.calls[0];

    const url = new URL(call.url);

    check(
        url.origin + url.pathname === "https://testnet.toncenter.com/api/v3/transactions",
        "the official Testnet v3 transactions endpoint must be used"
    );

    check(
        url.searchParams.get("account") === FRIENDLY_WALLET,
        "only the assigned room wallet may be queried"
    );

    check(
        url.searchParams.get("start_utime") === "1699999999"
            && url.searchParams.get("end_utime") === "1700000501",
        "the bounded transaction-time range must be sent"
    );

    check(
        url.searchParams.get("limit") === "50"
            && url.searchParams.get("sort") === "desc",
        "bounded limit and explicit sort must be sent"
    );

    check(call.init.method === "GET", "only read-only GET requests are issued");

    // Header wiring. The key is compared against the synthetic fixture value;
    // no real key exists in this process and nothing is printed.
    check(
        call.init.headers["X-API-Key"] === SYNTHETIC_API_KEY,
        "the API key must be sent as the X-API-Key request header"
    );

    check(
        !url.searchParams.has("api_key")
            && !call.url.includes(encodeURIComponent(SYNTHETIC_API_KEY)),
        "the key must never travel in the query string"
    );

    check(
        Array.isArray(payload.transactions)
            && payload.transactions.length === 1,
        "the parsed documented envelope must be returned"
    );

    // Missing key: no request is ever sent.
    const missingKeyHarness = buildHarness({ apiKey: "" });

    const missing = await expectThrowAsync(
        () => missingKeyHarness.client.getTransactions({
            account: FRIENDLY_WALLET,
            startUtime: 1,
            endUtime: 2,
            limit: 10
        }),
        "ToncenterApiKeyMissingError",
        "a missing API key must be refused"
    );

    check(
        missing.code === "TONCENTER_API_KEY_MISSING"
            && missing.details.environmentVariable === "TON_API_KEY",
        "the refusal must name the existing TON_API_KEY variable"
    );

    check(
        missingKeyHarness.fetchMock.calls.length === 0,
        "no request may be sent without the key"
    );

    // Query validation happens before any request.
    const invalidQueries = [

        ["empty account", { account: "", startUtime: 1, endUtime: 2, limit: 10 }],
        ["negative start", { account: FRIENDLY_WALLET, startUtime: -1, endUtime: 2, limit: 10 }],
        ["inverted range", { account: FRIENDLY_WALLET, startUtime: 5, endUtime: 2, limit: 10 }],
        ["zero limit", { account: FRIENDLY_WALLET, startUtime: 1, endUtime: 2, limit: 0 }],
        ["over-max limit", { account: FRIENDLY_WALLET, startUtime: 1, endUtime: 2, limit: TONCENTER_MAX_TRANSACTION_LIMIT + 1 }],
        ["float limit", { account: FRIENDLY_WALLET, startUtime: 1, endUtime: 2, limit: 10.5 }]

    ];

    for (const [label, query] of invalidQueries) {

        const invalidHarness = buildHarness({

            fetch: { payload: toncenterResponse([]) }

        });

        await expectThrowAsync(
            () => invalidHarness.client.getTransactions(query),
            "ToncenterRequestError",
            `invalid query must be refused: ${label}`
        );

        check(
            invalidHarness.fetchMock.calls.length === 0,
            `no request may be sent for an invalid query: ${label}`
        );

    }

    console.log("[1/8] endpoint + header wiring: PASS");

}

// ---------------------------------------------------------------------------
// Group 2 — configurable request rate and rejection of invalid limits
// ---------------------------------------------------------------------------

{

    const defaultLimiter = new ToncenterRateLimiter();

    check(
        defaultLimiter.policy().requestsPerSecond
            === TONCENTER_DEFAULT_MAX_REQUESTS_PER_SECOND,
        "the authenticated default rate must be 8 requests/second"
    );

    check(
        defaultLimiter.policy().requestsPerSecond === 8
            && TONCENTER_DEFAULT_MAX_REQUESTS_PER_SECOND
                < TONCENTER_DOCUMENTED_FREE_PLAN_RPS,
        "the default must sit below the documented Free-plan ceiling of 10"
    );

    check(
        defaultLimiter.policy().subscriptionPlanVerified === false,
        "the subscription tier is unverified and must be reported as such"
    );

    for (const badRate of [0, -1, 1.5, Number.NaN, "8", null, true]) {

        expectThrow(
            () => new ToncenterRateLimiter({ requestsPerSecond: badRate }),
            "PaymentConfigurationError",
            `invalid request rate must be rejected: ${String(badRate)}`
        );

        expectThrow(
            () => assertToncenterRateConfiguration({ requestsPerSecond: badRate }),
            "PaymentConfigurationError",
            `assert must reject the invalid rate: ${String(badRate)}`
        );

    }

    // Above the documented Free-plan ceiling without verification: rejected.
    const aboveCeiling = expectThrow(
        () => new ToncenterRateLimiter({ requestsPerSecond: TONCENTER_DOCUMENTED_FREE_PLAN_RPS + 1 }),
        "PaymentConfigurationError",
        "a rate above the documented ceiling requires a verified plan"
    );

    check(
        aboveCeiling.details.documentedFreePlanCeiling === 10
            && aboveCeiling.details.subscriptionPlanVerified === false,
        "the rejection must name the ceiling and the unverified tier"
    );

    // At the documented Free-plan ceiling: allowed without extra flags.
    const atCeiling = new ToncenterRateLimiter({

        requestsPerSecond: TONCENTER_DOCUMENTED_FREE_PLAN_RPS

    });

    check(
        atCeiling.policy().requestsPerSecond === 10
            && atCeiling.policy().subscriptionPlanVerified === false,
        "10 requests/second is allowed without verification"
    );

    // Higher rates require an explicit, verified configuration change.
    const verified = new ToncenterRateLimiter({

        requestsPerSecond: 25,
        subscriptionPlanVerified: true

    });

    check(
        verified.policy().requestsPerSecond === 25
            && verified.policy().subscriptionPlanVerified === true,
        "an explicitly verified plan may raise the rate"
    );

    // The service wires the same validation.
    expectThrow(
        () => buildHarness({ requestsPerSecond: 11 }).service,
        "PaymentConfigurationError",
        "the service must reject an unverified rate above the ceiling"
    );

    const configuredHarness = buildHarness({ requestsPerSecond: 6 });

    check(
        configuredHarness.service.rateLimiter.policy().requestsPerSecond === 6,
        "the request rate must be explicitly configurable"
    );

    const defaultHarness = buildHarness();

    check(
        defaultHarness.service.rateLimiter.policy().requestsPerSecond === 8
            && defaultHarness.service.rateLimiter.policy().defaultRate === 8,
        "the service default limiter must use 8 requests/second"
    );

    console.log("[2/8] request rate configuration: PASS");

}

// ---------------------------------------------------------------------------
// Group 3 — concurrent rooms queued without a fixed 1-RPS bottleneck
// ---------------------------------------------------------------------------

{

    // Default rate (8 rps): five concurrent room checks must not be serialized
    // at one request per second.
    const harness = buildHarness({

        fetch: { payload: toncenterResponse([toncenterTransaction()]) }

    });

    const roomIds = ["room-A", "room-B", "room-C", "room-D", "room-E"];

    const results = await runWithVirtualClock(harness.clock, () => Promise.all(
        roomIds.map((roomId) => checkRoom(harness.service, { roomId }))
    ));

    check(
        harness.fetchMock.calls.length === 5,
        "each concurrent room check must issue its own single request"
    );

    check(
        results.every((result) => result.transfers.length === 1),
        "every room must observe its wallet transactions"
    );

    check(
        results.every((result) => result.observations[0].status === "matched"),
        "every room must evaluate its intents"
    );

    check(
        harness.clock.currentTime() < 1000,
        "five concurrent rooms must complete in well under one second"
            + ` (virtual elapsed: ${harness.clock.currentTime()}ms)`
    );

    check(
        harness.clock.currentTime() < 5 * 1000,
        "five rooms must not be bottlenecked at 1 request/second"
    );

    // A lower configured rate is respected, but still not a fixed 1 RPS.
    const slowHarness = buildHarness({

        requestsPerSecond: 2,
        fetch: { payload: toncenterResponse([toncenterTransaction()]) }

    });

    const slowRooms = ["room-1", "room-2", "room-3", "room-4"];

    await runWithVirtualClock(slowHarness.clock, () => Promise.all(
        slowRooms.map((roomId) => checkRoom(slowHarness.service, { roomId }))
    ));

    check(
        slowHarness.fetchMock.calls.length === 4,
        "all queued room checks must still be served"
    );

    check(
        slowHarness.clock.currentTime() === 1500,
        "4 rooms at 2 requests/second complete at 1500ms virtual time"
    );

    check(
        slowHarness.clock.currentTime() < 3 * 1000,
        "4 rooms must not be serialized at 1 request/second"
    );

    // Requests never exceed the configured rate in any one-second window.
    check(
        slowHarness.fetchMock.calls.length === slowRooms.length,
        "no request may be duplicated by the limiter"
    );

    console.log("[3/8] concurrent rooms + rate limiting: PASS");

}

// ---------------------------------------------------------------------------
// Group 4 — one request per check; coalesced simultaneous room checks
// ---------------------------------------------------------------------------

{

    const harness = buildHarness({

        fetch: { payload: toncenterResponse([toncenterTransaction()]) }

    });

    const single = await runWithVirtualClock(harness.clock, () => checkRoom(harness.service));

    check(harness.fetchMock.calls.length === 1, "one explicit check issues one request");
    check(single.providerRequests === 1, "the result must report one provider request");
    check(
        harness.fetchMock.calls[0].init.headers["X-API-Key"] === SYNTHETIC_API_KEY,
        "the coalesced/queued request keeps correct header wiring"
    );

    // Simultaneous checks for the SAME room and wallet share one request.
    const coalesced = await runWithVirtualClock(harness.clock, () => Promise.all([

        checkRoom(harness.service),
        checkRoom(harness.service),
        checkRoom(harness.service)

    ]));

    check(
        harness.fetchMock.calls.length === 2,
        "three simultaneous checks must share ONE provider request"
    );

    check(
        coalesced[0] === coalesced[1] && coalesced[1] === coalesced[2],
        "coalesced callers must receive the same result object"
    );

    check(
        harness.service.inFlightCheckCount === 0,
        "the in-flight entry must be cleared after completion"
    );

    // A later explicit check issues a new request.
    await runWithVirtualClock(harness.clock, () => checkRoom(harness.service));

    check(
        harness.fetchMock.calls.length === 3,
        "a subsequent explicit check must issue a new request"
    );

    // Different rooms are not coalesced.
    const multiRoomHarness = buildHarness({

        fetch: { payload: toncenterResponse([toncenterTransaction()]) }

    });

    await runWithVirtualClock(multiRoomHarness.clock, () => Promise.all([

        checkRoom(multiRoomHarness.service, { roomId: "room-X" }),
        checkRoom(multiRoomHarness.service, { roomId: "room-Y" })

    ]));

    check(
        multiRoomHarness.fetchMock.calls.length === 2,
        "different rooms must not be coalesced"
    );

    // Same room with a different wallet is a different observation.
    const otherWalletHarness = buildHarness({

        fetch: { payload: toncenterResponse([toncenterTransaction()]) }

    });

    await runWithVirtualClock(otherWalletHarness.clock, () => Promise.all([

        checkRoom(otherWalletHarness.service),
        checkRoom(otherWalletHarness.service, { walletAddress: RAW_OTHER_WALLET })

    ]));

    check(
        otherWalletHarness.fetchMock.calls.length === 2,
        "the coalescing key must include the wallet address"
    );

    console.log("[4/8] one request per check + coalescing: PASS");

}

// ---------------------------------------------------------------------------
// Group 5 — no background requests and no automatic retries
// ---------------------------------------------------------------------------

{

    const harness = buildHarness({

        fetch: { payload: toncenterResponse([toncenterTransaction()]) }

    });

    await runWithVirtualClock(harness.clock, () => checkRoom(harness.service));

    const callsAfterCheck = harness.fetchMock.calls.length;

    // Drive virtual time far into the future: nothing may fire.
    for (let step = 0; step < 25; step += 1) {

        await harness.clock.advanceToNext();

        await new Promise((resolve) => setImmediate(resolve));

    }

    check(
        harness.fetchMock.calls.length === callsAfterCheck,
        "no background, polling or recurring requests may exist"
    );

    check(
        harness.service.hasBackgroundWork() === false,
        "the service must report that it holds no background work"
    );

    // HTTP 429 stops the call and is never retried.
    const rateLimitedHarness = buildHarness({ fetch: { status: 429 } });

    const rateLimitError = await runWithVirtualClock(rateLimitedHarness.clock, () => (

        expectThrowAsync(
            () => checkRoom(rateLimitedHarness.service),
            "ToncenterRateLimitError",
            "HTTP 429 must surface a rate-limit error"
        )

    ));

    check(
        rateLimitError.code === "TONCENTER_RATE_LIMITED"
            && rateLimitError.details.statusCode === 429,
        "the rate-limit error must carry HTTP 429"
    );

    check(
        rateLimitedHarness.fetchMock.calls.length === 1,
        "exactly one request may be issued for a rate-limited call"
    );

    for (let step = 0; step < 10; step += 1) {

        await rateLimitedHarness.clock.advanceToNext();

        await new Promise((resolve) => setImmediate(resolve));

    }

    check(
        rateLimitedHarness.fetchMock.calls.length === 1,
        "a rate-limited call must never be retried automatically"
    );

    // A slow-then-failing provider is not retried either.
    const flakyHarness = buildHarness({

        fetch: { status: 500, payload: undefined }

    });

    await runWithVirtualClock(flakyHarness.clock, () => (

        expectThrowAsync(
            () => checkRoom(flakyHarness.service),
            "ToncenterServiceError",
            "HTTP 500 must surface a service error"
        )

    ));

    for (let step = 0; step < 10; step += 1) {

        await flakyHarness.clock.advanceToNext();

        await new Promise((resolve) => setImmediate(resolve));

    }

    check(
        flakyHarness.fetchMock.calls.length === 1,
        "a failed call must never be retried automatically"
    );

    console.log("[5/8] no background requests, no retries: PASS");

}

// ---------------------------------------------------------------------------
// Group 6 — HTTP 401, 403, 429, 5xx, timeout and malformed responses
// ---------------------------------------------------------------------------

{

    for (const [status, expectedName, label] of [

        [401, "ToncenterAuthenticationError", "401 unauthorized"],
        [403, "ToncenterAuthenticationError", "403 forbidden"],
        [429, "ToncenterRateLimitError", "429 rate limited"],
        [500, "ToncenterServiceError", "500 internal error"],
        [503, "ToncenterServiceError", "503 unavailable"],
        [400, "ToncenterRequestError", "400 bad request"]

    ]) {

        const fetchMock = mockFetch({ status });

        const client = new ToncenterTransactionsClient({
            apiKeyProvider: () => SYNTHETIC_API_KEY,
            fetchImpl: fetchMock.fetchImpl
        });

        const error = await expectThrowAsync(
            () => client.getTransactions({
                account: FRIENDLY_WALLET,
                startUtime: 1,
                endUtime: 2,
                limit: 10
            }),
            expectedName,
            `${label} must be mapped to ${expectedName}`
        );

        check(
            error.details.statusCode === status,
            `${label} must carry the HTTP status in details`
        );

        check(
            !JSON.stringify(error.toJSON()).includes(SYNTHETIC_API_KEY),
            `${label} error details must never contain the API key`
        );

    }

    // Timeout.
    const timeoutClient = new ToncenterTransactionsClient({

        apiKeyProvider: () => SYNTHETIC_API_KEY,
        fetchImpl: mockFetch({ abortOnSignal: true }).fetchImpl,
        timeoutMs: 25

    });

    const timeoutError = await expectThrowAsync(
        () => timeoutClient.getTransactions({
            account: FRIENDLY_WALLET,
            startUtime: 1,
            endUtime: 2,
            limit: 10
        }),
        "ToncenterRequestError",
        "a timeout must be reported as a request error"
    );

    check(
        timeoutError.details.failure === "timeout"
            && timeoutError.details.timeoutMs === 25,
        "the timeout must be classified explicitly"
    );

    // Network failure.
    const networkClient = new ToncenterTransactionsClient({

        apiKeyProvider: () => SYNTHETIC_API_KEY,
        fetchImpl: mockFetch({ networkError: new TypeError("fetch failed") }).fetchImpl

    });

    const networkError = await expectThrowAsync(
        () => networkClient.getTransactions({
            account: FRIENDLY_WALLET,
            startUtime: 1,
            endUtime: 2,
            limit: 10
        }),
        "ToncenterRequestError",
        "a network failure must be reported as a request error"
    );

    check(
        networkError.details.failure === "network",
        "the network failure must be classified explicitly"
    );

    // Malformed JSON body.
    const malformedJsonClient = new ToncenterTransactionsClient({

        apiKeyProvider: () => SYNTHETIC_API_KEY,
        fetchImpl: mockFetch({ jsonError: new SyntaxError("Unexpected token") }).fetchImpl

    });

    await expectThrowAsync(
        () => malformedJsonClient.getTransactions({
            account: FRIENDLY_WALLET,
            startUtime: 1,
            endUtime: 2,
            limit: 10
        }),
        "ToncenterResponseError",
        "invalid JSON must be a malformed response error"
    );

    // Malformed envelopes.
    for (const [label, payload] of [

        ["missing transactions array", { unexpected: true }],
        ["wrong transactions type", { transactions: "nope" }],
        ["array payload", [toncenterTransaction()]],
        ["null payload", null]

    ]) {

        const malformedClient = new ToncenterTransactionsClient({

            apiKeyProvider: () => SYNTHETIC_API_KEY,
            fetchImpl: mockFetch({ payload }).fetchImpl

        });

        await expectThrowAsync(
            () => malformedClient.getTransactions({
                account: FRIENDLY_WALLET,
                startUtime: 1,
                endUtime: 2,
                limit: 10
            }),
            "ToncenterResponseError",
            `malformed provider response must be rejected: ${label}`
        );

    }

    // Malformed transaction rows are rejected (fail closed), not silently mapped.
    for (const [label, transaction] of [

        ["missing hash", { ...toncenterTransaction(), hash: undefined }],
        ["missing generation time", { ...toncenterTransaction(), now: undefined }]

    ]) {

        expectThrow(
            () => mapToncenterTransactionsResponse(
                toncenterResponse([transaction]),
                {
                    walletAddress: FRIENDLY_WALLET,
                    floorMs: FIXTURE_FLOOR_MS,
                    ceilingMs: FIXTURE_CEILING_MS,
                    limit: 10
                }
            ),
            "ToncenterResponseError",
            `malformed transaction row must be rejected: ${label}`
        );

    }

    // Provider errors propagate through the service unchanged.
    const failingHarness = buildHarness({ fetch: { status: 401 } });

    await runWithVirtualClock(failingHarness.clock, () => (

        expectThrowAsync(
            () => checkRoom(failingHarness.service),
            "ToncenterAuthenticationError",
            "provider auth errors must propagate to the caller"
        )

    ));

    check(
        failingHarness.service.inFlightCheckCount === 0,
        "a failed check must clear its in-flight entry"
    );

    console.log("[6/8] provider error handling: PASS");

}

// ---------------------------------------------------------------------------
// Group 7 — normalization using the documented response format
// ---------------------------------------------------------------------------

{

    // 7a. A complete, matching incoming transfer.
    const harness = buildHarness({

        fetch: { payload: toncenterResponse([toncenterTransaction()]) }

    });

    const result = await runWithVirtualClock(harness.clock, () => checkRoom(harness.service));

    check(result.transfers.length === 1, "one documented transaction must normalize to one transfer");

    const transfer = result.transfers[0];

    check(transfer instanceof IncomingTransfer, "the mapper output must normalize into IncomingTransfer");
    check(transfer.network === "testnet", "network must be testnet");
    check(transfer.direction === "incoming", "direction must be incoming");
    check(transfer.asset === "TON", "the native asset must be TON");
    check(
        transfer.amountAtomic === 2_000_000_000 && Number.isSafeInteger(transfer.amountAtomic),
        "nanoton digit strings must become exact integers without float conversion"
    );
    check(
        transfer.transactionTime === FIXTURE_NOW_MS,
        "v3 epoch-seconds `now` must convert to epoch milliseconds"
    );
    check(
        transfer.senderAddress === FRIENDLY_SENDER
            && transfer.destinationWalletAddress === FRIENDLY_WALLET,
        "addresses must be resolved through the response address book"
    );
    check(
        transfer.paymentReference === FIXTURE_PAYMENT_REFERENCE
            && transfer.paymentComment === FIXTURE_PAYMENT_REFERENCE,
        "the WW1: text_comment must become the payment reference (envelope stripped)"
    );
    check(
        !JSON.stringify(transfer.toRecord()).includes(PAYMENT_REFERENCE_COMMENT_PREFIX),
        "the raw WW1: comment envelope must never be retained in the observation"
    );
    check(
        transfer.providerConfirmed === true,
        "committed transactions must be marked provider-confirmed"
    );
    check(
        transfer.providerTransactionIdentity.providerId === "toncenter"
            && transfer.providerTransactionIdentity.accountId === FRIENDLY_WALLET
            && transfer.providerTransactionIdentity.transactionId === FIXTURE_TX_HASH,
        "the raw provider transaction identity must be preserved for idempotency"
    );
    check(
        transfer.transactionId === deriveIncomingTransactionId({
            network: "testnet",
            providerId: "toncenter",
            accountId: FRIENDLY_WALLET,
            transactionId: FIXTURE_TX_HASH
        }),
        "the derived transaction id must be deterministic and network-scoped"
    );
    check(
        result.observations[0].status === "matched"
            && result.observations[0].paymentReference === FIXTURE_PAYMENT_REFERENCE,
        "the matching intent must be evaluated"
    );
    check(
        result.observations[0].paymentConfirmed === false,
        "a matched observation must never report a confirmed payment"
    );
    check(
        result.providerRequests === 1
            && result.window.rowsReturned === 1
            && result.resultWindowComplete === true,
        "a complete observation window must be reported as complete"
    );

    // 7b. Records that are not completed incoming value transfers are skipped.
    const inMsg = toncenterTransaction().in_msg;

    const skipCases = [

        ["transaction without in_msg", { in_msg: null }],
        ["zero-value message", { in_msg: { ...inMsg, value: "0" } }],
        ["aborted transaction", { description: { ...toncenterTransaction().description, aborted: true } }],
        ["failed compute phase", { description: { ...toncenterTransaction().description, compute_ph: { success: false } } }],
        ["failed action phase", { description: { ...toncenterTransaction().description, action: { success: false } } }],
        ["emulated transaction", { emulated: true }],
        ["message to another wallet", { in_msg: { ...inMsg, destination: RAW_OTHER_WALLET } }],
        ["transaction before the window", { now: FIXTURE_NOW_SECONDS - 10_000 }],
        ["transaction after the window", { now: FIXTURE_NOW_SECONDS + 10_000 }]

    ];

    for (const [label, override] of skipCases) {

        const skipHarness = buildHarness({

            fetch: { payload: toncenterResponse([toncenterTransaction(override)]) }

        });

        const skipResult = await runWithVirtualClock(skipHarness.clock, () => checkRoom(skipHarness.service));

        check(
            skipResult.transfers.length === 0,
            `${label} must not be observed as an incoming transfer`
        );

        check(
            skipResult.window.rowsReturned === 1,
            `${label} must still count as a returned provider row`
        );

    }

    // 7c. A binary comment is not a text payment reference (never guessed).
    const binaryHarness = buildHarness({

        fetch: {

            payload: toncenterResponse([toncenterTransaction({

                in_msg: {

                    ...inMsg,

                    message_content: {

                        hash: "c".repeat(64),

                        body: "te6cckEBAQEAAgAAAEysuc0=",

                        decoded: { type: "binary_comment", hex_comment: "deadbeef" }

                    }

                }

            })])
        }

    });

    const binaryResult = await runWithVirtualClock(binaryHarness.clock, () => checkRoom(binaryHarness.service));

    check(
        binaryResult.transfers.length === 1
            && binaryResult.transfers[0].paymentReference === null,
        "a binary comment must not produce a payment reference"
    );

    check(
        binaryResult.observations[0].status === "matched",
        "a unique native Testnet payer can match without a decodable memo"
    );

    // 7d. An undecoded body likewise yields no reference.
    const undecodedHarness = buildHarness({

        fetch: {

            payload: toncenterResponse([toncenterTransaction({

                in_msg: {

                    ...inMsg,

                    message_content: { hash: "d".repeat(64), body: "te6cckEBAQEAAgAAAEysuc0=" }

                }

            })])
        }

    });

    const undecodedResult = await runWithVirtualClock(undecodedHarness.clock, () => checkRoom(undecodedHarness.service));

    check(
        undecodedResult.transfers[0].paymentReference === null
            && undecodedResult.observations[0].status === "matched",
        "an undecoded body remains reference-free but a unique payer can still match"
    );

    // 7e. Bounded windows: a full page reports a potentially incomplete window.
    const incompleteHarness = buildHarness({

        limit: 2,

        fetch: {

            payload: toncenterResponse([

                toncenterTransaction({ hash: FIXTURE_TX_HASH }),

                // Different payment reference: observed, but not a match.
                toncenterTransaction({

                    hash: OTHER_TX_HASH,

                    in_msg: {

                        ...toncenterTransaction().in_msg,

                        message_content: {

                            hash: "e".repeat(64),

                            body: "te6cckEBAQEAAgAAAEysuc0=",

                            decoded: {
                                type: TONCENTER_TEXT_COMMENT_DECODED_TYPE,
                                comment: `${PAYMENT_REFERENCE_COMMENT_PREFIX}WW-PAY-ROOM1-0002`
                            }

                        }

                    }

                })

            ])

        }

    });

    const incompleteResult = await runWithVirtualClock(incompleteHarness.clock, () => checkRoom(incompleteHarness.service));

    check(
        incompleteResult.window.rowsReturned === incompleteResult.window.limit
            && incompleteResult.resultWindowComplete === false,
        "a full result page must report a potentially incomplete window"
    );

    check(
        incompleteResult.transfers.length === 2
            && incompleteResult.observations.some((observation) => observation.status === "no-match-observed"),
        "an incomplete window must report observations, never claim non-existence"
    );

    // 7f. Two DIFFERENT transactions matching the SAME intent are ambiguous:
    // an intent must never be attributed to more than one transaction.
    const duplicatePaymentHarness = buildHarness({

        fetch: {

            payload: toncenterResponse([

                toncenterTransaction({ hash: FIXTURE_TX_HASH }),

                toncenterTransaction({ hash: OTHER_TX_HASH })

            ])

        }

    });

    const duplicateIntent = buildIntent();

    const duplicateResult = await runWithVirtualClock(duplicatePaymentHarness.clock, () => checkRoom(duplicatePaymentHarness.service, {

        paymentIntents: [duplicateIntent]

    }));

    check(
        duplicateResult.observations.every((observation) => observation.status === "ambiguous"),
        "two transactions matching one intent must both be reported ambiguous"
    );

    check(
        duplicateResult.observations.every((observation) => observation.candidateTransactionIds.length === 2),
        "the ambiguity must list both candidate transaction identities"
    );

    check(
        duplicateResult.observations.every((observation) => observation.paymentConfirmed === false),
        "an ambiguous observation must never report a confirmed payment"
    );

    check(
        duplicateIntent.state === "PENDING" && duplicateIntent.transactionId === null,
        "an ambiguous observation must not mutate the intent"
    );

    // A partially filled page is a complete window.
    const partialHarness = buildHarness({

        limit: 2,

        fetch: { payload: toncenterResponse([toncenterTransaction()]) }

    });

    const partialResult = await runWithVirtualClock(partialHarness.clock, () => checkRoom(partialHarness.service));

    check(
        partialResult.resultWindowComplete === true,
        "a partially filled page is a complete window"
    );

    // 7g. Provider records satisfy the Phase 2 read-only provider contract.
    const provider = harness.provider;

    assertReadOnlyProviderClient(provider);

    checksPassed += 1;

    check(
        provider instanceof IncomingTransferProviderClient,
        "the Toncenter provider must implement the Phase 2 provider interface"
    );

    // 7g. Raw address book entries are absent: addresses are kept as returned.
    const noBookPayload = {

        transactions: [toncenterTransaction()],

        address_book: {}

    };

    const noBookMapped = mapToncenterTransactionsResponse(noBookPayload, {

        walletAddress: RAW_WALLET,

        floorMs: FIXTURE_FLOOR_MS,

        ceilingMs: FIXTURE_CEILING_MS,

        limit: 10

    });

    check(
        noBookMapped.records.length === 1
            && noBookMapped.records[0].destinationAddress === RAW_WALLET,
        "without an address book entry the raw address is kept unchanged"
    );

    console.log("[7/8] documented normalization: PASS");

}

// ---------------------------------------------------------------------------
// Group 8 — observation never marks an intent paid or confirmed
// ---------------------------------------------------------------------------

{

    const harness = buildHarness({

        fetch: { payload: toncenterResponse([toncenterTransaction()]) }

    });

    const intent = buildIntent();

    const before = intent.toRecord();

    const result = await runWithVirtualClock(harness.clock, () => checkRoom(harness.service, {

        paymentIntents: [intent]

    }));

    check(result.observations[0].status === "matched", "the observation must be evaluated as a match");

    // The intent is untouched: not matched, not credited, not confirmed.
    check(
        intent.state === "PENDING" && intent.transactionId === null,
        "observation must never match or credit a payment intent"
    );

    check(
        intent.updatedAt === null && before.updatedAt === null,
        "observation must never touch intent timestamps"
    );

    check(
        Object.isFrozen(intent)
            && JSON.stringify(intent.toRecord()) === JSON.stringify(before),
        "the payment intent must remain byte-identical after observation"
    );

    // Result-level confirmation guards.
    check(
        result.disposition === PAYMENT_CONFIRMATION_DISPOSITION.OBSERVATION_ONLY
            && result.paymentConfirmation === false
            && result.canConfirmPayments === false,
        "the result must be observation-only"
    );

    check(
        isPaymentConfirmationDisposition(result.disposition) === false,
        "no observation result can ever be a payment confirmation"
    );

    check(
        result.observations.every((observation) => observation.paymentConfirmed === false),
        "no observation entry may report a confirmed payment"
    );

    check(harness.service.canConfirmPayments() === false, "the service must report that it cannot confirm payments");
    check(harness.service.confirmationDisposition === PAYMENT_CONFIRMATION_DISPOSITION.OBSERVATION_ONLY, "the service disposition must be observation-only");

    // Structural proof: neither the service nor the provider exposes any
    // write, broadcast or confirmation operation.
    const serviceForbidden = Object.getOwnPropertyNames(
        Object.getPrototypeOf(harness.service)
    ).filter((name) => INCOMING_TRANSFER_ADAPTER_FORBIDDEN_OPERATIONS.includes(name));

    check(
        serviceForbidden.length === 0,
        "the observation service must expose no write/confirmation operation"
    );

    assertNoOperations(
        harness.service,
        INCOMING_TRANSFER_ADAPTER_FORBIDDEN_OPERATIONS
    );

    checksPassed += 1;

    for (const operation of INCOMING_TRANSFER_ADAPTER_FORBIDDEN_OPERATIONS) {

        check(
            typeof harness.provider[operation] !== "function",
            `the provider must not expose ${operation}`
        );

    }

    // A transaction matching multiple intents is ambiguous, never attributed.
    const ambiguousIntentA = buildIntent({

        roomId: "room-synthetic-001",

        playerId: "player-synthetic-A"

    });

    const ambiguousIntentB = buildIntent({

        roomId: "room-synthetic-001",

        playerId: "player-synthetic-B"

    });

    const ambiguousResult = await runWithVirtualClock(harness.clock, () => checkRoom(harness.service, {

        paymentIntents: [ambiguousIntentA, ambiguousIntentB]

    }));

    check(
        ambiguousResult.observations[0].status === "ambiguous"
            && ambiguousResult.observations[0].candidatePaymentReferences.length === 2
            && ambiguousResult.observations[0].paymentReference === null,
        "an ambiguous observation must be rejected, never resolved by guessing"
    );

    check(
        ambiguousIntentA.state === "PENDING"
            && ambiguousIntentB.state === "PENDING",
        "an ambiguous observation must not mutate either intent"
    );

    // Wrong sender, amount, network, asset and destination never match.
    const negativeCases = [

        ["wrong sender", buildIntent({ expectedSender: "EQAPHi08S1ppeA8eLTxLWml4Dx4tPEtaaXgPHi08S1ppeGnn" })],
        ["wrong amount", buildIntent({ amountAtomic: 1_999_999_999 })],
        ["wrong network", buildIntent({ network: "mainnet" })],
        ["wrong asset", buildIntent({ asset: "USDT" })],
        ["wrong destination", buildIntent({ destinationWalletAddress: "EQAKGyw9Tl9gcQobLD1OX2BxChssPU5fYHEKGyw9Tl9gcbvR" })],
        ["wrong reference", buildIntent({ paymentReference: "WW-PAY-ROOM1-9999" })]

    ];

    for (const [label, negativeIntent] of negativeCases) {

        const negativeResult = await runWithVirtualClock(harness.clock, () => checkRoom(harness.service, {

            paymentIntents: [negativeIntent]

        }));

        check(
            negativeResult.observations[0].status === "no-match-observed",
            `${label} must never match`
        );

        check(
            negativeIntent.state === "PENDING" && negativeIntent.transactionId === null,
            `${label} must leave the intent untouched`
        );

    }

    // The provider is async; the Phase 2 synchronous adapter path is unchanged
    // and this phase adds no caller of its own.
    console.log("[8/9] observation never confirms: PASS");

}

// ---------------------------------------------------------------------------
// Group 9 — canonical address identity through the mapper (raw ↔ friendly)
// ---------------------------------------------------------------------------

{

    // 9a. The documented live-response form: raw `in_msg.source/destination`
    // while the room checks its wallet by its friendly catalog address. The
    // account identity — not the string form — is what matches.
    const rawRow = toncenterTransaction();

    check(
        toncenterResponse([rawRow]).transactions[0].in_msg.destination
            === RAW_WALLET,
        "the fixture row carries the raw destination form used by the live API"
    );

    const harness = buildHarness({

        fetch: { payload: toncenterResponse([rawRow]) }

    });

    const result = await runWithVirtualClock(harness.clock, () => checkRoom(harness.service));

    check(
        result.transfers.length === 1
            && result.observations[0].status === "matched",
        "a raw destination must match the friendly queried wallet address"
    );

    check(
        result.transfers[0].destinationWalletAddress === FRIENDLY_WALLET
            && result.transfers[0].senderAddress === FRIENDLY_SENDER,
        "a corroborated address-book entry may supply the friendly form"
    );

    // 9b. Querying by the raw form, and by the non-bounceable friendly form,
    // observes the same transaction: one account, several representations.
    for (const [label, wallet] of [

        ["raw wallet address", RAW_WALLET],
        ["non-bounceable friendly address", FRIENDLY_WALLET_UQ]

    ]) {

        const variantHarness = buildHarness({

            fetch: { payload: toncenterResponse([rawRow]) }

        });

        const variantResult = await runWithVirtualClock(variantHarness.clock, () => checkRoom(variantHarness.service, {
            walletAddress: wallet
        }));

        check(
            variantResult.transfers.length === 1
                && variantResult.observations[0].status === "matched",
            `the room wallet queried as a ${label} must observe its payment`
        );

    }

    // 9c. A row addressed to another (valid) wallet is never observed, even
    // when the address book would resolve that wallet to a friendly form.
    const otherWalletHarness = buildHarness({

        fetch: {
            payload: toncenterResponse([toncenterTransaction({
                in_msg: { ...toncenterTransaction().in_msg, destination: RAW_OTHER_WALLET }
            })])
        }

    });

    const otherWalletResult = await runWithVirtualClock(otherWalletHarness.clock, () => checkRoom(otherWalletHarness.service));

    check(
        otherWalletResult.transfers.length === 0
            && otherWalletResult.window.rowsReturned === 1,
        "a transaction addressed to a different account must never be observed"
    );

    // 9d. The address book is supplementary metadata, never identity: an
    // entry whose friendly form describes a DIFFERENT account is ignored and
    // the raw address is preserved.
    const forgedBookHarness = buildHarness({

        fetch: {
            payload: toncenterResponse([rawRow], {
                [RAW_WALLET]: { domain: null, user_friendly: FRIENDLY_OTHER_WALLET }
            })
        }

    });

    const forgedBookResult = await runWithVirtualClock(forgedBookHarness.clock, () => checkRoom(forgedBookHarness.service));

    check(
        forgedBookResult.transfers.length === 1
            && forgedBookResult.transfers[0].destinationWalletAddress === RAW_WALLET,
        "a forged address-book entry must never replace a raw address"
    );

    check(
        forgedBookResult.observations[0].status === "matched",
        "identity comes from the raw address, not from the address book"
    );

    // 9e. An address-book entry that is not a valid TON address is ignored;
    // the raw address is kept and the identity still matches.
    const invalidBookHarness = buildHarness({

        fetch: {
            payload: toncenterResponse([rawRow], {
                [RAW_SENDER]: { domain: null, user_friendly: "EQNOTAVALIDADDRESS" }
            })
        }

    });

    const invalidBookResult = await runWithVirtualClock(invalidBookHarness.clock, () => checkRoom(invalidBookHarness.service));

    check(
        invalidBookResult.transfers[0].senderAddress === RAW_SENDER
            && invalidBookResult.observations[0].status === "matched",
        "an invalid address-book friendly entry must never corrupt identity"
    );

    // 9f. A standard-base64 address book is handled the same way.
    const standardBookHarness = buildHarness({

        fetch: {
            payload: toncenterResponse([rawRow], {
                [RAW_SENDER]: { domain: null, user_friendly: FRIENDLY_SENDER_STANDARD },
                [RAW_WALLET]: { domain: null, user_friendly: FRIENDLY_WALLET }
            })
        }

    });

    const standardBookResult = await runWithVirtualClock(standardBookHarness.clock, () => checkRoom(standardBookHarness.service));

    check(
        standardBookResult.transfers[0].senderAddress === FRIENDLY_SENDER_STANDARD
            && standardBookResult.observations[0].status === "matched",
        "standard base64 address-book entries must be handled correctly"
    );

    // 9g. A malformed queried wallet address fails closed: no mapping is
    // attempted, so nothing can be attributed by string luck.
    const malformedWalletHarness = buildHarness({

        fetch: { payload: toncenterResponse([rawRow]) }

    });

    const malformedWalletError = await runWithVirtualClock(malformedWalletHarness.clock, () => (

        expectThrowAsync(
            () => checkRoom(malformedWalletHarness.service, {
                walletAddress: "EQNOTAVALIDADDRESS"
            }),
            "ToncenterResponseError",
            "a malformed queried wallet address must be refused"
        )

    ));

    check(
        malformedWalletError.code === "TONCENTER_RESPONSE_MALFORMED"
            && malformedWalletHarness.service.inFlightCheckCount === 0,
        "the refusal must fail closed and clear the in-flight entry"
    );

    // 9h. Transaction identity is unchanged by the address form the caller
    // used when querying.
    const identityByFriendly = result.transfers[0].transactionId;

    const rawQueryHarness = buildHarness({

        fetch: { payload: toncenterResponse([rawRow]) }

    });

    const rawQueryResult = await runWithVirtualClock(rawQueryHarness.clock, () => checkRoom(rawQueryHarness.service, {
        walletAddress: RAW_WALLET
    }));

    check(
        rawQueryResult.transfers.length === 1
            && rawQueryResult.observations[0].status === "matched",
        "querying by the raw wallet form must observe the same payment"
    );

    // The provider account id travels with the queried form, so the derived
    // identity is scoped per queried account — this is the documented
    // behaviour and must never silently merge two accounts.
    check(
        typeof identityByFriendly === "string"
            && identityByFriendly.startsWith("ttx_")
            && identityByFriendly.length === 68
            && rawQueryResult.transfers[0].transactionId.startsWith("ttx_"),
        "derived transaction identities must remain well-formed"
    );

    console.log("[9/10] canonical address identity mapping: PASS");

}

// ---------------------------------------------------------------------------
// Group 10 — native TON payment reference extraction (Phase 3C)
// ---------------------------------------------------------------------------

// 10a. The codec wire format is exact and round-trips.
{

    for (const reference of [
        "A",
        "WW-PAY-ROOM1-0001",
        "room_1_player_2",
        "MixedCase-Ref_42",
        "0".repeat(PAYMENT_REFERENCE_MAX_LENGTH)
    ]) {

        const comment = formatPaymentReference(reference);

        check(
            comment === `${PAYMENT_REFERENCE_COMMENT_PREFIX}${reference}`,
            "the wire format must be exactly WW1:<paymentReference>"
        );

        check(
            extractPaymentReference(comment) === reference,
            "a formatted reference must extract back unchanged"
        );

        check(
            isPaymentReferenceComment(comment) === true
                && isPaymentReference(reference) === true,
            "a well-formed comment and reference must be recognized"
        );

    }

    // Deterministic: the same reference always produces the same comment, so
    // a duplicated reference is a duplicate comment (never a second payment).
    check(
        formatPaymentReference(FIXTURE_PAYMENT_REFERENCE)
            === formatPaymentReference(FIXTURE_PAYMENT_REFERENCE),
        "formatting must be deterministic"
    );

    check(
        formatPaymentReference("WW-PAY-ROOM1-0001")
            !== formatPaymentReference("WW-PAY-ROOM1-0002"),
        "distinct references must produce distinct comments"
    );

    check(
        PAYMENT_REFERENCE_COMMENT_PREFIX === "WW1:"
            && FIXTURE_PAYMENT_COMMENT === "WW1:WW-PAY-ROOM1-0001",
        "the documented native comment prefix must be WW1:"
    );

    // A valid 64-character reference is accepted; 65 characters is overlong.
    check(
        extractPaymentReference(`WW1:${"R".repeat(PAYMENT_REFERENCE_MAX_LENGTH)}`)
            === "R".repeat(PAYMENT_REFERENCE_MAX_LENGTH),
        "a reference of the maximum length must be accepted"
    );

    // The codec exposes no write, transfer or confirmation operation.
    check(
        Object.keys(paymentReferenceCodec).every(
            (name) => !/send|broadcast|sign|deploy|transfer|burn|confirm|settle|credit|refund/i.test(name)
        ),
        "the payment reference codec must expose no write or confirmation operation"
    );

    console.log("[10a] payment reference codec round-trip: PASS");

}

// 10b. Extraction from the documented decoded structure.
{

    const inMsg = toncenterTransaction().in_msg;

    /** One transaction whose in_msg carries the given `message_content`. */
    function transactionWithMessageContent(messageContent) {

        const { message_content: _omitted, ...inMsgWithoutContent } = inMsg;

        return toncenterTransaction({
            in_msg: messageContent === undefined
                ? inMsgWithoutContent
                : { ...inMsgWithoutContent, message_content: messageContent }
        });

    }

    /** One transaction whose decoded body is exactly the given object. */
    function transactionWithDecoded(decoded) {

        return transactionWithMessageContent({
            hash: "c".repeat(64),
            body: "te6cckEBAQEAAgAAAEysuc0=",
            decoded
        });

    }

    /** One transaction whose text comment is exactly the given string. */
    function transactionWithComment(comment) {

        return transactionWithDecoded({
            type: TONCENTER_TEXT_COMMENT_DECODED_TYPE,
            comment
        });

    }

    function mapTransactions(transactions) {

        return mapToncenterTransactionsResponse(toncenterResponse(transactions), {
            walletAddress: FRIENDLY_WALLET,
            floorMs: FIXTURE_FLOOR_MS,
            ceilingMs: FIXTURE_CEILING_MS,
            limit: 10
        });

    }

    // Documented structure: `in_msg.message_content.decoded` = {
    //   type: "text_comment", comment: "WW1:<paymentReference>" }
    const recognized = mapTransactions([transactionWithComment(FIXTURE_PAYMENT_COMMENT)]);

    check(recognized.records.length === 1, "a recognized transaction must still be mapped");
    check(
        recognized.records[0].comment === FIXTURE_PAYMENT_REFERENCE,
        "only the bare Phase 1 payment reference may be extracted"
    );

    // The wire envelope is stripped, not retained: the raw comment never
    // becomes part of the observation.
    check(
        !JSON.stringify(recognized.records[0]).includes(PAYMENT_REFERENCE_COMMENT_PREFIX),
        "the raw comment envelope must not be carried forward"
    );

    // Unsupported or absent decoded structures: the transaction is still an
    // observation, but it carries NO payment identity.
    const unsupportedDecoded = [

        ["message_content absent", transactionWithMessageContent(undefined)],
        ["message_content without decoded", transactionWithMessageContent({ hash: "e".repeat(64) })],
        ["decoded null", transactionWithDecoded(null)],
        ["decoded array", transactionWithDecoded([{ type: TONCENTER_TEXT_COMMENT_DECODED_TYPE, comment: FIXTURE_PAYMENT_COMMENT }])],
        ["decoded without a comment property", transactionWithDecoded({})],
        ["text_comment without a comment field", transactionWithDecoded({ type: TONCENTER_TEXT_COMMENT_DECODED_TYPE })],
        ["empty text comment", transactionWithComment("")],
        ["blank text comment", transactionWithComment("   ")],
        ["non-text comment value", transactionWithDecoded({ type: TONCENTER_TEXT_COMMENT_DECODED_TYPE, comment: 42 })],
        ["binary comment", transactionWithDecoded({ type: "binary_comment", hex_comment: "a1b2c3d4" })],
        [
            "binary comment embedding the envelope text",
            transactionWithDecoded({ type: "binary_comment", hex_comment: "WW1:WW-PAY-ROOM1-0001" })
        ],
        [
            "binary comment carrying a decoy comment field",
            transactionWithDecoded({ type: "binary_comment", comment: FIXTURE_PAYMENT_COMMENT })
        ],
        [
            "unsupported decoded payload (opcode / contract)",
            transactionWithDecoded({ type: "unknown_op", op: "0x1f2e3d4c", body: "te6cckEBAQEAAgAAAEysuc0=" })
        ],
        [
            "unsupported decoded payload (encrypted)",
            transactionWithDecoded({ type: "encrypted_comment", ciphertext: "te6cckEBAQEAAgAAAEysuc0=" })
        ],
        [
            "raw body without any decoded object",
            transactionWithMessageContent({ hash: "f".repeat(64), body: "te6cckEBAQEAAgAAAEysuc0=" })
        ]

    ];

    for (const [label, transaction] of unsupportedDecoded) {

        const mapped = mapTransactions([transaction]);

        check(
            mapped.records.length === 1
                && mapped.records[0].comment === null,
            `${label} must remain an observation with no payment reference`
        );

    }

    // A comment that is not the exact envelope is never a payment reference.
    const rejectedComments = [

        ["comment without the prefix", "WW-PAY-ROOM1-0001"],
        ["lowercase prefix", "ww1:WW-PAY-ROOM1-0001"],
        ["mixed-case prefix", "Ww1:WW-PAY-ROOM1-0001"],
        ["leading whitespace", " WW1:WW-PAY-ROOM1-0001"],
        ["whitespace after the prefix", "WW1: WW-PAY-ROOM1-0001"],
        ["trailing whitespace", "WW1:WW-PAY-ROOM1-0001 "],
        ["trailing newline", "WW1:WW-PAY-ROOM1-0001\n"],
        ["empty reference", "WW1:"],
        ["nested envelope (ambiguous)", "WW1:WW1:WW-PAY-ROOM1-0001"],
        ["reference with whitespace", "WW1:WW PAY ROOM1 0001"],
        ["reference with a separator", "WW1:WW:PAY:ROOM1"],
        ["non-ASCII reference", "WW1:WW-PAY-ROOM1-É0001"],
        ["zero-width character", "WW1:WW-PAY-ROOM1-0001\u200b"],
        ["unsupported version prefix", "WW2:WW-PAY-ROOM1-0001"],
        ["unanchored prefix", "XWW1:WW-PAY-ROOM1-0001"],
        ["overlong reference", `WW1:${"R".repeat(PAYMENT_REFERENCE_MAX_LENGTH + 1)}`],
        ["non-text comment", 42]

    ];

    for (const [label, comment] of rejectedComments) {

        const mapped = mapTransactions([transactionWithComment(comment)]);

        check(
            mapped.records.length === 1 && mapped.records[0].comment === null,
            `${label} must never produce a payment reference`
        );

        check(
            inspectPaymentReferenceComment(comment).valid === false,
            `${label} must be classified as invalid`
        );

    }

    // Overlong and malformed are classified explicitly, never silently merged.
    check(
        inspectPaymentReferenceComment(`WW1:${"R".repeat(PAYMENT_REFERENCE_MAX_LENGTH + 1)}`).reason
            === PAYMENT_REFERENCE_REJECTION_REASON.REFERENCE_OVERLONG,
        "an overlong reference must be reported as overlong"
    );

    check(
        inspectPaymentReferenceComment("WW1:not a reference").reason
            === PAYMENT_REFERENCE_REJECTION_REASON.REFERENCE_MALFORMED,
        "a malformed reference must be reported as malformed"
    );

    check(
        inspectPaymentReferenceComment("WW1:WW1:ref").reason
            === PAYMENT_REFERENCE_REJECTION_REASON.REFERENCE_AMBIGUOUS,
        "a nested envelope must be reported as ambiguous"
    );

    check(
        inspectPaymentReferenceComment("WW-PAY-ROOM1-0001").reason
            === PAYMENT_REFERENCE_REJECTION_REASON.COMMENT_PREFIX_MISMATCH,
        "a comment without the envelope must be reported as a prefix mismatch"
    );

    check(
        inspectPaymentReferenceComment(undefined).reason
            === PAYMENT_REFERENCE_REJECTION_REASON.COMMENT_ABSENT,
        "an absent comment must be reported as absent"
    );

    console.log("[10b] decoded comment extraction: PASS");

}

// 10c. End-to-end through the observation service.
{

    const inMsg = toncenterTransaction().in_msg;

    /** One transaction whose text comment is exactly the given string. */
    function transactionWithComment(comment) {

        const { message_content: _omitted, ...inMsgWithoutContent } = inMsg;

        return toncenterTransaction({
            in_msg: {
                ...inMsgWithoutContent,
                message_content: {
                    hash: "c".repeat(64),
                    body: "te6cckEBAQEAAgAAAEysuc0=",
                    decoded: {
                        type: TONCENTER_TEXT_COMMENT_DECODED_TYPE,
                        comment
                    }
                }
            }
        });

    }

    /** Observe one comment end-to-end against the fixture payment intent. */
    async function observeComment(comment) {

        const harness = buildHarness({
            fetch: { payload: toncenterResponse([transactionWithComment(comment)]) }
        });

        const result = await runWithVirtualClock(harness.clock, () => checkRoom(harness.service));

        return { harness, result };

    }

    // A well-formed envelope matches the intent exactly.
    const matched = await observeComment(FIXTURE_PAYMENT_COMMENT);

    check(
        matched.result.transfers.length === 1
            && matched.result.transfers[0].paymentReference === FIXTURE_PAYMENT_REFERENCE,
        "the exact wire format must yield the Phase 1 payment reference"
    );

    check(
        matched.result.observations[0].status === "matched"
            && matched.result.observations[0].paymentReference === FIXTURE_PAYMENT_REFERENCE,
        "the extracted reference must match the payment intent exactly"
    );

    check(
        matched.result.observations[0].paymentConfirmed === false
            && matched.result.paymentConfirmation === false,
        "a matched observation is still not a payment confirmation"
    );

    // Unsupported bodies and non-envelope comments stay unmatched observations.
    for (const [label, comment] of [
        ["missing comment", undefined],
        ["comment without the prefix", FIXTURE_PAYMENT_REFERENCE],
        ["binary comment", undefined],
        ["empty reference", "WW1:"],
        ["malformed reference", "WW1:not a reference"]
    ]) {

        const observed = await observeComment(comment);

        check(
            observed.result.transfers.length === 1
                && observed.result.transfers[0].paymentReference === null,
            `${label} must remain an observation without a payment reference`
        );

        check(
            observed.result.observations[0].status === "no-match-observed"
                && observed.result.observations[0].paymentReference === null,
            `${label} must never match a payment intent`
        );

    }

    console.log("[10c] service-level reference extraction: PASS");

}

// 10d. Exact matching, duplicate-reference collision and replay protection.
{

    /** Synthetic read-only provider client over fixed mapped records. */
    function mappedRecordsClient(records) {

        const calls = [];

        return {
            calls,
            listIncomingTransactions() {

                calls.push({});

                return records;

            }
        };

    }

    /** Synthetic read-only provider client whose reply changes per call. */
    function scriptedMappedRecordsClient(recordSets) {

        const calls = [];

        let index = 0;

        return {
            calls,
            listIncomingTransactions() {

                calls.push({});

                const records = recordSets[Math.min(index, recordSets.length - 1)];

                index += 1;

                return records;

            }
        };

    }

    /** Phase 2 adapter over mapper output records (the documented path). */
    function buildMappedAdapter(records) {

        return new IncomingTransferAdapter({
            providerClient: mappedRecordsClient(records),
            network: "testnet",
            providerId: "toncenter",
            nowProvider: () => FIXTURE_NOW_MS + 60_000
        });

    }

    function mapTransactions(transactions) {

        return mapToncenterTransactionsResponse(toncenterResponse(transactions), {
            walletAddress: FRIENDLY_WALLET,
            floorMs: FIXTURE_FLOOR_MS,
            ceilingMs: FIXTURE_CEILING_MS,
            limit: 10
        });

    }

    const inMsg = toncenterTransaction().in_msg;

    /** One transaction hash + text comment pair. */
    function transactionWithComment(hash, comment) {

        const { message_content: _omitted, ...inMsgWithoutContent } = inMsg;

        return toncenterTransaction({
            hash,
            in_msg: {
                ...inMsgWithoutContent,
                message_content: {
                    hash: "c".repeat(64),
                    body: "te6cckEBAQEAAgAAAEysuc0=",
                    decoded: {
                        type: TONCENTER_TEXT_COMMENT_DECODED_TYPE,
                        comment
                    }
                }
            }
        });

    }

    const referenceA = mapTransactions([transactionWithComment(FIXTURE_TX_HASH, FIXTURE_PAYMENT_COMMENT)]).records;

    // Exact reference matching: the derived reference matches only its intent.
    const adapter = buildMappedAdapter(referenceA);

    const transfer = adapter.normalizeProviderRecord(referenceA[0]);

    const intent = buildIntent();

    check(
        matchIncomingTransferToIntent(transfer, intent).matched === true
            && matchIncomingTransferToIntent(transfer, intent).paymentReference
                === FIXTURE_PAYMENT_REFERENCE,
        "the extracted reference must match its intent exactly"
    );

    check(
        matchIncomingTransferToIntent(
            transfer,
            buildIntent({ paymentReference: "WW-PAY-ROOM1-0002" })
        ).matched === false,
        "a different reference must never match"
    );

    check(
        intent.state === "PENDING"
            && intent.transactionId === null
            && intent.updatedAt === null,
        "matching an observation must never mutate the payment intent"
    );

    // Two different transactions carrying the SAME reference collide.
    const duplicateRecords = mapTransactions([

        transactionWithComment(FIXTURE_TX_HASH, FIXTURE_PAYMENT_COMMENT),

        transactionWithComment(OTHER_TX_HASH, FIXTURE_PAYMENT_COMMENT)

    ]).records;

    const duplicateAdapter = buildMappedAdapter(duplicateRecords);

    const collision = expectThrow(
        () => duplicateAdapter.observeIncomingTransactions(),
        "PaymentReferenceCollisionError",
        "two transactions claiming one reference must be rejected"
    );

    check(
        collision.details.paymentReference === FIXTURE_PAYMENT_REFERENCE
            && collision.details.transactionIds.length === 2,
        "the collision must name the duplicated payment reference and both identities"
    );

    check(
        duplicateAdapter.observedTransactionCount === 0,
        "a rejected duplicate must not enter the observation ledger"
    );

    // Distinct references are distinct observations.
    const distinctAdapter = buildMappedAdapter(mapTransactions([

        transactionWithComment(FIXTURE_TX_HASH, FIXTURE_PAYMENT_COMMENT),

        transactionWithComment(
            OTHER_TX_HASH,
            `${PAYMENT_REFERENCE_COMMENT_PREFIX}WW-PAY-ROOM1-0002`
        )

    ]).records);

    const distinct = distinctAdapter.observeIncomingTransactions();

    check(
        distinct.observed.length === 2
            && distinct.observed[0].paymentReference === FIXTURE_PAYMENT_REFERENCE
            && distinct.observed[1].paymentReference === "WW-PAY-ROOM1-0002",
        "two different references must be two different observations"
    );

    // Replay protection is unchanged: an identical repeat is idempotent.
    const replayAdapter = buildMappedAdapter(referenceA);

    const first = replayAdapter.observeIncomingTransactions();

    const second = replayAdapter.observeIncomingTransactions();

    check(
        first.observed.length === 1
            && second.observed.length === 0
            && second.replays.length === 1
            && replayAdapter.observedTransactionCount === 1,
        "an exact replay of the same transaction and comment must stay idempotent"
    );

    check(
        second.replays[0].transactionId === first.observed[0].transactionId,
        "a replay must keep the same derived transaction identity"
    );

    // The same transaction identity with a different comment is a contradiction.
    const contradictionAdapter = new IncomingTransferAdapter({
        providerClient: scriptedMappedRecordsClient([

            mapTransactions([transactionWithComment(FIXTURE_TX_HASH, FIXTURE_PAYMENT_COMMENT)]).records,

            mapTransactions([
                transactionWithComment(
                    FIXTURE_TX_HASH,
                    `${PAYMENT_REFERENCE_COMMENT_PREFIX}WW-PAY-ROOM1-0002`
                )
            ]).records

        ]),
        network: "testnet",
        providerId: "toncenter",
        nowProvider: () => FIXTURE_NOW_MS + 60_000
    });

    contradictionAdapter.observeIncomingTransactions();

    const conflict = expectThrow(
        () => contradictionAdapter.observeIncomingTransactions(),
        "ObservationConflictError",
        "the same transaction with a different reference must be a contradiction"
    );

    check(
        conflict.code === "TRANSACTION_OBSERVATION_CONFLICT"
            && contradictionAdapter.observedTransactionCount === 1,
        "a contradictory observation must not enter the ledger"
    );

    // A comment that loses its envelope changes the observation content: the
    // same transaction can never be re-read as a reference-less transfer.
    const downgradedAdapter = new IncomingTransferAdapter({
        providerClient: scriptedMappedRecordsClient([

            mapTransactions([transactionWithComment(FIXTURE_TX_HASH, FIXTURE_PAYMENT_COMMENT)]).records,

            mapTransactions([transactionWithComment(FIXTURE_TX_HASH, FIXTURE_PAYMENT_REFERENCE)]).records

        ]),
        network: "testnet",
        providerId: "toncenter",
        nowProvider: () => FIXTURE_NOW_MS + 60_000
    });

    downgradedAdapter.observeIncomingTransactions();

    const downgraded = expectThrow(
        () => downgradedAdapter.observeIncomingTransactions(),
        "ObservationConflictError",
        "dropping the WW1: envelope must change the observation, not hide it"
    );

    check(
        downgraded.code === "TRANSACTION_OBSERVATION_CONFLICT"
            && downgraded.details.paymentReference === null
            && downgradedAdapter.observedTransactionCount === 1,
        "a comment that stops carrying the envelope must never become a silent no-reference"
    );

    console.log("[10d] exact match, collision and replay: PASS");

}

// 10e. No logging, no execution, no confirmation.
{

    // Neither the codec nor the mapper may perform any I/O.
    const originalFetch = globalThis.fetch;

    globalThis.fetch = () => {

        throw new Error("network access attempted by the payment reference codec");

    };

    let mappedCount = 0;

    try {

        mappedCount = mapToncenterTransactionsResponse(
            toncenterResponse([toncenterTransaction()]),
            {
                walletAddress: FRIENDLY_WALLET,
                floorMs: FIXTURE_FLOOR_MS,
                ceilingMs: FIXTURE_CEILING_MS,
                limit: 10
            }
        ).records.length;

        extractPaymentReference(FIXTURE_PAYMENT_COMMENT);
        extractPaymentReference("WW1:not a reference");
        inspectPaymentReferenceComment("WW1:not a reference");

    } finally {

        globalThis.fetch = originalFetch;

    }

    check(mappedCount === 1, "the mapper must keep working without any network access");

    // No comment may ever be logged, and no rejected value may be echoed.
    const consoleMethods = ["log", "info", "warn", "error", "debug", "trace"];

    const originalConsole = {};

    const logged = [];

    for (const method of consoleMethods) {

        originalConsole[method] = console[method];

        console[method] = (...args) => {

            logged.push({ method, args });

        };

    }

    let formatError = null;

    try {

        mapToncenterTransactionsResponse(
            toncenterResponse([toncenterTransaction()]),
            {
                walletAddress: FRIENDLY_WALLET,
                floorMs: FIXTURE_FLOOR_MS,
                ceilingMs: FIXTURE_CEILING_MS,
                limit: 10
            }
        );

        extractPaymentReference("WW1:private note that must never be logged");
        inspectPaymentReferenceComment("WW1:private note that must never be logged");
        formatPaymentReference("private note that must never be logged");

    } catch (error) {

        formatError = error;

    } finally {

        for (const method of consoleMethods) {

            console[method] = originalConsole[method];

        }

    }

    check(logged.length === 0, "the codec and mapper must never log a comment");
    check(formatError instanceof PaymentReferenceFormatError, "an invalid reference must be refused");

    check(
        !JSON.stringify(formatError.toJSON()).includes("private note"),
        "a rejection must never echo the rejected comment"
    );

    check(
        !JSON.stringify(inspectPaymentReferenceComment("WW1:private note that must never be logged"))
            .includes("private note"),
        "the classifier must never echo the comment text"
    );

    // No intent is mutated and no transaction is executed by the codec path.
    const harness = buildHarness({
        fetch: { payload: toncenterResponse([toncenterTransaction()]) }
    });

    const intent = buildIntent();

    const before = intent.toRecord();

    const result = await runWithVirtualClock(harness.clock, () => checkRoom(harness.service, {
        paymentIntents: [intent]
    }));

    check(
        result.observations[0].status === "matched",
        "the observation must still be evaluated"
    );

    check(
        intent.state === "PENDING"
            && intent.transactionId === null
            && Object.isFrozen(intent)
            && JSON.stringify(intent.toRecord()) === JSON.stringify(before),
        "observing a WW1: payment must never mutate the payment intent"
    );

    check(
        isPaymentConfirmationDisposition(result.disposition) === false
            && result.observations.every((observation) => observation.paymentConfirmed === false),
        "no observation may ever report a confirmed payment"
    );

    assertNoOperations(
        harness.service,
        INCOMING_TRANSFER_ADAPTER_FORBIDDEN_OPERATIONS
    );

    checksPassed += 1;

    for (const operation of INCOMING_TRANSFER_ADAPTER_FORBIDDEN_OPERATIONS) {

        check(
            typeof harness.provider[operation] !== "function",
            `the provider must not expose ${operation}`
        );

    }

    console.log("[10e] no logging, no execution, no confirmation: PASS");

}

console.log(
    `\nIsolated Toncenter provider tests passed | assertions=${checksPassed}`
        + ` | endpoint=https://testnet.toncenter.com/api/v3/transactions`
        + ` | defaultRate=8rps`
        + ` | freePlanCeiling=10rps`
        + ` | planVerified=false`
        + ` | commentFormat=WW1:<paymentReference>`
        + ` | sendEnabled=false`
        + ` | confirmationEnabled=false`
);

export { checksPassed };
