/**
 * Phase 3 — Toncenter Testnet read-only provider: error hierarchy.
 *
 * Every error extends the Phase 2 `IncomingTransferError` (itself a Phase 1
 * `PaymentError`), so the whole payment layer shares one error contract:
 * `name`, `code`, `details`, `toJSON`.
 *
 * Errors never contain the API key value: authentication failures carry the
 * HTTP status only.
 */

import { IncomingTransferError } from "../incoming/IncomingTransferErrors.js";

/** Base class for every Toncenter provider error. */
export class ToncenterError extends IncomingTransferError {

    constructor(message, details) {

        super(message, details);

        this.code = "TONCENTER_ERROR";

    }

}

/**
 * The API key is absent from the runtime environment. No request is sent in
 * this state — an unauthenticated request is never substituted.
 */
export class ToncenterApiKeyMissingError extends ToncenterError {

    constructor(environmentVariable, details) {

        super(
            `Toncenter API key is missing: set the existing runtime environment`
                + ` variable ${environmentVariable}`,
            { environmentVariable, ...details }
        );

        this.code = "TONCENTER_API_KEY_MISSING";

    }

}

/** The provider rejected the API key (HTTP 401) or forbade the request (403). */
export class ToncenterAuthenticationError extends ToncenterError {

    constructor(statusCode, details) {

        super(
            `Toncenter rejected the API key or request (HTTP ${statusCode})`,
            { statusCode, ...details }
        );

        this.code = "TONCENTER_AUTH_REJECTED";

    }

}

/**
 * HTTP 429 after the transaction client's bounded Retry-After/backoff budget.
 * No background polling is started.
 */
export class ToncenterRateLimitError extends ToncenterError {

    constructor(statusCode, details) {

        super(
            `Toncenter rate limit reached (HTTP ${statusCode}) after bounded retries`,
            { statusCode, ...details }
        );

        this.code = "TONCENTER_RATE_LIMITED";

    }

}

/** Provider-side failure (HTTP 5xx). */
export class ToncenterServiceError extends ToncenterError {

    constructor(statusCode, details) {

        super(
            `Toncenter service error (HTTP ${statusCode})`,
            { statusCode, ...details }
        );

        this.code = "TONCENTER_SERVICE_ERROR";

    }

}

/**
 * The request failed before a usable response: other 4xx statuses, network
 * failures, aborts and timeouts.
 */
export class ToncenterRequestError extends ToncenterError {

    constructor(message, details) {

        super(message, details);

        this.code = "TONCENTER_REQUEST_FAILED";

    }

}

/**
 * The provider replied 200 with a body that does not satisfy the documented
 * response contract (invalid JSON, wrong envelope shape, unusable
 * transaction identity fields).
 */
export class ToncenterResponseError extends ToncenterError {

    constructor(message, details) {

        super(message, details);

        this.code = "TONCENTER_RESPONSE_MALFORMED";

    }

}
